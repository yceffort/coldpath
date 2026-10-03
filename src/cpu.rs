//! Per-source CPU self time from `coldpath profile` files, kept apart from byte metrics.
//! A value is a distribution over runs reported with its sample counts, never one run's number.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::attribution::{self, IndexedSegment, IndexedSource};
use crate::text::TextIndex;

/// Below this median of self samples per run, a value is `insufficient` (issue #24).
pub const MIN_SAMPLES: f64 = 10.0;

const WINDOWS: [&str; 2] = ["load", "action"];
const EXCLUDED: &str = "(excluded bundles)";
const METHOD: &str = "Sampled self time: each sample lasts until the next sample of its window. Functions are attributed by their start position through the source map; code a minifier inlined counts toward the containing function. Script top levels and samples outside analyzed bundle functions are reported separately. Quartiles interpolate linearly between runs.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileFile {
    schema_version: u32,
    scenario: String,
    runs: usize,
    sampling_interval_us: f64,
    #[serde(default)]
    environment: serde_json::Value,
    windows: BTreeMap<String, WindowFile>,
    scripts: Vec<ScriptFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowFile {
    duration_us: Vec<f64>,
    samples: Vec<u64>,
    buckets: BTreeMap<String, Cell>,
}

/// Self samples and microseconds of one row in one window, per run.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cell {
    samples: Vec<u64>,
    self_us: Vec<f64>,
}

impl Cell {
    fn zero(runs: usize) -> Self {
        Self {
            samples: vec![0; runs],
            self_us: vec![0.0; runs],
        }
    }

    fn add(&mut self, other: &Self) {
        for (total, count) in self.samples.iter_mut().zip(&other.samples) {
            *total += count;
        }
        for (total, us) in self.self_us.iter_mut().zip(&other.self_us) {
            *total += us;
        }
    }

    fn sampled(&self) -> bool {
        self.samples.iter().any(|count| *count > 0)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptFile {
    path: String,
    sha256: String,
    source_map_sha256: Option<String>,
    top_level: BTreeMap<String, Cell>,
    functions: Vec<FunctionFile>,
}

#[derive(Deserialize)]
struct FunctionFile {
    /// UTF-16 offset of the function's start position as V8 reports it.
    offset: usize,
    windows: BTreeMap<String, Cell>,
}

struct Window {
    name: String,
    duration_us: Vec<f64>,
    samples: Vec<u64>,
    buckets: BTreeMap<String, Cell>,
    sources: BTreeMap<String, Cell>,
    top_level: BTreeMap<String, Cell>,
}

struct Scenario {
    name: String,
    runs: usize,
    sampling_interval_us: f64,
    environment: serde_json::Value,
    windows: Vec<Window>,
    /// Scripts not yet bound to an analyzed or excluded bundle.
    scripts: BTreeMap<String, ScriptFile>,
    bundles: BTreeSet<String>,
}

/// Profiles waiting to be bound to the analyzed bundles.
pub(crate) struct Profiles {
    scenarios: Vec<Scenario>,
}

fn validate(file: ProfileFile) -> Result<Scenario> {
    ensure!(
        file.schema_version == 1,
        "unsupported profile schema version"
    );
    ensure!(
        !file.scenario.trim().is_empty(),
        "profile scenario cannot be empty"
    );
    let runs = file.runs;
    ensure!(runs >= 2, "a profile needs at least 2 runs");
    ensure!(
        file.sampling_interval_us.is_finite() && file.sampling_interval_us > 0.0,
        "invalid profile sampling interval"
    );
    let names = WINDOWS
        .into_iter()
        .filter(|name| file.windows.contains_key(*name))
        .collect::<Vec<_>>();
    ensure!(
        names.first() == Some(&"load") && names.len() == file.windows.len(),
        "profile windows must be load and optionally action"
    );
    let per_run = |what: &str, values: usize| -> Result<()> {
        ensure!(values == runs, "{what} must have one value per run");
        Ok(())
    };
    let check_cell = |what: &str, cell: &Cell| -> Result<()> {
        per_run(what, cell.samples.len())?;
        per_run(what, cell.self_us.len())?;
        ensure!(
            cell.self_us
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0),
            "{what} self time must be nonnegative"
        );
        Ok(())
    };
    let keys_match = |what: &str, map: &BTreeMap<String, Cell>| -> Result<()> {
        ensure!(
            map.len() == names.len() && names.iter().all(|name| map.contains_key(*name)),
            "{what} must list the profile windows"
        );
        for cell in map.values() {
            check_cell(what, cell)?;
        }
        Ok(())
    };
    // Every sample of a window is a bucket, a script's top level, or one function.
    let mut totals = BTreeMap::new();
    for (name, window) in &file.windows {
        per_run("window durationUs", window.duration_us.len())?;
        per_run("window samples", window.samples.len())?;
        ensure!(
            window
                .duration_us
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0),
            "window durations must be nonnegative"
        );
        let mut total = vec![0u64; runs];
        for (bucket, cell) in &window.buckets {
            ensure!(!bucket.is_empty(), "empty bucket name");
            check_cell("bucket", cell)?;
            add_checked(&mut total, &cell.samples)?;
        }
        totals.insert(name.as_str(), total);
    }
    let mut scripts = BTreeMap::new();
    for script in &file.scripts {
        crate::coverage::validate_path(&script.path)?;
        keys_match("script topLevel", &script.top_level)?;
        for (name, cell) in &script.top_level {
            add_checked(totals.get_mut(name.as_str()).unwrap(), &cell.samples)?;
        }
        let mut offsets = BTreeSet::new();
        for function in &script.functions {
            ensure!(
                offsets.insert(function.offset),
                "{}: duplicate profile function offset {}",
                script.path,
                function.offset
            );
            keys_match("function windows", &function.windows)?;
            for (name, cell) in &function.windows {
                add_checked(totals.get_mut(name.as_str()).unwrap(), &cell.samples)?;
            }
        }
    }
    for (name, window) in &file.windows {
        ensure!(
            totals[name.as_str()] == window.samples,
            "{name} window: self samples do not add up to the window's total samples"
        );
    }
    for script in file.scripts {
        let path = script.path.clone();
        ensure!(
            scripts.insert(path.clone(), script).is_none(),
            "duplicate profile script {path}"
        );
    }
    let mut windows = file.windows;
    Ok(Scenario {
        name: file.scenario,
        runs,
        sampling_interval_us: file.sampling_interval_us,
        environment: file.environment,
        windows: names
            .into_iter()
            .map(|name| {
                let window = windows.remove(name).unwrap();
                Window {
                    name: name.into(),
                    duration_us: window.duration_us,
                    samples: window.samples,
                    buckets: window.buckets,
                    sources: BTreeMap::new(),
                    top_level: BTreeMap::new(),
                }
            })
            .collect(),
        scripts,
        bundles: BTreeSet::new(),
    })
}

fn add_checked(total: &mut [u64], counts: &[u64]) -> Result<()> {
    for (total, count) in total.iter_mut().zip(counts) {
        *total = total
            .checked_add(*count)
            .context("profile sample counts overflow")?;
    }
    Ok(())
}

impl Profiles {
    pub fn load(paths: &[PathBuf]) -> Result<Self> {
        let mut scenarios: Vec<Scenario> = Vec::new();
        for path in paths {
            let file: ProfileFile = serde_json::from_slice(
                &fs::read(path).with_context(|| format!("read profile {}", path.display()))?,
            )
            .with_context(|| format!("invalid coldpath profile {}", path.display()))?;
            let scenario = validate(file)
                .with_context(|| format!("invalid coldpath profile {}", path.display()))?;
            ensure!(
                !scenarios.iter().any(|s| s.name == scenario.name),
                "duplicate profile scenario {:?}",
                scenario.name
            );
            scenarios.push(scenario);
        }
        Ok(Self { scenarios })
    }

    /// Binds every profile of `path` to the analyzed bundle: hashes must match, and each
    /// function's samples go to the source that owns the byte at its start position.
    pub fn bind(
        &mut self,
        path: &str,
        hash: &str,
        map_hash: &Option<String>,
        text: &TextIndex,
        segments: &[IndexedSegment],
        sources: &[IndexedSource],
    ) -> Result<()> {
        for scenario in &mut self.scenarios {
            let Some(script) = scenario.scripts.remove(path) else {
                continue;
            };
            ensure!(
                script.sha256 == hash,
                "{path}: profile SHA-256 mismatch in scenario {:?}; profile this exact build",
                scenario.name
            );
            ensure!(
                script.source_map_sha256 == *map_hash,
                "{path}: profile source-map SHA-256 mismatch (or missing binding) in scenario {:?}; profile with this exact map",
                scenario.name
            );
            let runs = scenario.runs;
            for window in &mut scenario.windows {
                window
                    .top_level
                    .entry(path.into())
                    .or_insert_with(|| Cell::zero(runs))
                    .add(&script.top_level[&window.name]);
            }
            for function in &script.functions {
                let byte = text.byte(function.offset).with_context(|| {
                    format!("{path}: profile function offset {}", function.offset)
                })?;
                let index = segments.partition_point(|segment| segment.end <= byte);
                ensure!(
                    index < segments.len(),
                    "{path}: profile function offset {} is outside the script",
                    function.offset
                );
                let source = &sources[segments[index].source].name;
                for window in &mut scenario.windows {
                    window
                        .sources
                        .entry(source.clone())
                        .or_insert_with(|| Cell::zero(runs))
                        .add(&function.windows[&window.name]);
                }
            }
            scenario.bundles.insert(path.into());
        }
        Ok(())
    }

    /// Moves the samples of a bundle left out of the analysis to a separate bucket.
    pub fn exclude(&mut self, path: &str) {
        for scenario in &mut self.scenarios {
            let Some(script) = scenario.scripts.remove(path) else {
                continue;
            };
            let runs = scenario.runs;
            for window in &mut scenario.windows {
                let bucket = window
                    .buckets
                    .entry(EXCLUDED.into())
                    .or_insert_with(|| Cell::zero(runs));
                bucket.add(&script.top_level[&window.name]);
                for function in &script.functions {
                    bucket.add(&function.windows[&window.name]);
                }
            }
        }
    }

    /// Profile scripts not yet bound or excluded.
    pub fn pending(&self) -> BTreeSet<String> {
        self.scenarios
            .iter()
            .flat_map(|scenario| scenario.scripts.keys().cloned())
            .collect()
    }

    pub fn finish(self) -> Result<Option<CpuReport>> {
        if self.scenarios.is_empty() {
            return Ok(None);
        }
        let mut scenarios = Vec::new();
        for scenario in self.scenarios {
            ensure!(scenario.scripts.is_empty(), "profile scripts left unbound");
            let mut windows = Vec::new();
            for window in scenario.windows {
                let runs = scenario.runs;
                let mut total = Cell::zero(runs);
                let mut packages: BTreeMap<String, Cell> = BTreeMap::new();
                let mut sources = Vec::new();
                for (source, cell) in window.sources.into_iter().filter(|(_, c)| c.sampled()) {
                    total.add(&cell);
                    let package = attribution::package(&source);
                    packages
                        .entry(package.clone())
                        .or_insert_with(|| Cell::zero(runs))
                        .add(&cell);
                    sources.push(CpuSource {
                        source,
                        package,
                        cost: Cost::new(cell),
                    });
                }
                let mut top_level = Vec::new();
                for (path, cell) in window.top_level.into_iter().filter(|(_, c)| c.sampled()) {
                    total.add(&cell);
                    top_level.push(CpuTopLevel {
                        path,
                        cost: Cost::new(cell),
                    });
                }
                let mut other = Vec::new();
                for (name, cell) in window.buckets.into_iter().filter(|(_, c)| c.sampled()) {
                    total.add(&cell);
                    other.push(CpuBucket {
                        name,
                        cost: Cost::new(cell),
                    });
                }
                ensure!(
                    total.samples == window.samples,
                    "{} window of {:?}: profile attribution lost samples",
                    window.name,
                    scenario.name
                );
                let mut packages = packages
                    .into_iter()
                    .map(|(package, cell)| CpuPackage {
                        package,
                        cost: Cost::new(cell),
                    })
                    .collect::<Vec<_>>();
                sources.sort_by(|a, b| a.cost.order(&b.cost).then(a.source.cmp(&b.source)));
                packages.sort_by(|a, b| a.cost.order(&b.cost).then(a.package.cmp(&b.package)));
                top_level.sort_by(|a, b| a.cost.order(&b.cost).then(a.path.cmp(&b.path)));
                other.sort_by(|a, b| a.cost.order(&b.cost).then(a.name.cmp(&b.name)));
                windows.push(CpuWindow {
                    median_duration_us: round(quantile(&window.duration_us, 0.5)),
                    window: window.name,
                    duration_us: window.duration_us,
                    samples: window.samples,
                    sources,
                    packages,
                    top_level,
                    other,
                });
            }
            scenarios.push(CpuScenario {
                scenario: scenario.name,
                runs: scenario.runs,
                sampling_interval_us: scenario.sampling_interval_us,
                environment: scenario.environment,
                bundles: scenario.bundles.into_iter().collect(),
                windows,
            });
        }
        Ok(Some(CpuReport {
            method: METHOD.into(),
            min_samples: MIN_SAMPLES,
            scenarios,
        }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CpuStatus {
    Measured,
    /// Below the sample threshold: not a reliable value, and never evidence of low cost.
    Insufficient,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuReport {
    pub method: String,
    pub min_samples: f64,
    pub scenarios: Vec<CpuScenario>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuScenario {
    pub scenario: String,
    pub runs: usize,
    pub sampling_interval_us: f64,
    pub environment: serde_json::Value,
    /// Analyzed bundles these runs loaded. Their sources without a row in a window were not sampled there.
    pub bundles: Vec<String>,
    pub windows: Vec<CpuWindow>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuWindow {
    pub window: String,
    pub duration_us: Vec<f64>,
    pub median_duration_us: f64,
    /// Total samples per run, including idle time.
    pub samples: Vec<u64>,
    pub sources: Vec<CpuSource>,
    pub packages: Vec<CpuPackage>,
    /// Each bundle's top-level code: module evaluation that no single source owns.
    pub top_level: Vec<CpuTopLevel>,
    /// `(program)`, `(garbage collector)`, `(idle)`, `(native)`, `(other scripts)`, `(excluded bundles)`.
    pub other: Vec<CpuBucket>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuSource {
    pub source: String,
    pub package: String,
    #[serde(flatten)]
    pub cost: Cost,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuPackage {
    pub package: String,
    #[serde(flatten)]
    pub cost: Cost,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuTopLevel {
    pub path: String,
    #[serde(flatten)]
    pub cost: Cost,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuBucket {
    pub name: String,
    #[serde(flatten)]
    pub cost: Cost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub status: CpuStatus,
    /// Self samples per run.
    pub samples: Vec<u64>,
    pub median_samples: f64,
    /// Self time per run in microseconds.
    pub self_us: Vec<f64>,
    pub median_us: f64,
    pub q1_us: f64,
    pub q3_us: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummary {
    pub status: CpuStatus,
    pub median_samples: f64,
    pub median_us: f64,
    pub q1_us: f64,
    pub q3_us: f64,
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Linear interpolation between order statistics (R type 7). `values` must not be empty.
fn quantile(values: &[f64], p: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let h = (sorted.len() - 1) as f64 * p;
    let low = h.floor() as usize;
    let high = (low + 1).min(sorted.len() - 1);
    sorted[low] + (h - low as f64) * (sorted[high] - sorted[low])
}

/// Statistics of per-run values. Both slices must hold at least one run.
fn summarize(samples: &[u64], self_us: &[f64]) -> CostSummary {
    let median_samples = quantile(
        &samples
            .iter()
            .map(|count| *count as f64)
            .collect::<Vec<_>>(),
        0.5,
    );
    CostSummary {
        status: if median_samples >= MIN_SAMPLES {
            CpuStatus::Measured
        } else {
            CpuStatus::Insufficient
        },
        median_samples,
        median_us: round(quantile(self_us, 0.5)),
        q1_us: round(quantile(self_us, 0.25)),
        q3_us: round(quantile(self_us, 0.75)),
    }
}

impl Cost {
    fn new(cell: Cell) -> Self {
        let Cell { samples, self_us } = cell;
        let self_us = self_us.into_iter().map(round).collect::<Vec<_>>();
        let summary = summarize(&samples, &self_us);
        Self {
            status: summary.status,
            median_samples: summary.median_samples,
            median_us: summary.median_us,
            q1_us: summary.q1_us,
            q3_us: summary.q3_us,
            samples,
            self_us,
        }
    }

    /// Largest median first, then most samples.
    fn order(&self, other: &Self) -> std::cmp::Ordering {
        other.median_us.total_cmp(&self.median_us).then_with(|| {
            other
                .samples
                .iter()
                .sum::<u64>()
                .cmp(&self.samples.iter().sum::<u64>())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_interpolate_between_runs() {
        assert_eq!(quantile(&[4.0, 1.0, 3.0, 2.0], 0.5), 2.5);
        assert_eq!(quantile(&[4.0, 1.0, 3.0, 2.0], 0.25), 1.75);
        assert_eq!(quantile(&[7.0], 0.75), 7.0);
    }
}
