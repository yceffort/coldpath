//! Compare report identities, including removed rows and matched scenarios.
use crate::{Counts, Report};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
pub struct Comparison {
    pub totals: Change,
    pub sources: Vec<Change>,
    pub packages: Vec<Change>,
    pub bundles: Vec<Change>,
    pub scenarios: Vec<ScenarioComparison>,
    pub warnings: Vec<String>,
    /// Present when both reports have CPU profiles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<crate::cpu::CpuComparison>,
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
    scenarios: Vec<String>,
    include: Vec<String>,
    exclude: Vec<String>,
    totals: Counts,
    sources: Vec<Row>,
    packages: Vec<Row>,
    bundles: Vec<Row>,
    scenario_reports: Vec<ScenarioSnapshot>,
    #[serde(default)]
    cpu: Option<crate::cpu::CpuReport>,
}

#[derive(Deserialize)]
struct Row {
    source: Option<String>,
    package: Option<String>,
    path: Option<String>,
    #[serde(flatten)]
    counts: Counts,
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
        validate_counts(&row.counts)?;
    }
    let mut result = after
        .map(|(name, counts)| Change::new(name.into(), previous.remove(name), Some(counts)))
        .collect::<Vec<_>>();
    result.extend(
        previous
            .into_iter()
            .map(|(name, counts)| Change::new(name.into(), Some(counts), None)),
    );
    result.sort_by(|a, b| b.delta.bytes.cmp(&a.delta.bytes).then(a.name.cmp(&b.name)));
    Ok(result)
}

fn validate_counts(counts: &Counts) -> Result<()> {
    ensure!(
        counts
            .observed_bytes
            .checked_add(counts.unobserved_bytes)
            .and_then(|n| n.checked_add(counts.unmeasured_bytes))
            == Some(counts.bytes),
        "invalid baseline counts"
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
    validate_counts(&baseline.totals)?;
    let mut warnings = Vec::new();
    if baseline.include != report.include || baseline.exclude != report.exclude {
        warnings.push("Baseline and current bundle filters differ; changes may reflect selection differences.".into());
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
        validate_counts(&scenario.totals)?;
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
        (Some(before), Some(after)) => Some(crate::cpu::compare(before, after, &mut warnings)?),
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
    Ok(Comparison {
        totals: Change::new("total".into(), Some(&baseline.totals), Some(&report.totals)),
        sources: rows(
            &baseline.sources,
            report
                .sources
                .iter()
                .map(|r| (r.source.as_str(), &r.counts)),
        )?,
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
        scenarios,
        warnings,
        cpu,
    })
}
