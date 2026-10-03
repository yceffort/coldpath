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
/// Smallest Hodges-Lehmann shift, relative to the baseline median, reported as a change (issue #24).
pub const MIN_EFFECT: f64 = 0.25;
/// Family-wise error rate of the Holm-adjusted comparisons.
pub const ALPHA: f64 = 0.05;

const WINDOWS: [&str; 2] = ["load", "action"];
const EXCLUDED: &str = "(excluded bundles)";
const METHOD: &str = "Sampled self time: each sample lasts until the next sample of its window. Functions are attributed by their start position through the source map; code a minifier inlined counts toward the containing function. Script top levels and samples outside analyzed bundle functions are reported separately. Quartiles interpolate linearly between runs.";
const COMPARISON: &str = "Per source and window: two-sided Mann-Whitney U test on per-run self time (exact without ties, otherwise normal approximation with tie and continuity corrections), Holm-adjusted across all compared rows, and the Hodges-Lehmann shift. A change needs an adjusted p-value below alpha and a shift of at least minEffect of the baseline median. Rows insufficient or missing in either report, and scenarios whose profile environment or sampling interval differs, are inconclusive.";

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

    /// Recomputed from the per-run values: a baseline file's summary fields are not trusted.
    fn summary(&self) -> CostSummary {
        summarize(&self.samples, &self.self_us)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuComparison {
    pub method: &'static str,
    pub alpha: f64,
    pub min_effect: f64,
    /// Rows with sufficient samples in both reports, the size of the Holm family.
    pub compared: usize,
    pub sources: Vec<CpuChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuChange {
    pub scenario: String,
    pub window: String,
    pub source: String,
    pub package: String,
    /// `regressed`, `improved`, `unchanged` (shift below the minimum effect), or `inconclusive`.
    pub change: &'static str,
    /// Absent when the report has no row: the source was not sampled or not profiled.
    pub before: Option<CostSummary>,
    pub after: Option<CostSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_us: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_shift: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjusted_p_value: Option<f64>,
}

fn validate_report(report: &CpuReport) -> Result<()> {
    for scenario in &report.scenarios {
        ensure!(
            scenario.runs >= 2,
            "invalid baseline CPU data for scenario {:?}",
            scenario.scenario
        );
        for window in &scenario.windows {
            for cost in window.sources.iter().map(|row| &row.cost) {
                ensure!(
                    cost.self_us.len() == scenario.runs
                        && cost.samples.len() == scenario.runs
                        && cost.self_us.iter().all(|value| value.is_finite()),
                    "invalid baseline CPU data for scenario {:?}",
                    scenario.scenario
                );
            }
        }
    }
    Ok(())
}

/// Compares per-run self time of each source and window present in either report.
pub fn compare(
    before: &CpuReport,
    after: &CpuReport,
    warnings: &mut Vec<String>,
) -> Result<CpuComparison> {
    validate_report(before)?;
    let mut rows = Vec::new();
    let mut tested = Vec::new();
    for scenario in &after.scenarios {
        let Some(base) = before
            .scenarios
            .iter()
            .find(|s| s.scenario == scenario.scenario)
        else {
            warnings.push(format!(
                "CPU scenario {:?} has no baseline profile and is not compared.",
                scenario.scenario
            ));
            continue;
        };
        // Two machines, or two boots of one, measured the same build 20 to 30% apart (issue #24).
        let mut differences = Vec::new();
        if base.sampling_interval_us != scenario.sampling_interval_us {
            differences.push("samplingIntervalUs".to_owned());
        }
        let empty = serde_json::Map::new();
        let (a, b) = (
            base.environment.as_object().unwrap_or(&empty),
            scenario.environment.as_object().unwrap_or(&empty),
        );
        differences.extend(
            a.keys()
                .chain(b.keys())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .filter(|key| a.get(*key) != b.get(*key))
                .cloned(),
        );
        if base.environment != scenario.environment && differences.is_empty() {
            differences.push("environment".into());
        }
        let comparable = differences.is_empty();
        if !comparable {
            warnings.push(format!("CPU scenario {:?}: the profile differs from the baseline in {}; its sources are inconclusive. Profile both builds on one machine in one session.", scenario.scenario, differences.join(", ")));
        }
        for window in &scenario.windows {
            let Some(base_window) = base.windows.iter().find(|w| w.window == window.window) else {
                warnings.push(format!(
                    "CPU scenario {:?} has no baseline {} window.",
                    scenario.scenario, window.window
                ));
                continue;
            };
            let names = base_window
                .sources
                .iter()
                .chain(&window.sources)
                .map(|row| row.source.as_str())
                .collect::<BTreeSet<_>>();
            for name in names {
                let (a, b) = (
                    find(&base_window.sources, name),
                    find(&window.sources, name),
                );
                let mut row = CpuChange {
                    scenario: scenario.scenario.clone(),
                    window: window.window.clone(),
                    source: name.into(),
                    package: b.or(a).unwrap().package.clone(),
                    change: "inconclusive",
                    before: a.map(|row| row.cost.summary()),
                    after: b.map(|row| row.cost.summary()),
                    shift_us: None,
                    relative_shift: None,
                    p_value: None,
                    adjusted_p_value: None,
                };
                let measured = |summary: &Option<CostSummary>| {
                    summary
                        .as_ref()
                        .is_some_and(|s| s.status == CpuStatus::Measured && s.median_us > 0.0)
                };
                if let (true, Some(a), Some(b)) = (comparable, a, b)
                    && measured(&row.before)
                    && measured(&row.after)
                {
                    let shift = hodges_lehmann(&a.cost.self_us, &b.cost.self_us);
                    row.shift_us = Some(round(shift));
                    row.relative_shift = Some(shift / row.before.as_ref().unwrap().median_us);
                    row.p_value = Some(mann_whitney(&a.cost.self_us, &b.cost.self_us));
                    tested.push(rows.len());
                }
                rows.push(row);
            }
        }
    }
    for base in &before.scenarios {
        if !after.scenarios.iter().any(|s| s.scenario == base.scenario) {
            warnings.push(format!(
                "Baseline CPU scenario {:?} has no current profile and is not compared.",
                base.scenario
            ));
        }
    }
    let adjusted = holm(
        &tested
            .iter()
            .map(|&index| rows[index].p_value.unwrap())
            .collect::<Vec<_>>(),
    );
    for (&index, adjusted) in tested.iter().zip(adjusted) {
        let row = &mut rows[index];
        let shift = row.relative_shift.unwrap();
        row.adjusted_p_value = Some(adjusted);
        row.change = if shift.abs() < MIN_EFFECT {
            "unchanged"
        } else if adjusted < ALPHA {
            if shift > 0.0 { "regressed" } else { "improved" }
        } else {
            "inconclusive"
        };
    }
    let rank = |change: &str| match change {
        "regressed" => 0,
        "improved" => 1,
        "inconclusive" => 2,
        _ => 3,
    };
    rows.sort_by(|a, b| {
        rank(a.change)
            .cmp(&rank(b.change))
            .then(
                b.shift_us
                    .unwrap_or(0.0)
                    .abs()
                    .total_cmp(&a.shift_us.unwrap_or(0.0).abs()),
            )
            .then_with(|| a.scenario.cmp(&b.scenario))
            .then_with(|| a.window.cmp(&b.window))
            .then_with(|| a.source.cmp(&b.source))
    });
    Ok(CpuComparison {
        method: COMPARISON,
        alpha: ALPHA,
        min_effect: MIN_EFFECT,
        compared: tested.len(),
        sources: rows,
    })
}

fn find<'a>(rows: &'a [CpuSource], name: &str) -> Option<&'a CpuSource> {
    rows.iter().find(|row| row.source == name)
}

/// Median of all pairwise differences `after - before`.
fn hodges_lehmann(before: &[f64], after: &[f64]) -> f64 {
    let differences = after
        .iter()
        .flat_map(|b| before.iter().map(move |a| b - a))
        .collect::<Vec<_>>();
    quantile(&differences, 0.5)
}

/// Two-sided p-value: exact without ties, otherwise the normal approximation with tie and
/// continuity corrections.
fn mann_whitney(a: &[f64], b: &[f64]) -> f64 {
    let (n1, n2) = (a.len(), b.len());
    let mut values = a
        .iter()
        .map(|value| (*value, true))
        .chain(b.iter().map(|value| (*value, false)))
        .collect::<Vec<_>>();
    values.sort_by(|x, y| x.0.total_cmp(&y.0));
    let (mut rank_sum, mut ties) = (0.0, 0.0);
    let mut i = 0;
    while i < values.len() {
        let mut j = i;
        while j + 1 < values.len() && values[j + 1].0 == values[i].0 {
            j += 1;
        }
        let rank = (i + j) as f64 / 2.0 + 1.0;
        rank_sum += rank * values[i..=j].iter().filter(|value| value.1).count() as f64;
        let size = (j - i + 1) as f64;
        ties += size * size * size - size;
        i = j + 1;
    }
    let u = rank_sum - (n1 * (n1 + 1)) as f64 / 2.0;
    if ties == 0.0 && n1 + n2 <= 60 {
        let probabilities = u_distribution(n1, n2);
        let u = u.round() as usize;
        let lower = probabilities[..=u].iter().sum::<f64>();
        let upper = probabilities[u..].iter().sum::<f64>();
        return (2.0 * lower.min(upper)).min(1.0);
    }
    let (n1, n2) = (n1 as f64, n2 as f64);
    let n = n1 + n2;
    let variance = n1 * n2 / 12.0 * ((n + 1.0) - ties / (n * (n - 1.0)));
    if variance <= 0.0 {
        return 1.0;
    }
    let z = (((u - n1 * n2 / 2.0).abs() - 0.5).max(0.0)) / variance.sqrt();
    erfc(z / std::f64::consts::SQRT_2).min(1.0)
}

/// Null distribution of U for sample sizes without ties: P(U = u) for u in 0..=n1*n2.
fn u_distribution(n1: usize, n2: usize) -> Vec<f64> {
    // table[i][j] is the distribution for sizes (i, j); the largest value is from the first
    // sample with probability i / (i + j) and then adds j to U.
    let mut table: Vec<Vec<Vec<f64>>> = vec![vec![Vec::new(); n2 + 1]; n1 + 1];
    for i in 0..=n1 {
        for j in 0..=n2 {
            table[i][j] = if i == 0 || j == 0 {
                vec![1.0]
            } else {
                let (p, q) = (i as f64 / (i + j) as f64, j as f64 / (i + j) as f64);
                let mut distribution = vec![0.0; i * j + 1];
                for (u, value) in table[i - 1][j].iter().enumerate() {
                    distribution[u + j] += p * value;
                }
                for (u, value) in table[i][j - 1].iter().enumerate() {
                    distribution[u] += q * value;
                }
                distribution
            };
        }
    }
    std::mem::take(&mut table[n1][n2])
}

/// Complementary error function with fractional error below 1.2e-7 (Numerical Recipes `erfcc`).
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let polynomial = -z * z - 1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let value = t * polynomial.exp();
    if x >= 0.0 { value } else { 2.0 - value }
}

/// Holm step-down adjusted p-values, in input order.
fn holm(p: &[f64]) -> Vec<f64> {
    let mut order = (0..p.len()).collect::<Vec<_>>();
    order.sort_by(|&i, &j| p[i].total_cmp(&p[j]));
    let mut adjusted = vec![0.0; p.len()];
    let mut running: f64 = 0.0;
    for (rank, &index) in order.iter().enumerate() {
        running = running.max(((p.len() - rank) as f64 * p[index]).min(1.0));
        adjusted[index] = running;
    }
    adjusted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance * expected.abs().max(1e-300),
            "{actual} != {expected}"
        );
    }

    #[test]
    fn exact_mann_whitney_matches_enumeration() {
        // Complete separation of 3 vs 3: 2 of C(6,3) = 20 arrangements are as extreme.
        close(mann_whitney(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]), 0.1, 1e-12);
        close(mann_whitney(&[4.0, 5.0, 6.0], &[1.0, 2.0, 3.0]), 0.1, 1e-12);
        let a = (0..10).map(f64::from).collect::<Vec<_>>();
        let b = (10..20).map(f64::from).collect::<Vec<_>>();
        close(mann_whitney(&a, &b), 2.0 / 184_756.0, 1e-9);
        // U = 1 for 3 vs 3: P(U <= 1) = 2 / 20, two-sided 0.2.
        close(mann_whitney(&[1.0, 2.0, 4.0], &[3.0, 5.0, 6.0]), 0.2, 1e-12);
        // Identical distributions in the middle of the range.
        assert_eq!(mann_whitney(&[1.0, 4.0], &[2.0, 3.0]), 1.0);
        for (n1, n2) in [(1, 1), (3, 7), (10, 10), (30, 30)] {
            let distribution = u_distribution(n1, n2);
            assert_eq!(distribution.len(), n1 * n2 + 1);
            close(distribution.iter().sum(), 1.0, 1e-12);
            for u in 0..=n1 * n2 {
                close(distribution[u], distribution[n1 * n2 - u], 1e-9);
            }
        }
    }

    #[test]
    fn tied_mann_whitney_uses_corrected_normal_approximation() {
        // scipy.stats.mannwhitneyu(a, b, method="asymptotic", use_continuity=True)
        let a = [1.0, 2.0, 2.0, 3.0, 4.0];
        let b = [2.0, 3.0, 4.0, 4.0, 5.0];
        close(mann_whitney(&a, &b), 0.162_586_850_726_354_93, 1e-6);
        assert_eq!(mann_whitney(&[1.0, 1.0], &[1.0, 1.0]), 1.0);
    }

    #[test]
    fn exact_mann_whitney_matches_scipy() {
        // scipy.stats.mannwhitneyu(a, b, method="exact")
        let cases: [(&[f64], &[f64], f64); 5] = [
            (
                &[137.0, 582.0, 867.0, 821.0, 782.0],
                &[244.0, 452.0, 403.0, 651.0, 1132.0],
                0.690_476_190_476_190_5,
            ),
            (
                &[
                    214.0, 96.0, 499.0, 29.0, 914.0, 855.0, 399.0, 443.0, 622.0, 780.0,
                ],
                &[
                    787.0, 114.0, 677.0, 417.0, 235.0, 1020.0, 1048.0, 188.0, 750.0, 1268.0,
                ],
                0.352_681_374_353_201_07,
            ),
            (
                &[221.0, 992.0, 432.0, 743.0, 29.0, 540.0, 227.0],
                &[
                    880.0, 409.0, 1124.0, 885.0, 800.0, 516.0, 354.0, 281.0, 965.0, 544.0, 1169.0,
                    571.0,
                ],
                0.119_830_118_282_130_67,
            ),
            (
                &[
                    123.0, 760.0, 340.0, 917.0, 738.0, 996.0, 728.0, 512.0, 958.0, 990.0, 432.0,
                    519.0, 849.0, 932.0, 686.0, 194.0, 310.0, 290.0, 601.0, 903.0,
                ],
                &[
                    858.0, 1161.0, 1290.0, 658.0, 396.0, 777.0, 1162.0, 245.0, 496.0, 596.0, 794.0,
                    1032.0, 793.0, 575.0, 819.0, 377.0, 700.0, 526.0, 1093.0, 691.0,
                ],
                0.327_261_835_522_221_43,
            ),
            (
                &[
                    315.0, 720.0, 868.0, 629.0, 607.0, 592.0, 403.0, 662.0, 174.0, 172.0, 514.0,
                    232.0, 12.0, 789.0, 204.0, 552.0, 942.0, 880.0, 561.0, 237.0, 414.0, 526.0,
                    352.0, 975.0, 867.0, 591.0, 361.0, 470.0, 931.0, 275.0,
                ],
                &[
                    883.0, 722.0, 821.0, 1346.0, 878.0, 167.0, 519.0, 752.0, 1102.0, 1066.0,
                    1246.0, 1259.0, 1223.0, 877.0, 708.0, 1085.0, 96.0, 892.0, 863.0, 849.0, 250.0,
                    667.0, 1221.0, 99.0, 882.0, 886.0, 731.0, 815.0, 925.0, 589.0,
                ],
                0.000_648_933_848_129_815_9,
            ),
        ];
        for (a, b, expected) in cases {
            close(mann_whitney(a, b), expected, 1e-9);
        }
    }

    #[test]
    fn erfc_matches_reference_values() {
        close(erfc(0.0), 1.0, 1.2e-7);
        close(erfc(1.0), 0.157_299_207_050_285_1, 1.2e-7);
        close(erfc(3.0), 2.209_049_699_858_544e-5, 1.2e-7);
        close(erfc(-1.0), 1.842_700_792_949_715, 1.2e-7);
    }

    #[test]
    fn quantiles_interpolate_between_runs() {
        assert_eq!(quantile(&[4.0, 1.0, 3.0, 2.0], 0.5), 2.5);
        assert_eq!(quantile(&[4.0, 1.0, 3.0, 2.0], 0.25), 1.75);
        assert_eq!(quantile(&[7.0], 0.75), 7.0);
    }

    #[test]
    fn holm_and_hodges_lehmann() {
        assert_eq!(holm(&[0.01, 0.04, 0.03]), vec![0.03, 0.06, 0.06]);
        assert_eq!(holm(&[]), Vec::<f64>::new());
        assert_eq!(hodges_lehmann(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]), 3.0);
    }
}
