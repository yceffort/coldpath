use crate::{Report, Span, Status};
use anyhow::Result;
use base64::Engine;
use serde::{Serialize, ser::SerializeSeq};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlReport<'a> {
    schema_version: u32,
    totals: &'a crate::Counts,
    scenarios: &'a [String],
    initial_scenario: &'a Option<String>,
    scenario_reports: &'a [crate::scenario::ScenarioReport],
    baseline: &'a Option<crate::baseline::Comparison>,
    import_paths: &'a Option<Vec<crate::metadata::ImportPath>>,
    recommendations: &'a [crate::recommendations::Recommendation],
    #[serde(skip_serializing_if = "Option::is_none")]
    inspector_html: Option<String>,
    warnings: &'a [String],
    recording_warnings: &'a [String],
    excluded_bundles: &'a [String],
    budget_failures: &'a [String],
    compression: &'a Option<crate::ci::CompressedSizes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label_generator: &'a Option<crate::annotations::LabelGenerator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: &'a Option<crate::cpu::CpuReport>,
    duplicate_sources: Vec<&'a crate::SourceRow>,
    bundles: Vec<HtmlBundle<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlBundle<'a> {
    path: &'a str,
    #[serde(flatten)]
    counts: &'a crate::Counts,
    sources: Vec<HtmlSource<'a>>,
    verification: &'a [crate::input::Verification],
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: &'a Option<crate::annotations::Loading>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    mapping_diagnostics: &'a [crate::MappingDiagnostic],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlSource<'a> {
    source: &'a str,
    package: &'a str,
    has_content: bool,
    first_observed: &'a [crate::scenario::FirstObserved],
    estimated_compression: &'a Option<crate::ci::CompressedSizes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: &'a Option<crate::annotations::SourceLabel>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    mapping_diagnostics: &'a [usize],
    #[serde(flatten)]
    counts: &'a crate::Counts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkDetails<'a> {
    generated_source: &'a str,
    contents: Vec<&'a Option<String>>,
    spans: CompactSpans<'a>,
    scenario_spans: std::collections::BTreeMap<&'a str, CompactSpans<'a>>,
}

/// The HTML wire format uses tuples; the public JSON keeps named fields.
struct CompactSpans<'a>(&'a [Span]);
impl Serialize for CompactSpans<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for span in self.0 {
            seq.serialize_element(&(
                span.start,
                span.end,
                span.start_utf16,
                span.end_utf16,
                span.source,
                match span.status {
                    Status::Observed => 0u8,
                    Status::Unobserved => 1u8,
                    Status::Unmeasured => 2u8,
                },
                span.original.as_ref().map(|p| p.line),
                span.original.as_ref().map(|p| p.column),
            ))?;
        }
        seq.end()
    }
}

/// Escape the HTML raw-text boundary as well as legacy script parsing hazards.
pub fn html(report: &Report) -> Result<String> {
    anyhow::ensure!(report.details, "HTML requires detailed analysis");
    let json = serde_json::to_string(&HtmlReport {
        schema_version: report.schema_version,
        totals: &report.totals,
        scenarios: &report.scenarios,
        initial_scenario: &report.initial_scenario,
        scenario_reports: &report.scenario_reports,
        baseline: &report.baseline,
        import_paths: &report.import_paths,
        recommendations: &report.recommendations,
        inspector_html: None,
        warnings: &report.warnings,
        recording_warnings: &report.recording_warnings,
        excluded_bundles: &report.excluded_bundles,
        budget_failures: &report.budget_failures,
        compression: &report.compression,
        label_generator: &report.label_generator,
        // The code inspector does not show CPU values.
        cpu: &None,
        duplicate_sources: report
            .sources
            .iter()
            .filter(|s| s.duplicates.is_some())
            .collect(),
        bundles: report
            .bundles
            .iter()
            .map(|b| HtmlBundle {
                path: &b.path,
                counts: &b.counts,
                sources: b
                    .sources
                    .iter()
                    .map(|s| HtmlSource {
                        source: &s.source,
                        package: &s.package,
                        has_content: s.content.is_some(),
                        first_observed: &s.first_observed,
                        estimated_compression: &s.estimated_compression,
                        label: &s.label,
                        mapping_diagnostics: &s.mapping_diagnostics,
                        counts: &s.counts,
                    })
                    .collect(),
                verification: &b.verification,
                loading: &b.loading,
                mapping_diagnostics: &b.mapping_diagnostics,
            })
            .collect(),
    })?;
    let mut payloads = embedded_data("report-data", json)?;
    for (index, bundle) in report.bundles.iter().enumerate() {
        payloads.push_str(&embedded_data(
            &format!("chunk-data-{index}"),
            serde_json::to_string(&ChunkDetails {
                generated_source: &bundle.generated_source,
                contents: bundle.sources.iter().map(|s| &s.content).collect(),
                spans: CompactSpans(&bundle.spans),
                scenario_spans: bundle
                    .scenario_spans
                    .iter()
                    .map(|(name, spans)| (name.as_str(), CompactSpans(spans)))
                    .collect(),
            })?,
        )?);
    }
    Ok(include_str!("ui/report.html").replacen("__COLDPATH_PAYLOADS__", &payloads, 1))
}

/// A compact size/coverage explorer: no code or interval payload is necessary.
pub fn treemap(report: &Report) -> Result<String> {
    treemap_with_inspector(report, false)
}

/// Detailed treemaps reuse the existing inspector in an offline, sandboxed frame.
pub fn treemap_with_inspector(report: &Report, include_inspector: bool) -> Result<String> {
    let json = serde_json::to_string(&HtmlReport {
        schema_version: report.schema_version,
        totals: &report.totals,
        scenarios: &report.scenarios,
        initial_scenario: &report.initial_scenario,
        scenario_reports: &report.scenario_reports,
        baseline: &report.baseline,
        import_paths: &report.import_paths,
        recommendations: &report.recommendations,
        inspector_html: if include_inspector {
            Some(html(report)?)
        } else {
            None
        },
        warnings: &report.warnings,
        recording_warnings: &report.recording_warnings,
        excluded_bundles: &report.excluded_bundles,
        budget_failures: &report.budget_failures,
        compression: &report.compression,
        label_generator: &report.label_generator,
        cpu: &report.cpu,
        duplicate_sources: report
            .sources
            .iter()
            .filter(|s| s.duplicates.is_some())
            .collect(),
        bundles: report
            .bundles
            .iter()
            .map(|b| HtmlBundle {
                path: &b.path,
                counts: &b.counts,
                sources: b
                    .sources
                    .iter()
                    .map(|s| HtmlSource {
                        source: &s.source,
                        package: &s.package,
                        has_content: false,
                        first_observed: &s.first_observed,
                        estimated_compression: &s.estimated_compression,
                        label: &s.label,
                        mapping_diagnostics: &s.mapping_diagnostics,
                        counts: &s.counts,
                    })
                    .collect(),
                verification: &b.verification,
                loading: &b.loading,
                mapping_diagnostics: &b.mapping_diagnostics,
            })
            .collect(),
    })?;
    // Summary payloads are small. Escaped JSON avoids compression/decode costs.
    let payload = escaped_json(&json);
    Ok(include_str!("ui/treemap.html").replacen("__COLDPATH_DATA__", &payload, 1))
}

pub fn tsv(report: &Report) -> String {
    let mut output = String::from("Source\tBytes\tObserved\tUnobserved\tUnmeasured\n");
    for row in &report.sources {
        let name = row
            .source
            .replace('\\', "\\\\")
            .replace('\t', "\\t")
            .replace('\r', "\\r")
            .replace('\n', "\\n");
        output.push_str(&format!(
            "{name}\t{}\t{}\t{}\t{}\n",
            row.counts.bytes,
            row.counts.observed_bytes,
            row.counts.unobserved_bytes,
            row.counts.unmeasured_bytes
        ));
    }
    output
}

fn escaped_json(json: &str) -> String {
    json.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn embedded_data(id: &str, json: String) -> Result<String> {
    let (encoding, payload) = if json.len() > 16_384 {
        (
            "gzip-base64",
            base64::engine::general_purpose::STANDARD.encode(crate::ci::gzip(json.as_bytes())?),
        )
    } else {
        ("json", escaped_json(&json))
    };
    Ok(format!(
        "<script type=\"application/json\" data-encoding=\"{encoding}\" id=\"{id}\">{payload}</script>\n"
    ))
}
