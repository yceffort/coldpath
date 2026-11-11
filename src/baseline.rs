//! Compare report identities, including removed rows and matched scenarios.
use crate::{Counts, Report};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub totals: Change,
    pub sources: Vec<Change>,
    pub packages: Vec<Change>,
    pub bundles: Vec<Change>,
    /// With `--group-by`: the baseline's sources grouped by the same patterns.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<Change>,
    pub scenarios: Vec<ScenarioComparison>,
    /// Present when both reports were given `--initial-html`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_load: Option<InitialLoadChange>,
    pub warnings: Vec<String>,
    /// Present when both reports have CPU profiles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<crate::cpu::CpuComparison>,
}

/// How the bundles an HTML document loads initially changed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialLoadChange {
    pub before_bytes: usize,
    pub after_bytes: usize,
    pub delta_bytes: i128,
    pub added_bundles: Vec<String>,
    pub removed_bundles: Vec<String>,
    /// When either report has several documents: each document both have, matched by `html`,
    /// empty when none matches. The fields above then compare the largest document of each.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<Vec<InitialPageChange>>,
}

#[derive(Debug, Serialize)]
pub struct InitialPageChange {
    pub html: String,
    #[serde(flatten)]
    pub change: InitialLoadChange,
}

impl InitialLoadChange {
    fn new(before: &InitialLoadSnapshot, after: &crate::InitialLoad) -> Self {
        Self {
            before_bytes: before.bytes,
            after_bytes: after.bytes,
            delta_bytes: after.bytes as i128 - before.bytes as i128,
            added_bundles: after
                .bundles
                .iter()
                .filter(|path| !before.bundles.contains(path))
                .cloned()
                .collect(),
            removed_bundles: before
                .bundles
                .iter()
                .filter(|path| !after.bundles.contains(path))
                .cloned()
                .collect(),
            pages: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ScenarioComparison {
    pub scenario: String,
    pub totals: Change,
    pub sources: Vec<Change>,
    pub packages: Vec<Change>,
    pub bundles: Vec<Change>,
}

#[derive(Debug, Serialize)]
pub struct Change {
    pub name: String,
    pub change: &'static str,
    pub before: Counts,
    pub after: Counts,
    pub delta: Delta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub bytes: i128,
    pub observed_bytes: i128,
    pub unobserved_bytes: i128,
    pub unmeasured_bytes: i128,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    metric: String,
    attribution: String,
    source_paths: String,
    /// Reports before 0.10 have none; their mode follows from `scenarios`.
    #[serde(default)]
    mode: Option<String>,
    scenarios: Vec<String>,
    include: Vec<String>,
    exclude: Vec<String>,
    totals: Counts,
    sources: Vec<Row>,
    packages: Vec<Row>,
    bundles: Vec<Row>,
    scenario_reports: Vec<ScenarioSnapshot>,
    #[serde(default)]
    initial_load: Option<InitialLoadSnapshot>,
    #[serde(default)]
    cpu: Option<crate::cpu::CpuReport>,
}

#[derive(Deserialize)]
struct InitialLoadSnapshot {
    html: String,
    bytes: usize,
    bundles: Vec<String>,
    #[serde(default)]
    pages: Vec<InitialLoadSnapshot>,
}

#[derive(Deserialize)]
struct Row {
    source: Option<String>,
    package: Option<String>,
    path: Option<String>,
    /// A bundle row's sources.
    #[serde(default)]
    sources: Vec<NamedSource>,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Deserialize)]
struct NamedSource {
    source: String,
}

#[derive(Deserialize)]
struct ScenarioSnapshot {
    scenario: String,
    totals: Counts,
    sources: Vec<Row>,
    packages: Vec<Row>,
    bundles: Vec<Row>,
}

impl Change {
    fn new(name: String, before: Option<&Counts>, after: Option<&Counts>) -> Self {
        let change = match (before, after) {
            (None, _) => "added",
            (_, None) => "removed",
            _ => "changed",
        };
        let before = before.cloned().unwrap_or_default();
        let after = after.cloned().unwrap_or_default();
        let delta = Delta {
            bytes: after.bytes as i128 - before.bytes as i128,
            observed_bytes: after.observed_bytes as i128 - before.observed_bytes as i128,
            unobserved_bytes: after.unobserved_bytes as i128 - before.unobserved_bytes as i128,
            unmeasured_bytes: after.unmeasured_bytes as i128 - before.unmeasured_bytes as i128,
        };
        let change = if change == "changed"
            && delta.bytes == 0
            && delta.observed_bytes == 0
            && delta.unobserved_bytes == 0
            && delta.unmeasured_bytes == 0
        {
            "unchanged"
        } else {
            change
        };
        Self {
            name,
            change,
            before,
            after,
            delta,
        }
    }
}

fn rows<'a>(
    before: &[Row],
    after: impl Iterator<Item = (&'a str, &'a Counts)>,
) -> Result<Vec<Change>> {
    let mut previous = BTreeMap::new();
    for row in before {
        let name = row
            .source
            .as_ref()
            .or(row.path.as_ref())
            .or(row.package.as_ref())
            .ok_or_else(|| anyhow::anyhow!("baseline row has no identity"))?;
        ensure!(
            previous.insert(name.as_str(), &row.counts).is_none(),
            "duplicate baseline identity {name:?}"
        );
        validate_counts(name, &row.counts)?;
    }
    Ok(changes(previous, after))
}

fn changes<'a>(
    mut previous: BTreeMap<&str, &Counts>,
    after: impl Iterator<Item = (&'a str, &'a Counts)>,
) -> Vec<Change> {
    let mut result = after
        .map(|(name, counts)| Change::new(name.into(), previous.remove(name), Some(counts)))
        .collect::<Vec<_>>();
    result.extend(
        previous
            .into_iter()
            .map(|(name, counts)| Change::new(name.into(), Some(counts), None)),
    );
    result.sort_by(|a, b| b.delta.bytes.cmp(&a.delta.bytes).then(a.name.cmp(&b.name)));
    result
}

fn validate_counts(name: &str, counts: &Counts) -> Result<()> {
    ensure!(
        counts
            .observed_bytes
            .checked_add(counts.unobserved_bytes)
            .and_then(|n| n.checked_add(counts.unmeasured_bytes))
            == Some(counts.bytes),
        "invalid baseline counts for {name:?}: observed {} + unobserved {} + unmeasured {} is not bytes {}",
        counts.observed_bytes,
        counts.unobserved_bytes,
        counts.unmeasured_bytes,
        counts.bytes
    );
    Ok(())
}

pub fn compare(report: &Report, data: &[u8]) -> Result<Comparison> {
    let version: serde_json::Value = serde_json::from_slice(data)?;
    ensure!(
        version["schemaVersion"].as_u64() == Some(report.schema_version as u64),
        "baseline schemaVersion must be {}; regenerate the baseline with this version and the same --dir",
        report.schema_version
    );
    let baseline: Snapshot = serde_json::from_value(version)?;
    ensure!(
        baseline.metric == report.metric
            && baseline.attribution == report.attribution
            && baseline.source_paths == report.source_paths,
        "baseline uses incompatible metrics or source path normalization"
    );
    let baseline_mode = baseline.mode.clone().unwrap_or_else(|| {
        if baseline.scenarios.is_empty() {
            crate::STATIC_MODE.into()
        } else {
            crate::COVERAGE_MODE.into()
        }
    });
    ensure!(
        baseline_mode == report.mode,
        "baseline mode mismatch: the baseline is a {baseline_mode} analysis ({}) and this one is a {} analysis ({}). Generated bytes stay comparable, but observed, unobserved, and unmeasured counts, scenario comparisons, and the per-package split of those counts are not. Regenerate the baseline in the same mode.",
        describe_mode(&baseline_mode, &baseline.scenarios),
        report.mode,
        describe_mode(report.mode, &report.scenarios)
    );
    validate_counts("totals", &baseline.totals)?;
    let mut warnings = Vec::new();
    if baseline.include != report.include || baseline.exclude != report.exclude {
        warnings.push("Baseline and current bundle filters differ; changes may reflect selection differences.".into());
    }
    // Absolute roots and hashed bundle names differ between two checkouts, so the root shows
    // only in the source identities, which are relative to it.
    let mapped = |name: &&str| *name != crate::attribution::UNMAPPED;
    let before_sources = baseline
        .sources
        .iter()
        .filter_map(|r| r.source.as_deref())
        .filter(mapped)
        .collect::<std::collections::BTreeSet<_>>();
    let after_sources = report
        .sources
        .iter()
        .map(|r| r.source.as_str())
        .filter(mapped)
        .collect::<std::collections::BTreeSet<_>>();
    if !before_sources.is_empty()
        && !after_sources.is_empty()
        && before_sources.is_disjoint(&after_sources)
    {
        warnings.push("No source identity in the baseline matches one in this report, so every source shows as removed and added. Source identities are relative to the analysis root: check that both reports used the same --dir and bundle selection.".into());
    }
    if baseline
        .scenarios
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        != report.scenarios.iter().collect()
    {
        warnings.push("Scenario sets differ; aggregate coverage deltas are not equivalent measurements. Only matching named scenarios are compared.".into());
    }
    if baseline.totals.unmeasured_bytes != report.totals.unmeasured_bytes {
        warnings.push("Measurement coverage changed; a reduction in unobserved bytes may reflect missing recordings.".into());
    }
    let mut scenarios = Vec::new();
    let mut previous_scenarios = BTreeMap::new();
    for scenario in &baseline.scenario_reports {
        ensure!(
            previous_scenarios
                .insert(scenario.scenario.as_str(), scenario)
                .is_none(),
            "duplicate baseline scenario {:?}",
            scenario.scenario
        );
        validate_counts(
            &format!("scenario {} totals", scenario.scenario),
            &scenario.totals,
        )?;
    }
    for scenario in &report.scenario_reports {
        if let Some(before) = previous_scenarios.get(scenario.scenario.as_str()) {
            if before.totals.unmeasured_bytes != scenario.totals.unmeasured_bytes {
                warnings.push(format!("Scenario {:?}: measurement coverage changed; interpret unobserved deltas together with unmeasured deltas.", scenario.scenario));
            }
            scenarios.push(ScenarioComparison {
                scenario: scenario.scenario.clone(),
                totals: Change::new("total".into(), Some(&before.totals), Some(&scenario.totals)),
                sources: rows(
                    &before.sources,
                    scenario
                        .sources
                        .iter()
                        .map(|r| (r.source.as_str(), &r.counts)),
                )?,
                packages: rows(
                    &before.packages,
                    scenario
                        .packages
                        .iter()
                        .map(|r| (r.package.as_str(), &r.counts)),
                )?,
                bundles: rows(
                    &before.bundles,
                    scenario
                        .bundles
                        .iter()
                        .map(|r| (r.path.as_str(), &r.counts)),
                )?,
            });
        }
    }
    let cpu = match (&baseline.cpu, &report.cpu) {
        (Some(before), Some(after)) => {
            let before_bundles = baseline
                .bundles
                .iter()
                .filter_map(|row| {
                    let sources = row.sources.iter().map(|s| s.source.clone()).collect();
                    row.path.clone().map(|path| (path, sources))
                })
                .collect();
            let after_bundles = report
                .bundles
                .iter()
                .map(|b| {
                    (
                        b.path.clone(),
                        b.sources.iter().map(|s| s.source.clone()).collect(),
                    )
                })
                .collect();
            Some(crate::cpu::compare(
                before,
                &before_bundles,
                after,
                &after_bundles,
                &mut warnings,
            )?)
        }
        (None, Some(_)) => {
            warnings
                .push("The baseline has no CPU profiles; CPU self time is not compared.".into());
            None
        }
        (Some(_), None) => {
            warnings
                .push("Only the baseline has CPU profiles; CPU self time is not compared.".into());
            None
        }
        (None, None) => None,
    };
    let initial_load = match (&baseline.initial_load, &report.initial_load) {
        (Some(before), Some(after)) => {
            let mut change = InitialLoadChange::new(before, after);
            // One document on each side compares whatever its path, as before --initial-html was
            // repeatable; with more, the paths given tell the documents apart.
            if !before.pages.is_empty() || !after.pages.is_empty() {
                let before_pages = if before.pages.is_empty() {
                    std::slice::from_ref(before)
                } else {
                    &before.pages
                };
                let mut pages = Vec::new();
                for page in after.pages() {
                    match before_pages.iter().find(|p| p.html == page.html) {
                        Some(base) => pages.push(InitialPageChange {
                            html: page.html.clone(),
                            change: InitialLoadChange::new(base, page),
                        }),
                        None => warnings.push(format!(
                            "The baseline has no initial load of {}; its initial-load bytes are not compared.",
                            page.html
                        )),
                    }
                }
                for base in before_pages {
                    if !after.pages().iter().any(|p| p.html == base.html) {
                        warnings.push(format!(
                            "Only the baseline has an initial load of {}; pass it with --initial-html to compare it.",
                            base.html
                        ));
                    }
                }
                change.pages = Some(pages);
            }
            Some(change)
        }
        (None, Some(_)) => {
            warnings.push(
                "The baseline has no initial load (it was generated without --initial-html); initial-load bytes are not compared.".into(),
            );
            None
        }
        (Some(_), None) => {
            warnings.push(
                "Only the baseline has an initial load; pass --initial-html to compare initial-load bytes.".into(),
            );
            None
        }
        (None, None) => None,
    };
    let sources = rows(
        &baseline.sources,
        report
            .sources
            .iter()
            .map(|r| (r.source.as_str(), &r.counts)),
    )?;
    // The baseline's sources rather than its `groups`, so that a baseline made without
    // --group-by, or with other patterns, is grouped like this report.
    let groups = if report.group_by.is_empty() {
        Vec::new()
    } else {
        let before = crate::group_rows(
            &report.group_by,
            baseline
                .sources
                .iter()
                .filter_map(|row| Some((row.source.as_deref()?, &row.counts, None))),
        )?;
        changes(
            before
                .iter()
                .map(|g| (g.group.as_str(), &g.counts))
                .collect(),
            report.groups.iter().map(|g| (g.group.as_str(), &g.counts)),
        )
    };
    Ok(Comparison {
        totals: Change::new("total".into(), Some(&baseline.totals), Some(&report.totals)),
        sources,
        packages: rows(
            &baseline.packages,
            report
                .packages
                .iter()
                .map(|r| (r.package.as_str(), &r.counts)),
        )?,
        bundles: rows(
            &baseline.bundles,
            report.bundles.iter().map(|r| (r.path.as_str(), &r.counts)),
        )?,
        groups,
        scenarios,
        initial_load,
        warnings,
        cpu,
    })
}

fn describe_mode(mode: &str, scenarios: &[String]) -> String {
    if mode == crate::STATIC_MODE {
        "no coverage".into()
    } else {
        format!("scenarios {scenarios:?}")
    }
}
