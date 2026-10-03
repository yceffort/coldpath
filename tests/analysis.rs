use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

use coldpath::{
    analyze, attribution,
    coverage::{self, CoverageRange, FunctionCoverage, Interval},
    metadata, sha256,
    text::TextIndex,
};
use serde_json::json;

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "coldpath-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn write(&self, path: &str, content: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::write(&path, content).unwrap();
        path
    }
    fn coverage(&self, name: &str, source: &str, ranges: serde_json::Value) -> PathBuf {
        let map = fs::read(self.0.join("app.js.map")).ok();
        self.write(
            name,
            &json!({"schemaVersion":1,"scenario":name,"scripts":[{
                "path":"app.js", "sha256":sha256(source.as_bytes()),
                "sourceMapSha256":map.map(|data| sha256(&data)),
                "functions":[{"isBlockCoverage":true,"ranges":ranges}]
            }]})
            .to_string(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn function(ranges: &[(usize, usize, u64)]) -> FunctionCoverage {
    FunctionCoverage {
        is_block_coverage: true,
        ranges: ranges
            .iter()
            .map(|&(start_offset, end_offset, count)| CoverageRange {
                start_offset,
                end_offset,
                count,
            })
            .collect(),
    }
}

#[test]
fn nested_zero_range_does_not_erase_executed_child() {
    let text = TextIndex::new(&"x".repeat(100));
    let ranges = coverage::used_ranges(
        &[
            function(&[(0, 100, 1), (10, 90, 0)]),
            function(&[(20, 40, 1), (25, 30, 0)]),
        ],
        &text,
    )
    .unwrap();
    assert_eq!(
        ranges,
        vec![
            Interval { start: 0, end: 10 },
            Interval { start: 20, end: 25 },
            Interval { start: 30, end: 40 },
            Interval {
                start: 90,
                end: 100
            }
        ]
    );
}

#[test]
fn adjacent_and_equal_start_ranges() {
    let text = TextIndex::new("0123456789");
    let ranges =
        coverage::used_ranges(&[function(&[(0, 10, 1), (0, 3, 0), (3, 6, 0)])], &text).unwrap();
    assert_eq!(ranges, vec![Interval { start: 6, end: 10 }]);
}

#[test]
fn crossing_ranges_fail_instead_of_silently_miscounting() {
    let text = TextIndex::new(&"x".repeat(20));
    assert!(
        coverage::used_ranges(&[function(&[(0, 10, 1)]), function(&[(5, 15, 0)])], &text).is_err()
    );
}

#[test]
fn rejects_invalid_offsets_and_blocks() {
    let text = TextIndex::new("한🔥x");
    for ranges in [
        &[(0, 9, 1)][..],
        &[(0, 4, 1), (1, 2, 0)][..],
        &[(1, 3, 1), (0, 1, 0)][..],
        &[(3, 1, 1)][..],
    ] {
        assert!(coverage::used_ranges(&[function(ranges)], &text).is_err());
    }
}

#[test]
fn utf16_and_all_javascript_line_endings() {
    let text = TextIndex::new("한🔥\r\nx\ry\u{2028}z\u{2029}");
    assert_eq!(text.byte(1).unwrap(), 3);
    assert!(text.byte(2).is_err());
    assert_eq!(text.byte(3).unwrap(), 7);
    assert_eq!(text.position(1, 0).unwrap(), 9);
    assert_eq!(text.position(2, 0).unwrap(), 11);
    assert_eq!(text.position(3, 0).unwrap(), 15);
    assert_eq!(text.position(4, 0).unwrap(), 19);
    assert!(text.position(0, 4).is_err());
}

#[test]
fn utf8_bytes_and_utf16_units_are_separate() {
    let fixture = Fixture::new();
    let source = "한🔥x";
    fixture.write("app.js", source);
    fixture.write(
        "app.js.map",
        r#"{"version":3,"sources":["src/a.js"],"names":[],"mappings":"AAAA"}"#,
    );
    let coverage = fixture.coverage(
        "run.json",
        source,
        json!([
            {"startOffset":0,"endOffset":4,"count":1},
            {"startOffset":1,"endOffset":3,"count":0}
        ]),
    );
    let report = analyze(&fixture.0, &[coverage]).unwrap();
    assert_eq!(report.totals.bytes, 8);
    assert_eq!(report.totals.observed_bytes, 4);
    assert_eq!(report.totals.unobserved_bytes, 4);
    assert_eq!(report.bundles[0].observed_utf16_units, Some(2));
}

#[test]
fn static_mode_and_missing_script_are_unmeasured() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    fixture.write("lazy.js", "later");
    let report = analyze(&fixture.0, &[]).unwrap();
    assert_eq!(report.totals.unmeasured_bytes, 9);
    assert_eq!(report.totals.unobserved_bytes, 0);
    let coverage = fixture.coverage(
        "run.json",
        "abcd",
        json!([{"startOffset":0,"endOffset":4,"count":0}]),
    );
    let report = analyze(&fixture.0, &[coverage]).unwrap();
    assert_eq!(report.totals.unobserved_bytes, 4);
    assert_eq!(report.totals.unmeasured_bytes, 5);
}

#[test]
fn stale_bundle_and_stale_map_are_rejected() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    let coverage = fixture.coverage(
        "run.json",
        "abcd",
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    fixture.write("app.js", "abce");
    assert!(
        analyze(&fixture.0, std::slice::from_ref(&coverage))
            .unwrap_err()
            .to_string()
            .contains("SHA-256 mismatch")
    );
    fixture.write("app.js", "abcd");
    fixture.write(
        "app.js.map",
        r#"{"version":3,"sources":[],"names":[],"mappings":""}"#,
    );
    assert!(
        analyze(&fixture.0, &[coverage])
            .unwrap_err()
            .to_string()
            .contains("source-map SHA-256 mismatch")
    );
}

#[test]
fn multiple_scenarios_union_without_double_counting() {
    let fixture = Fixture::new();
    fixture.write("app.js", "0123456789");
    let first = fixture.coverage(
        "one.json",
        "0123456789",
        json!([
            {"startOffset":0,"endOffset":10,"count":0}, {"startOffset":0,"endOffset":5,"count":1}
        ]),
    );
    let second = fixture.coverage(
        "two.json",
        "0123456789",
        json!([
            {"startOffset":0,"endOffset":10,"count":0}, {"startOffset":3,"endOffset":8,"count":1}
        ]),
    );
    let report = analyze(&fixture.0, &[first.clone(), second, first]).unwrap();
    assert_eq!(report.totals.observed_bytes, 8);
    assert_eq!(report.totals.unobserved_bytes, 2);
}

#[test]
fn scenario_breakdown_uses_range_differences_and_preserves_missing_recordings() {
    let fixture = Fixture::new();
    let source = "한🔥xy";
    fixture.write("app.js", source);
    fixture.write(
        "app.js.map",
        r#"{"version":3,"sources":["src/app.ts"],"names":[],"mappings":"AAAA"}"#,
    );
    fixture.write("lazy.js", "later");
    fixture.write("absent.js", "never");
    let initial = fixture.coverage(
        "initial",
        source,
        json!([{"startOffset":0,"endOffset":3,"count":1}]),
    );
    let interaction = fixture.write("interaction", &json!({"schemaVersion":1,"scenario":"interaction","scripts":[
        {"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":sha256(&fs::read(fixture.0.join("app.js.map")).unwrap()),"functions":[{"isBlockCoverage":true,"ranges":[{"startOffset":1,"endOffset":5,"count":1}]}]},
        {"path":"lazy.js","sha256":sha256(b"later"),"sourceMapSha256":null,"functions":[{"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":5,"count":1}]}]}
    ]}).to_string());
    let mut options = coldpath::AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        ..Default::default()
    };
    for details in [true, false] {
        options.details = details;
        let report = coldpath::analyze_with_options(
            &fixture.0,
            &[initial.clone(), interaction.clone(), interaction.clone()],
            &options,
        )
        .unwrap();
        assert_eq!(report.scenarios, ["initial", "interaction"]);
        assert_eq!(report.totals.bytes, 19);
        assert_eq!(report.totals.observed_bytes, 14);
        assert_eq!(report.totals.unmeasured_bytes, 5);
        let initial = &report.scenario_reports[0];
        let later = &report.scenario_reports[1];
        assert_eq!(
            (
                initial.totals.observed_bytes,
                initial.totals.unobserved_bytes,
                initial.totals.unmeasured_bytes
            ),
            (7, 2, 10)
        );
        assert_eq!(
            (
                later.totals.observed_bytes,
                later.totals.unobserved_bytes,
                later.totals.unmeasured_bytes
            ),
            (11, 3, 5)
        );
        assert_eq!(later.interaction_candidates[0].source, "src/app.ts");
        assert_eq!(later.interaction_candidates[0].interaction_only_bytes, 2);
        assert_eq!(
            later.interaction_candidates[0].initial_unmeasured_observed_bytes,
            0
        );
        assert_eq!(
            later.interaction_candidates[1].initial_unmeasured_observed_bytes,
            5
        );
        for scenario in &report.scenario_reports {
            assert_eq!(
                scenario.totals.bytes,
                scenario.totals.observed_bytes
                    + scenario.totals.unobserved_bytes
                    + scenario.totals.unmeasured_bytes
            );
            assert_eq!(
                scenario
                    .sources
                    .iter()
                    .map(|s| s.counts.bytes)
                    .sum::<usize>(),
                report.totals.bytes
            );
            assert_eq!(
                scenario
                    .packages
                    .iter()
                    .map(|s| s.counts.observed_bytes)
                    .sum::<usize>(),
                scenario.totals.observed_bytes
            );
            assert_eq!(
                scenario
                    .bundles
                    .iter()
                    .flat_map(|s| &s.sources)
                    .map(|s| s.counts.observed_bytes)
                    .sum::<usize>(),
                scenario.totals.observed_bytes
            );
        }
    }
    options.initial_scenario = Some("missing".into());
    assert!(
        coldpath::analyze_with_options(&fixture.0, &[initial, interaction], &options)
            .unwrap_err()
            .to_string()
            .contains("unknown initial scenario")
    );
}

#[test]
fn baseline_compares_normalized_sources_additions_removals_and_scenarios() {
    let before = Fixture::new();
    let after = Fixture::new();
    for (fixture, path, bytes, sources) in [
        (
            &before,
            "old.js",
            "12345678",
            vec!["src/keep.js", "node_modules/removed/index.js"],
        ),
        (
            &after,
            "chunks/new.js",
            "1234567890",
            vec!["../src/./keep.js", "../node_modules/added/index.js"],
        ),
    ] {
        fs::create_dir_all(fixture.0.join("chunks")).unwrap();
        fixture.write(path, bytes);
        fixture.write(&format!("{path}.map"), &json!({"version":3,"sources":sources,"names":[],"mappings": if fixture.0 == before.0 {"AAAA,ICAA"} else {"AAAA,MCAA"}}).to_string());
        fixture.write(
            "initial.json",
            &json!([{"url":path,"text":bytes,"ranges":[]}]).to_string(),
        );
    }
    let old = analyze(&before.0, &[before.0.join("initial.json")]).unwrap();
    let new = analyze(&after.0, &[after.0.join("initial.json")]).unwrap();
    let data = serde_json::to_vec(&old).unwrap();
    let comparison = coldpath::baseline::compare(&new, &data).unwrap();
    assert_eq!(comparison.totals.delta.bytes, 2);
    let row = |name: &str| comparison.sources.iter().find(|r| r.name == name).unwrap();
    assert_eq!(row("src/keep.js").delta.bytes, 2);
    assert_eq!(row("node_modules/added/index.js").change, "added");
    assert_eq!(row("node_modules/removed/index.js").delta.bytes, -4);
    assert_eq!(
        comparison
            .packages
            .iter()
            .find(|r| r.name == "removed")
            .unwrap()
            .change,
        "removed"
    );
    assert_eq!(comparison.scenarios[0].totals.delta.unobserved_bytes, 2);
    assert_eq!(
        comparison
            .sources
            .iter()
            .map(|r| r.delta.bytes)
            .sum::<i128>(),
        comparison.totals.delta.bytes
    );
    assert!(
        coldpath::baseline::compare(&new, br#"{"schemaVersion":2}"#)
            .unwrap_err()
            .to_string()
            .contains("regenerate")
    );
    let mut invalid = serde_json::to_value(&old).unwrap();
    let duplicate = invalid["sources"][0].clone();
    invalid["sources"].as_array_mut().unwrap().push(duplicate);
    assert!(
        coldpath::baseline::compare(&new, &serde_json::to_vec(&invalid).unwrap())
            .unwrap_err()
            .to_string()
            .contains("duplicate")
    );
    let mut different = serde_json::to_value(&old).unwrap();
    different["scenarios"] = json!(["other"]);
    different["scenarioReports"] = json!([]);
    let comparison =
        coldpath::baseline::compare(&new, &serde_json::to_vec(&different).unwrap()).unwrap();
    assert!(comparison.scenarios.is_empty());
    assert!(!comparison.warnings.is_empty());
}

#[test]
fn baseline_growth_budget_writes_reports_and_exits_two() {
    let fixture = Fixture::new();
    fixture.write("app.js", "1234");
    let report = analyze(&fixture.0, &[]).unwrap();
    fixture.write("main.json", &serde_json::to_string(&report).unwrap());
    fixture.write("app.js", "123456");
    let run = |limit| {
        std::process::Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&fixture.0)
            .args([
                "--dir",
                ".",
                "--baseline",
                "main.json",
                "--max-added-bytes",
                limit,
                "--json",
                "pr.json",
                "--markdown",
                "pr.md",
                "--treemap",
                "pr.html",
            ])
            .output()
            .unwrap()
    };
    let output = run("1");
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("pr.json")).unwrap()).unwrap();
    assert_eq!(report["baseline"]["totals"]["delta"]["bytes"], 2);
    assert_eq!(report["budgetFailures"].as_array().unwrap().len(), 1);
    assert!(fixture.0.join("pr.html").exists());
    assert!(run("2").status.success());
}

#[test]
fn initial_regression_budget_rejects_growth_and_missing_measurements() {
    let fixture = Fixture::new();
    fixture.write("app.js", "12345678");
    let coverage = fixture.coverage(
        "initial",
        "12345678",
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    let before = analyze(&fixture.0, std::slice::from_ref(&coverage)).unwrap();
    fixture.write("main.json", &serde_json::to_string(&before).unwrap());
    fixture.coverage(
        "initial",
        "12345678",
        json!([{"startOffset":0,"endOffset":2,"count":1}]),
    );
    let run = |limit| {
        std::process::Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&fixture.0)
            .args([
                "--dir",
                ".",
                "--coverage",
                "initial",
                "--initial-scenario",
                "initial",
                "--baseline",
                "main.json",
                "--max-added-unobserved-bytes",
                limit,
                "--json",
                "pr.json",
            ])
            .output()
            .unwrap()
    };
    let output = run("1");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("initial unobserved byte growth: +2"));
    assert!(run("2").status.success());
    fixture.write("unrecorded.js", "no evidence");
    let output = run("1000");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot check"));
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("pr.json")).unwrap()).unwrap();
    assert!(
        report["budgetFailures"][0]
            .as_str()
            .unwrap()
            .contains("unmeasured")
    );
}

#[test]
fn mapping_does_not_claim_unmapped_lines_or_prefixes() {
    let source = "xxabcd\nwrapper\nz";
    let map = br#"{"version":3,"sources":["src/a.js"],"names":[],"mappings":"EAAA,E;"}"#;
    let segments = attribution::segments(map, &TextIndex::new(source), source.len()).unwrap();
    assert_eq!(
        segments
            .iter()
            .filter(|s| s.source == "src/a.js")
            .map(|s| s.end - s.start)
            .sum::<usize>(),
        2
    );
    assert_eq!(
        segments.iter().map(|s| s.end - s.start).sum::<usize>(),
        source.len()
    );
}

#[test]
fn indexed_source_maps_and_missing_sources_content_work() {
    let map = br#"{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":{"version":3,"sources":["a.js"],"names":[],"mappings":"AAAA"}},{"offset":{"line":1,"column":1},"map":{"version":3,"sources":["b.js"],"names":[],"mappings":"AAAA"}}]}"#;
    let source = "abc\n xyz";
    let segments = attribution::segments(map, &TextIndex::new(source), source.len()).unwrap();
    assert_eq!(
        segments
            .iter()
            .filter(|s| s.source == "a.js")
            .map(|s| s.end - s.start)
            .sum::<usize>(),
        3
    );
    assert_eq!(
        segments
            .iter()
            .filter(|s| s.source == "b.js")
            .map(|s| s.end - s.start)
            .sum::<usize>(),
        3
    );
}

#[test]
fn indexed_sections_preserve_empty_and_unmapped_prefixes() {
    let source = "abcdefghij";
    for (mappings, expected) in [
        (
            "EAAA",
            vec![(0, 5, "a.ts"), (5, 7, "[unmapped]"), (7, 10, "b.ts")],
        ),
        ("", vec![(0, 5, "a.ts"), (5, 10, "[unmapped]")]),
        ("AAAA", vec![(0, 5, "a.ts"), (5, 10, "b.ts")]),
    ] {
        let map = json!({"version":3,"sections":[
            {"offset":{"line":0,"column":0},"map":{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}},
            {"offset":{"line":0,"column":5},"map":{"version":3,"sources":["b.ts"],"names":[],"mappings":mappings}}
        ]});
        let decoded = attribution::decode(
            map.to_string().as_bytes(),
            &TextIndex::new(source),
            source.len(),
        )
        .unwrap();
        assert_eq!(decoded.invalid_points, 0);
        assert_eq!(
            decoded
                .segments
                .iter()
                .map(|s| (s.start, s.end, s.source.as_str()))
                .collect::<Vec<_>>(),
            expected
        );
        assert!(
            decoded
                .segments
                .iter()
                .filter(|s| s.source == "[unmapped]")
                .all(|s| s.original.is_none())
        );
    }
}

#[test]
fn nested_index_offsets_reset_columns_on_later_lines() {
    let source = "abcdefghij\nklmnop";
    let map = json!({"version":3,"sections":[
        {"offset":{"line":0,"column":2},"map":{"version":3,"sections":[
            {"offset":{"line":0,"column":1},"map":{"version":3,"sources":["a.ts"],"names":[],"mappings":"EAAA"}},
            {"offset":{"line":1,"column":2},"map":{"version":3,"sources":["b.ts"],"names":[],"mappings":"AAAA"}}
        ]}}
    ]});
    let decoded = attribution::decode(
        map.to_string().as_bytes(),
        &TextIndex::new(source),
        source.len(),
    )
    .unwrap();
    assert_eq!(
        decoded
            .segments
            .iter()
            .filter(|s| s.source != "[unmapped]")
            .map(|s| (s.start, s.end, s.source.as_str()))
            .collect::<Vec<_>>(),
        vec![(5, 10, "a.ts"), (13, 17, "b.ts")]
    );
    assert_eq!(
        decoded
            .segments
            .iter()
            .map(|s| s.end - s.start)
            .sum::<usize>(),
        source.len()
    );
}

#[test]
fn unordered_and_overlapping_index_sections_are_rejected() {
    for (offsets, mappings) in [([5, 0], "AAAA"), ([0, 0], "AAAA"), ([0, 5], "MAAA")] {
        let map = json!({"version":3,"sections":[
            {"offset":{"line":0,"column":offsets[0]},"map":{"version":3,"sources":["a.ts"],"names":[],"mappings":mappings}},
            {"offset":{"line":0,"column":offsets[1]},"map":{"version":3,"sources":[],"names":[],"mappings":""}}
        ]});
        assert!(
            attribution::decode(
                map.to_string().as_bytes(),
                &TextIndex::new("abcdefghij"),
                10
            )
            .is_err()
        );
    }
}

#[test]
fn pnpm_scoped_packages_and_application_sources() {
    assert_eq!(
        attribution::package(
            "[project]/node_modules/.pnpm/@scope+pkg@1/node_modules/@scope/pkg/a.js"
        ),
        "@scope/pkg"
    );
    assert_eq!(
        attribution::package("../../node_modules/minisearch/dist/index.js"),
        "minisearch"
    );
    assert_eq!(
        attribution::package("webpack:///src/app.js"),
        "[application]"
    );
}

#[test]
fn malformed_map_fails_with_bundle_context() {
    let fixture = Fixture::new();
    fixture.write("app.js", "a");
    fixture.write("app.js.map", "{}");
    assert!(
        analyze(&fixture.0, &[])
            .unwrap_err()
            .to_string()
            .contains("app.js")
    );
}

#[test]
fn metadata_paths_handle_cycles_and_external_imports() {
    let data = json!({"inputs":{
        "entry.js":{"imports":[{"path":"shared.js"},{"path":"external","external":true}]},
        "shared.js":{"imports":[{"path":"entry.js"},{"path":"node_modules/pkg/index.js"}]},
        "node_modules/pkg/index.js":{"imports":[]}
    },"outputs":{"app.js":{"entryPoint":"entry.js","inputs":{
        "entry.js":{"bytesInOutput":5},"node_modules/pkg/index.js":{"bytesInOutput":100}
    }}}});
    let rows = metadata::import_paths(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert_eq!(
        rows[0].path.as_ref().unwrap(),
        &vec!["entry.js", "shared.js", "node_modules/pkg/index.js"]
    );
}

#[test]
fn coverage_missing_file_and_unsafe_path_fail() {
    assert!(coverage::validate_path("../app.js").is_err());
    assert!(coverage::validate_path("/app.js").is_err());
    let fixture = Fixture::new();
    fixture.write("other.js", "abcd");
    let coverage = fixture.coverage(
        "run.json",
        "abcd",
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    assert!(
        analyze(&fixture.0, &[coverage])
            .unwrap_err()
            .to_string()
            .contains("missing from analysis root")
    );
    let absent = fixture.0.join("absent.coverage.json");
    let error = analyze(&fixture.0, std::slice::from_ref(&absent))
        .unwrap_err()
        .to_string();
    assert_eq!(error, format!("read coverage {}", absent.display()));
}

#[test]
fn turbopack_separate_map_name_is_followed() {
    let fixture = Fixture::new();
    fixture.write(
        "app.js",
        "abc\n//# sourceMappingURL=different%20hash.js.map",
    );
    fixture.write(
        "different hash.js.map",
        r#"{"version":3,"sources":["src/a.js"],"names":[],"mappings":"AAAA"}"#,
    );
    let report = analyze(&fixture.0, &[]).unwrap();
    assert_eq!(report.bundles[0].mapped_bytes, 3);
    assert!(report.warnings.is_empty());
}

#[test]
fn declared_missing_and_remote_maps_are_errors() {
    let fixture = Fixture::new();
    for reference in [
        "missing.js.map",
        "https://example.com/app.js.map",
        "data:application/json;base64,e30=",
    ] {
        fixture.write("app.js", &format!("abc\n//# sourceMappingURL={reference}"));
        assert!(analyze(&fixture.0, &[]).is_err());
    }
}

#[test]
fn out_of_line_mapping_never_spills_into_next_line() {
    let source = "abc\nxyz";
    let map = br#"{"version":3,"sources":["a.js"],"names":[],"mappings":"AAAA,KAAA;AAAA"}"#;
    let (segments, ignored) =
        attribution::segments_with_diagnostics(map, &TextIndex::new(source), source.len()).unwrap();
    assert_eq!(ignored, 1);
    assert_eq!(
        segments
            .iter()
            .filter(|s| s.source == "a.js")
            .map(|s| s.end - s.start)
            .sum::<usize>(),
        6
    );
    assert_eq!(
        segments.iter().map(|s| s.end - s.start).sum::<usize>(),
        source.len()
    );
}

#[test]
fn rejected_mappings_report_coordinates_neighbors_and_affected_sources() {
    let a = |line: u32, column: u32| json!({"line": line, "column": column});
    let mapping = |line, column, source, original| json!({"generatedLine": line, "generatedColumn": column, "source": source, "original": original});
    for (source, map, reason, rejected, previous, next, region, assignments, linked) in [
        (
            // B's mapping at 7 falls inside the surrogate pair; A keeps [0, 10).
            "abcdef🔥gh",
            json!({"version":3,"sources":["a.js","b.js"],"names":[],"mappings":"AAAA,OCAA,CAAI"}),
            "insideSurrogatePair",
            mapping(0, 7, "b.js", a(0, 0)),
            mapping(0, 0, "a.js", a(0, 0)),
            mapping(0, 8, "b.js", a(0, 4)),
            json!({"start":0,"end":10,"startUtf16":0,"endUtf16":8}),
            json!([{"start":0,"end":10,"source":"a.js"}]),
            vec![("a.js", vec![0]), ("b.js", vec![0])],
        ),
        (
            "abc\nxyz",
            json!({"version":3,"sources":["a.js","b.js"],"names":[],"mappings":"AAAA,ECAA,GAAA"}),
            "columnOutsideLine",
            mapping(0, 5, "b.js", a(0, 0)),
            mapping(0, 2, "b.js", a(0, 0)),
            json!(null),
            json!({"start":2,"end":3,"startUtf16":2,"endUtf16":3}),
            json!([{"start":2,"end":3,"source":"b.js"}]),
            vec![("a.js", vec![]), ("b.js", vec![0])],
        ),
        (
            // Section offsets apply: the local column 2 is generated column 6.
            "abcde🔥g",
            json!({"version":3,"sections":[
                {"offset":{"line":0,"column":0},"map":{"version":3,"sources":["a.js"],"names":[],"mappings":"AAAA"}},
                {"offset":{"line":0,"column":4},"map":{"version":3,"sources":["b.js"],"names":[],"mappings":"AAAA,EAAE"}}
            ]}),
            "insideSurrogatePair",
            mapping(0, 6, "b.js", a(0, 2)),
            mapping(0, 4, "b.js", a(0, 0)),
            json!(null),
            json!({"start":4,"end":10,"startUtf16":4,"endUtf16":8}),
            json!([{"start":4,"end":10,"source":"b.js"}]),
            vec![("a.js", vec![]), ("b.js", vec![0])],
        ),
    ] {
        let fixture = Fixture::new();
        fixture.write("app.js", source);
        fixture.write("app.js.map", &map.to_string());
        let coverage = fixture.coverage(
            "run.json",
            source,
            json!([{"startOffset":0,"endOffset":source.encode_utf16().count(),"count":1}]),
        );
        let report = analyze(&fixture.0, &[coverage]).unwrap();
        let bundle = &report.bundles[0];
        let mut expected = rejected;
        expected["reason"] = json!(reason);
        expected["previous"] = previous;
        expected["next"] = next;
        expected["inspectRegion"] = region;
        expected["assignments"] = assignments;
        assert_eq!(
            serde_json::to_value(&bundle.mapping_diagnostics).unwrap(),
            json!([expected])
        );
        for (name, indices) in linked {
            let row = bundle.sources.iter().find(|s| s.source == name).unwrap();
            assert_eq!(row.mapping_diagnostics, indices, "{name}");
        }
        // Diagnostics never clamp or drop bytes.
        assert_eq!(report.totals.bytes, source.len());
        assert_eq!(report.totals.observed_bytes, source.len());
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("ignored 1 mapping points"))
        );
    }
}

#[test]
fn summary_limits_mapping_diagnostics_but_keeps_exact_counts() {
    let fixture = Fixture::new();
    fixture.write("app.js", "ab");
    // Columns 4..=152 all lie beyond the two-unit line.
    let mappings = format!("AAAA,IAAA{}", ",CAAA".repeat(149));
    fixture.write(
        "app.js.map",
        &json!({"version":3,"sources":["a.js"],"names":[],"mappings":mappings}).to_string(),
    );
    let check = |report: &coldpath::Report, kept: usize| {
        let bundle = &report.bundles[0];
        assert_eq!(bundle.rejected_mappings, 150);
        assert_eq!(bundle.mapping_diagnostics.len(), kept);
        assert_eq!(bundle.omitted_mapping_diagnostics, 150 - kept);
        assert_eq!(bundle.sources[0].rejected_mappings, 150);
        assert_eq!(
            bundle.sources[0].mapping_diagnostics,
            (0..kept).collect::<Vec<_>>()
        );
        assert_eq!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("first 100 of 150")),
            kept < 150
        );
        assert_eq!(report.totals.bytes, 2);
    };
    let summary = coldpath::analyze_with_options(
        &fixture.0,
        &[],
        &coldpath::AnalyzeOptions {
            details: false,
            ..Default::default()
        },
    )
    .unwrap();
    check(&summary, 100);
    let mut detailed = analyze(&fixture.0, &[]).unwrap();
    check(&detailed, 150);
    detailed.strip_details();
    detailed.strip_details();
    check(&detailed, 100);
}

#[test]
fn standard_formats_agree_and_preserve_capture_evidence() {
    let fixture = Fixture::new();
    let source = "한🔥x";
    fixture.write("app.js", source);
    fixture.write("app.js.map", r#"{"version":3,"sources":["a.ts"],"sourcesContent":["original"],"names":[],"mappings":"AAAA"}"#);
    let functions = json!([{"functionName":"f","isBlockCoverage":true,"ranges":[
        {"startOffset":0,"endOffset":4,"count":1},
        {"startOffset":1,"endOffset":3,"count":0}
    ]}]);
    let url = "https://cdn.test/assets/app.js?v=1";
    let mut options = coldpath::AnalyzeOptions::default();
    options
        .input
        .url_prefixes
        .push("https://cdn.test/assets/".into());
    for (name, value, verification) in [
        (
            "chrome.json",
            json!([{"url":url,"text":source,"ranges":[{"start":3,"end":4},{"start":0,"end":1}]}]),
            "source-text",
        ),
        (
            "playwright.json",
            json!([{"url":url,"source":source,"functions":functions}]),
            "source-text",
        ),
        (
            "v8.json",
            json!({"result":[{"url":url,"scriptId":"1","functions":functions}]}),
            "unverified",
        ),
    ] {
        let path = fixture.write(name, &value.to_string());
        if name == "v8.json" {
            assert!(
                coldpath::analyze_with_options(&fixture.0, std::slice::from_ref(&path), &options)
                    .unwrap_err()
                    .to_string()
                    .contains("--allow-unverified")
            );
            options.input.allow_unverified = true;
        }
        let report = coldpath::analyze_with_options(&fixture.0, &[path], &options).unwrap();
        assert_eq!(report.totals.observed_bytes, 4);
        assert_eq!(report.totals.unobserved_bytes, 4);
        let bundle = &report.bundles[0];
        assert_eq!(bundle.verification[0].source, verification);
        assert_eq!(bundle.verification[0].source_map, "unverified");
        assert_eq!(
            bundle
                .spans
                .iter()
                .map(|s| (s.start, s.end, s.start_utf16, s.end_utf16))
                .collect::<Vec<_>>(),
            vec![(0, 3, 0, 1), (3, 7, 1, 3), (7, 8, 3, 4)]
        );
        assert_eq!(bundle.sources[0].content.as_deref(), Some("original"));
        assert_eq!(bundle.spans[1].original.as_ref().unwrap().line, 0);
        assert_eq!(bundle.spans[1].status, coldpath::Status::Unobserved);
    }
}

#[test]
fn standard_source_mismatch_and_invalid_ranges_are_rejected() {
    let fixture = Fixture::new();
    fixture.write("app.js", "한🔥x");
    for (source, ranges) in [
        ("한🔥y", json!([])),
        ("한🔥x", json!([{"start":1,"end":2}])),
        ("한🔥x", json!([{"start":3,"end":1}])),
        ("한🔥x", json!([{"start":0,"end":100}])),
    ] {
        let path = fixture.write(
            "input.json",
            &json!([{"url":"app.js","text":source,"ranges":ranges}]).to_string(),
        );
        assert!(analyze(&fixture.0, &[path]).is_err());
    }
}

#[test]
fn inline_maps_and_explicit_external_maps() {
    use base64::Engine;
    let fixture = Fixture::new();
    let external = Fixture::new();
    let map = r#"{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}"#;
    let encoded = base64::engine::general_purpose::STANDARD.encode(map);
    let percent =
        percent_encoding::utf8_percent_encode(map, percent_encoding::NON_ALPHANUMERIC).to_string();
    for reference in [
        format!("//# sourceMappingURL=data:application/json;charset=utf-8;base64,{encoded}"),
        format!("/*# sourceMappingURL=data:application/json,{percent} */"),
    ] {
        fixture.write("app.js", &format!("abc\n{reference}"));
        let report = analyze(&fixture.0, &[]).unwrap();
        assert_eq!(report.bundles[0].mapped_bytes, 3);
        assert_eq!(
            report.bundles[0].source_map_sha256.as_deref(),
            Some(sha256(map.as_bytes()).as_str())
        );
    }
    fixture.write(
        "app.js",
        "abc\n//# sourceMappingURL=https://private.test/map",
    );
    let mut options = coldpath::AnalyzeOptions::default();
    options
        .maps
        .insert("app.js".into(), external.write("external.map", map));
    let report = coldpath::analyze_with_options(&fixture.0, &[], &options).unwrap();
    assert_eq!(report.bundles[0].mapped_bytes, 3);
    options
        .maps
        .insert("missing.js".into(), external.0.join("external.map"));
    assert!(coldpath::analyze_with_options(&fixture.0, &[], &options).is_err());
}

#[test]
fn source_paths_merge_across_chunk_depths_and_keep_distinct_files() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/sub")).unwrap();
    for (bundle, source) in [
        ("dist/a.js", "../src/x.js"),
        ("dist/sub/b.js", "../../src/./x.js"),
        ("dist/sub/c.js", "src/x.js"),
    ] {
        fixture.write(bundle, "12345678");
        fixture.write(
            &format!("{bundle}.map"),
            &json!({
                "version":3, "sources":[source], "names":[], "mappings":"AAAA"
            })
            .to_string(),
        );
    }
    for (root, expected) in [
        (fixture.0.clone(), "src/x.js"),
        (fixture.0.join("dist"), "../src/x.js"),
    ] {
        let report = analyze(&root, &[]).unwrap();
        assert_eq!(report.sources.len(), 2);
        assert_eq!(report.sources[0].source, expected);
        assert_eq!(report.sources[0].counts.bytes, 16);
        assert_eq!(report.sources[1].counts.bytes, 8);
        assert!(coldpath::report::tsv(&report).contains(&format!("{expected}\t16\t")));
        assert_eq!(report.bundles[0].sources[0].source, expected);
        assert_eq!(report.bundles[1].sources[0].source, expected);
    }
}

#[test]
fn source_paths_use_map_location_source_root_and_inline_bundle_location() {
    use base64::Engine;
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/sub")).unwrap();
    fs::create_dir_all(fixture.0.join("maps")).unwrap();
    let map = json!({"version":3,"sourceRoot":"../src","sources":["./x.js"],
        "names":[],"mappings":"AAAA"})
    .to_string();
    fixture.write("dist/a.js", "12345678\n//# sourceMappingURL=../maps/a.map");
    fixture.write("maps/a.map", &map);
    fixture.write("dist/sub/b.js", "12345678");
    let explicit = fixture.write("maps/b.map", &map);
    let inline = base64::engine::general_purpose::STANDARD.encode(
        json!({"version":3,"sources":["../../src/x.js"],"names":[],"mappings":"AAAA"}).to_string(),
    );
    fixture.write(
        "dist/sub/c.js",
        &format!("12345678\n//# sourceMappingURL=data:application/json;base64,{inline}"),
    );
    let mut options = coldpath::AnalyzeOptions::default();
    options.maps.insert("dist/sub/b.js".into(), explicit);
    let report = coldpath::analyze_with_options(&fixture.0, &[], &options).unwrap();
    let row = report
        .sources
        .iter()
        .find(|s| s.source == "src/x.js")
        .unwrap();
    assert_eq!(row.counts.bytes, 24);
    assert_eq!(report.sources.len(), 2); // Original source and unmapped comments.
    // An explicitly bound map outside --dir still resolves from its own directory.
    options.maps = std::collections::BTreeMap::from([
        ("a.js".into(), fixture.0.join("maps/a.map")),
        ("sub/b.js".into(), fixture.0.join("maps/b.map")),
    ]);
    let report = coldpath::analyze_with_options(&fixture.0.join("dist"), &[], &options).unwrap();
    assert_eq!(
        report
            .sources
            .iter()
            .find(|s| s.source == "../src/x.js")
            .unwrap()
            .counts
            .bytes,
        24
    );
}

#[test]
fn source_paths_normalize_before_indexed_map_deduplication() {
    let fixture = Fixture::new();
    fixture.write("app.js", "12345678");
    for prefix in ["webpack://app/", "webpack:///", "https://example.com/"] {
        let section = |column, source: String, content| {
            json!({
                "offset":{"line":0,"column":column},
                "map":{"version":3,"sources":[source],"sourcesContent":[content],"names":[],"mappings":"AAAA"}
            })
        };
        let map = |content| {
            json!({"version":3,"sections":[
                section(0, format!("{prefix}./src/x.js"), "original"),
                section(4, format!("{prefix}src/x.js"), content)
            ]})
            .to_string()
        };
        fixture.write("app.js.map", &map("original"));
        let report = analyze(&fixture.0, &[]).unwrap();
        assert_eq!(report.sources.len(), 1);
        assert_eq!(report.bundles[0].sources.len(), 1);
        assert_eq!(report.sources[0].source, format!("{prefix}src/x.js"));
        assert_eq!(report.sources[0].counts.bytes, 8);
        fixture.write("app.js.map", &map("conflict"));
        assert!(
            format!("{:#}", analyze(&fixture.0, &[]).unwrap_err())
                .contains("conflicting sourcesContent")
        );
    }
}

#[test]
fn source_paths_keep_spellings_whose_contents_differ_within_one_map() {
    let fixture = Fixture::new();
    fixture.write("app.js", "12345678");
    fixture.write(
        "app.js.map",
        &json!({"version":3,"sources":["webpack:///./src/x.vue","webpack:///src/x.vue"],
            "sourcesContent":["compiled","original"],"names":[],"mappings":"AAAA,ICAA"})
        .to_string(),
    );
    for details in [true, false] {
        let options = coldpath::AnalyzeOptions {
            details,
            ..Default::default()
        };
        let report = coldpath::analyze_with_options(&fixture.0, &[], &options).unwrap();
        let sources = &report.bundles[0].sources;
        assert_eq!(
            sources
                .iter()
                .map(|s| (s.source.as_str(), s.counts.bytes))
                .collect::<Vec<_>>(),
            vec![("webpack:///./src/x.vue", 4), ("webpack:///src/x.vue", 4)]
        );
        if details {
            assert_eq!(sources[0].content.as_deref(), Some("compiled"));
            assert_eq!(sources[1].content.as_deref(), Some("original"));
        }
    }
}

#[test]
fn url_mapping_is_explicit_and_rejects_traversal() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    let path = fixture.write(
        "input.json",
        &json!([{"url":"https://cdn.test/app.js","text":"abcd","ranges":[]}]).to_string(),
    );
    assert!(analyze(&fixture.0, std::slice::from_ref(&path)).is_err());
    let mut options = coldpath::AnalyzeOptions::default();
    options
        .input
        .script_paths
        .insert("https://cdn.test/app.js".into(), "app.js".into());
    assert_eq!(
        coldpath::analyze_with_options(&fixture.0, &[path], &options)
            .unwrap()
            .totals
            .unobserved_bytes,
        4
    );
    options.input.url_prefixes.push("https://cdn.test/".into());
    for url in [
        "https://cdn.test/%2e%2e/app.js",
        "https://cdn.test/%2Fapp.js",
        "https://cdn.test/a%5Cb.js",
    ] {
        let path = fixture.write(
            "input.json",
            &json!([{"url":url,"text":"abcd","ranges":[]}]).to_string(),
        );
        assert!(coldpath::analyze_with_options(&fixture.0, &[path], &options).is_err());
    }
}

#[test]
fn file_urls_and_unrelated_entries() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    let url = format!(
        "file://{}/app.js",
        fs::canonicalize(&fixture.0).unwrap().display()
    );
    let path = fixture.write(
        "node.json",
        &json!({"result":[
            {"url":"node:internal/bootstrap","functions":[]},
            {"url":url,"source":"abcd","functions":[]}
        ]})
        .to_string(),
    );
    let report = analyze(&fixture.0, &[path]).unwrap();
    assert_eq!(report.totals.unobserved_bytes, 4);
    assert!(report.warnings.iter().any(|w| w.contains("node:internal")));
}

#[test]
fn detail_spans_partition_every_bundle_and_source() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/recorded");
    let report = analyze(
        &dir,
        &[
            dir.join("initial.coverage.json"),
            dir.join("interaction.coverage.json"),
        ],
    )
    .unwrap();
    assert_eq!(report.totals.bytes, 293);
    assert_eq!(report.totals.observed_bytes, 208);
    for bundle in report.bundles {
        let mut cursor = 0;
        for span in &bundle.spans {
            assert_eq!(span.start, cursor);
            assert!(span.end > span.start);
            assert!(bundle.generated_source.get(span.start..span.end).is_some());
            cursor = span.end;
        }
        assert_eq!(cursor, bundle.counts.bytes);
        for (index, source) in bundle.sources.iter().enumerate() {
            let spans = bundle
                .spans
                .iter()
                .filter(|s| s.source == index)
                .collect::<Vec<_>>();
            assert_eq!(
                spans.iter().map(|s| s.end - s.start).sum::<usize>(),
                source.counts.bytes
            );
            assert_eq!(
                spans
                    .iter()
                    .filter(|s| s.status == coldpath::Status::Observed)
                    .map(|s| s.end - s.start)
                    .sum::<usize>(),
                source.counts.observed_bytes
            );
        }
        assert!(
            bundle
                .verification
                .iter()
                .all(|v| v.source == "sha256" && v.source_map == "capture-bound")
        );
    }
}

#[test]
fn html_does_not_turn_source_into_markup() {
    let fixture = Fixture::new();
    let payload = "</script><script>globalThis.injected=true</script>🔥";
    fixture.write("app.js", payload);
    let report = analyze(&fixture.0, &[]).unwrap();
    let html = coldpath::report::html(&report).unwrap();
    assert!(!html.contains(payload));
    let data = html
        .split("id=\"report-data\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(data).unwrap();
    assert!(value["bundles"][0].get("generatedSource").is_none());
    assert!(value["bundles"][0].get("spans").is_none());
    let chunk = html
        .split("id=\"chunk-data-0\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let details: serde_json::Value = serde_json::from_str(chunk).unwrap();
    assert_eq!(details["generatedSource"], payload);
}

#[test]
fn filters_change_denominator_and_do_not_hide_missing_files() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("chunks")).unwrap();
    fixture.write("app.js", "abcd");
    fixture.write("chunks/lazy.js", "later");
    let coverage = fixture.coverage(
        "run.json",
        "abcd",
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    let mut options = coldpath::AnalyzeOptions::default();
    options.include.push("**/*.js".into());
    options.exclude.push("app.js".into());
    let report =
        coldpath::analyze_with_options(&fixture.0, std::slice::from_ref(&coverage), &options)
            .unwrap();
    assert_eq!(report.totals.bytes, 5);
    assert_eq!(report.totals.unmeasured_bytes, 5);
    assert_eq!(report.excluded_bundles, vec!["app.js"]);
    assert_eq!(
        report.bundles[0].spans[0].status,
        coldpath::Status::Unmeasured
    );
    fs::remove_file(fixture.0.join("app.js")).unwrap();
    assert!(
        coldpath::analyze_with_options(&fixture.0, &[coverage], &options)
            .unwrap_err()
            .to_string()
            .contains("missing from analysis root")
    );
    options.exclude.push("**/*.js".into());
    assert!(coldpath::analyze_with_options(&fixture.0, &[], &options).is_err());
    options.include = vec!["[".into()];
    assert!(coldpath::analyze_with_options(&fixture.0, &[], &options).is_err());
}

#[test]
fn ci_reports_are_written_even_when_budget_fails() {
    use std::process::Command;
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    let config = fixture.write("config.json", r#"{"include":["**/*.js"],"compression":true,"budgets":{"maxBytes":3,"maxUnmeasuredBytes":0}}"#);
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .args([
            "--dir",
            fixture.0.to_str().unwrap(),
            "--config",
            config.to_str().unwrap(),
            "--json",
            fixture.0.join("report.json").to_str().unwrap(),
            "--html",
            fixture.0.join("report.html").to_str().unwrap(),
            "--markdown",
            fixture.0.join("report.md").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["budgetFailures"].as_array().unwrap().len(), 2);
    assert!(report["compression"]["gzipBytes"].as_u64().unwrap() > 0);
    assert!(
        fs::read_to_string(fixture.0.join("report.md"))
            .unwrap()
            .contains("Budget failed")
    );
    assert!(fixture.0.join("report.html").exists());
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .args([
            "--dir",
            fixture.0.to_str().unwrap(),
            "--config",
            config.to_str().unwrap(),
            "--max-bytes",
            "4",
            "--max-unmeasured-bytes",
            "4",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
}

#[test]
fn budget_does_not_confuse_unmeasured_with_unobserved() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    let report = analyze(&fixture.0, &[]).unwrap();
    let config: coldpath::ci::Config =
        serde_json::from_str(r#"{"budgets":{"maxUnobservedBytes":0,"maxUnmeasuredBytes":0}}"#)
            .unwrap();
    let failures = config.budgets.check(&report);
    assert_eq!(failures.len(), 2);
    assert!(
        failures
            .iter()
            .any(|failure| failure.contains("cannot check"))
    );
    assert!(
        failures
            .iter()
            .any(|failure| failure.starts_with("unmeasured"))
    );
    assert!(serde_json::from_str::<coldpath::ci::Config>(r#"{"budgets":{"maxByte":4}}"#).is_err());
}

#[test]
fn summary_json_and_detailed_json_have_identical_counts() {
    use std::process::Command;
    let fixture = Fixture::new();
    fixture.write("app.js", "한🔥x");
    let mut totals = Vec::new();
    for details in [false, true] {
        let output = fixture.0.join("report.json");
        let mut command = Command::new(env!("CARGO_BIN_EXE_coldpath"));
        command.args([
            "--dir",
            fixture.0.to_str().unwrap(),
            "--json",
            output.to_str().unwrap(),
        ]);
        if details {
            command.arg("--details");
        }
        assert!(command.output().unwrap().status.success());
        let report: serde_json::Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        assert_eq!(report["details"], details);
        assert_eq!(report["bundles"][0].get("spans").is_some(), details);
        assert_eq!(
            report["bundles"][0].get("generatedSource").is_some(),
            details
        );
        totals.push(report["totals"].clone());
    }
    assert_eq!(totals[0], totals[1]);
}

#[test]
fn sparse_text_index_matches_every_utf8_and_utf16_boundary() {
    // Compare against independently enumerated char boundaries, including dense
    // Unicode, adjacent surrogate pairs, long ASCII stretches and all JS EOLs.
    for source in [
        String::new(),
        "ascii\r\nnext\nlast\r".into(),
        "é한🔥𝄞\u{2028}\u{2029}\r\nx".repeat(25),
        format!("{}🔥{}한", "a".repeat(10000), "b".repeat(10000)),
    ] {
        let index = TextIndex::new(&source);
        let mut boundaries = std::collections::BTreeMap::from([(0, 0)]);
        let mut units = 0;
        for (byte, ch) in source.char_indices() {
            units += ch.len_utf16();
            boundaries.insert(byte + ch.len_utf8(), units);
        }
        for byte in 0..=source.len() + 1 {
            assert_eq!(index.utf16(byte).ok(), boundaries.get(&byte).copied());
        }
        let reverse: std::collections::BTreeMap<_, _> =
            boundaries.into_iter().map(|(b, u)| (u, b)).collect();
        for unit in 0..=units + 1 {
            assert_eq!(index.byte(unit).ok(), reverse.get(&unit).copied());
        }
        assert_eq!(index.utf16_len(), units);
    }
}

#[test]
fn duplicate_mapping_positions_keep_the_last_source() {
    let map = br#"{"version":3,"sources":["a.js","b.js"],"names":[],"mappings":"AAAA,ACAA"}"#;
    let decoded = attribution::decode(map, &TextIndex::new("abcd"), 4).unwrap();
    assert_eq!(decoded.segments.len(), 1);
    assert_eq!(decoded.segments[0].source, "b.js");
    assert_eq!(decoded.segments[0].end, 4);
}

#[test]
fn cli_selects_files_globs_and_explicit_maps_and_exports_stdout() {
    use std::process::Command;
    let fixture = Fixture::new();
    fixture.write("a.js", "abcd");
    fixture.write("b.js", "xyz");
    fixture.write("other.cjs", "ignored");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&fixture.0)
            .args(args)
            .output()
            .unwrap()
    };
    let output = run(&["*.js", "--json", "-"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["totals"]["bytes"], 7);
    assert_eq!(report["bundles"].as_array().unwrap().len(), 2);
    let output = run(&["a.js", "a.js", "--tsv", "-"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "Source\tBytes\tObserved\tUnobserved\tUnmeasured\n[unmapped]\t4\t0\t0\t4\n"
    );
    fixture.write(
        "custom.map",
        r#"{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA"}"#,
    );
    let output = run(&["a.js", "custom.map", "--json", "-"]);
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["sources"][0]["source"], "src/a.ts");
    assert!(!run(&["nothing*.js", "--json", "-"]).status.success());
    assert!(run(&["--dir", ".", "a.js", "--json", "-"]).status.success());
    assert!(!run(&["a.js", "--json", "-", "--tsv", "-"]).status.success());
    assert!(!run(&["a.js", "b.js", "custom.map"]).status.success());
    let default_path = fixture.write("coldpath.html", "IMPORTANT");
    let output = run(&["a.js"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| *line == "Wrote coldpath.html")
            .count(),
        1
    );
    assert!(
        fs::read_to_string(&default_path)
            .unwrap()
            .contains("id=\"report-data\">")
    );
    for args in [
        vec!["a.js", "--treemap", "coldpath.html"],
        vec!["a.js", "--json", "-"],
    ] {
        let output = run(&args);
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("Wrote coldpath.html"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("Wrote coldpath.html"));
    }
    fs::remove_file(&default_path).unwrap();
    fs::create_dir(&default_path).unwrap();
    let output = run(&["a.js"]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Wrote coldpath.html"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Wrote coldpath.html"));
}

#[test]
fn cli_positional_coverage_uses_an_explicit_root_and_skips_unselected_siblings() {
    use std::process::Command;
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/assets")).unwrap();
    let source = ";".repeat(16);
    fixture.write("dist/assets/app.js", &source);
    fixture.write("dist/assets/lazy.js", &source);
    fixture.write(
        "coverage.json",
        &json!([
            {"url":"https://x/assets/app.js", "text":source, "ranges":[{"start":0,"end":5}]},
            {"url":"https://x/assets/lazy.js", "text":source, "ranges":[]}
        ])
        .to_string(),
    );
    let run = |selection: &[&str], prefix: &str| {
        let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&fixture.0)
            .args(selection)
            .args([
                "--coverage",
                "coverage.json",
                "--url-prefix",
                prefix,
                "--json",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let scanned = run(&["--dir", "dist"], "https://x/");
    let selected = run(&["dist/assets/*.js", "--dir", "dist"], "https://x/");
    assert_eq!(scanned, selected);
    assert_eq!(selected["totals"]["observedBytes"], 5);
    assert_eq!(selected["totals"]["unobservedBytes"], 27);
    for (args, prefix, path, sibling) in [
        (
            vec!["dist/assets/app.js", "--dir", "dist"],
            "https://x/",
            "assets/app.js",
            "assets/lazy.js",
        ),
        (
            vec!["dist/assets/app.js"],
            "https://x/assets/",
            "app.js",
            "lazy.js",
        ),
    ] {
        let report = run(&args, prefix);
        assert_eq!(report["bundles"].as_array().unwrap().len(), 1);
        assert_eq!(report["bundles"][0]["path"], path);
        assert_eq!(report["totals"]["bytes"], 16);
        assert_eq!(report["totals"]["observedBytes"], 5);
        assert_eq!(report["totals"]["unobservedBytes"], 11);
        assert_eq!(report["totals"]["unmeasuredBytes"], 0);
        assert!(report["warnings"].as_array().unwrap().iter().any(|w| {
            let w = w.as_str().unwrap();
            w.contains("skipped coverage for unselected file") && w.contains(sibling)
        }));
    }
}

#[test]
fn cli_positional_filters_and_budgets_stay_relative_to_explicit_root() {
    use std::process::Command;
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/assets")).unwrap();
    fixture.write("dist/assets/app.js", "abcd");
    fixture.write("dist/assets/lazy.js", "later");
    fixture.write(
        "ci.json",
        r#"{"include":["assets/*.js"],"exclude":["assets/lazy.js"],"budgets":{"maxBytes":4}}"#,
    );
    let run = |selection: &[&str], budget: &str| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&fixture.0)
            .args(selection)
            .args([
                "--dir",
                "dist",
                "--config",
                "ci.json",
                "--max-bytes",
                budget,
                "--json",
                "-",
            ])
            .output()
            .unwrap()
    };
    let scanned = run(&[], "4");
    let selected = run(&["dist/assets/*.js"], "4");
    assert!(scanned.status.success());
    assert!(
        selected.status.success(),
        "{}",
        String::from_utf8_lossy(&selected.stderr)
    );
    assert_eq!(scanned.stdout, selected.stdout);
    let report: serde_json::Value = serde_json::from_slice(&selected.stdout).unwrap();
    assert_eq!(report["bundles"][0]["path"], "assets/app.js");
    assert_eq!(report["excludedBundles"], json!(["assets/lazy.js"]));
    assert_eq!(report["totals"]["bytes"], 4);
    let output = run(&["dist/assets/*.js"], "3");
    assert_eq!(output.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["budgetFailures"],
        json!(["generated bytes: 4 exceeds budget 3"])
    );
}

#[test]
fn selection_resolves_globs_deduplicates_files_and_binds_maps_under_the_root() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/assets")).unwrap();
    fixture.write("dist/assets/app.js", "abcd");
    fixture.write("dist/assets/lazy.js", "later");
    let map = r#"{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA"}"#;
    fixture.write("dist/assets/app.js.map", map);
    fixture.write("dist/assets/lazy.js.map", map);
    let patterns = vec![
        fixture
            .0
            .join("dist/assets/*.js*")
            .to_string_lossy()
            .into_owned(),
        fixture
            .0
            .join("dist/../dist/assets/app.js")
            .to_string_lossy()
            .into_owned(),
    ];
    let dist = fs::canonicalize(fixture.0.join("dist")).unwrap();
    for explicit in [None, Some(dist.as_path())] {
        let selection = coldpath::selection::resolve(&patterns, explicit).unwrap();
        let prefix = if explicit.is_some() { "assets/" } else { "" };
        assert_eq!(
            selection.root,
            if explicit.is_some() {
                dist.clone()
            } else {
                dist.join("assets")
            }
        );
        let expected = [format!("{prefix}app.js"), format!("{prefix}lazy.js")];
        assert_eq!(
            selection.files,
            expected.iter().map(PathBuf::from).collect::<Vec<_>>()
        );
        assert_eq!(selection.maps.keys().cloned().collect::<Vec<_>>(), expected);
        let options = coldpath::AnalyzeOptions {
            files: Some(selection.files),
            maps: selection.maps,
            ..Default::default()
        };
        let report = coldpath::analyze_with_options(&selection.root, &[], &options).unwrap();
        assert_eq!(report.totals.bytes, 9);
        assert_eq!(report.bundles[0].mapped_bytes, 4);
        assert_eq!(report.bundles[1].mapped_bytes, 5);
    }
}

#[test]
fn selection_allows_external_maps_but_rejects_scripts_outside_explicit_root() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/assets")).unwrap();
    let script = fixture.write("dist/assets/app[entry].js", "abcd");
    let map = fixture.write(
        "external.map",
        r#"{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}"#,
    );
    let root = fixture.0.join("dist");
    let patterns = vec![
        script.to_string_lossy().into_owned(),
        map.to_string_lossy().into_owned(),
    ];
    let selection = coldpath::selection::resolve(&patterns, Some(&root)).unwrap();
    assert_eq!(selection.files, vec![PathBuf::from("assets/app[entry].js")]);
    assert_eq!(
        selection.maps["assets/app[entry].js"],
        fs::canonicalize(map).unwrap()
    );
    let outside = fixture.write("outside.js", "outside");
    let error =
        coldpath::selection::resolve(&[outside.to_string_lossy().into_owned()], Some(&root))
            .unwrap_err();
    assert!(error.to_string().contains("outside analysis root"));
    let error = coldpath::selection::resolve(&patterns, Some(&script)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("analysis root is not a directory")
    );
    assert!(coldpath::selection::resolve(&[], Some(&root)).is_err());
    assert!(
        coldpath::selection::resolve(
            &[fixture.0.join("missing*.js").to_string_lossy().into_owned()],
            Some(&root)
        )
        .is_err()
    );
}

#[test]
fn selected_coverage_preserves_missing_file_and_verification_errors() {
    let fixture = Fixture::new();
    fixture.write("app.js", "abcd");
    fixture.write("lazy.js", "later");
    let options = coldpath::AnalyzeOptions {
        files: Some(vec![PathBuf::from("app.js")]),
        ..Default::default()
    };
    let mut envelope = json!({"schemaVersion":1,"scenario":"selected","scripts":[
        {"path":"app.js","sha256":sha256(b"abcd"),"sourceMapSha256":null,"functions":[
            {"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":4,"count":1}]}
        ]},
        {"path":"lazy.js","sha256":"not-verified-when-unselected","sourceMapSha256":null,"functions":[]}
    ]});
    let coverage = fixture.write("coverage.json", &envelope.to_string());
    let analyze_selected =
        || coldpath::analyze_with_options(&fixture.0, std::slice::from_ref(&coverage), &options);
    let report = analyze_selected().unwrap();
    assert_eq!(report.totals.observed_bytes, 4);
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w == "skipped coverage for unselected file: lazy.js")
    );

    envelope["scripts"][0]["sha256"] = json!(sha256(b"stale"));
    fixture.write("coverage.json", &envelope.to_string());
    assert!(
        analyze_selected()
            .unwrap_err()
            .to_string()
            .contains("coverage SHA-256 mismatch")
    );
    envelope["scripts"][0]["sha256"] = json!(sha256(b"abcd"));
    envelope["scripts"][0]["functions"][0]["ranges"][0]["endOffset"] = json!(100);
    fixture.write("coverage.json", &envelope.to_string());
    assert!(
        analyze_selected()
            .unwrap_err()
            .to_string()
            .contains("normalize coverage for app.js")
    );
    envelope["scripts"][0]["functions"][0]["ranges"][0]["endOffset"] = json!(4);
    fixture.write("coverage.json", &envelope.to_string());
    fs::remove_file(fixture.0.join("lazy.js")).unwrap();
    let error = analyze_selected().unwrap_err().to_string();
    assert!(error.contains("missing from analysis root"));
    assert!(error.contains("lazy.js"));
}

#[test]
fn positional_coverage_with_wrong_prefix_reports_the_analysis_root() {
    use std::process::Command;
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("dist/assets")).unwrap();
    fixture.write("dist/assets/app.js", "abcd");
    fixture.write(
        "coverage.json",
        &json!([
            {"url":"https://x/assets/app.js","text":"abcd","ranges":[{"start":0,"end":4}]}
        ])
        .to_string(),
    );
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&fixture.0)
        .args([
            "dist/assets/*.js",
            "--coverage",
            "coverage.json",
            "--url-prefix",
            "https://x/",
            "--json",
            "-",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("missing from analysis root"));
    assert!(
        stderr.contains(
            fs::canonicalize(fixture.0.join("dist/assets"))
                .unwrap()
                .to_str()
                .unwrap()
        )
    );
    assert!(stderr.contains("assets/app.js"));
    assert!(stderr.contains("check --dir, --url-prefix, or --script-map"));
}

#[cfg(unix)]
#[test]
fn explicit_selection_rejects_symlinks_outside_the_analysis_root() {
    let fixture = Fixture::new();
    let root = fixture.0.join("dist");
    fs::create_dir(&root).unwrap();
    let outside = fixture.write("outside.js", "outside");
    let link = root.join("linked.js");
    std::os::unix::fs::symlink(outside, &link).unwrap();
    let error = coldpath::selection::resolve(&[link.to_string_lossy().into_owned()], Some(&root))
        .unwrap_err();
    assert!(error.to_string().contains("outside analysis root"));
    let options = coldpath::AnalyzeOptions {
        files: Some(vec![PathBuf::from("linked.js")]),
        ..Default::default()
    };
    let error = coldpath::analyze_with_options(&root, &[], &options).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("input file escapes analysis root")
    );
}

#[test]
fn compact_treemap_has_no_code_payload_and_escapes_source_paths() {
    let fixture = Fixture::new();
    fixture.write("app.js", "const secret = 42;");
    let source = "</script><script>globalThis.injected=true</script>";
    fixture.write("app.js.map", &json!({"version":3,"sources":[source],"sourcesContent":["private original content"],"names":[],"mappings":"AAAA"}).to_string());
    let report = analyze(&fixture.0, &[]).unwrap();
    let html = coldpath::report::treemap(&report).unwrap();
    assert!(!html.contains(source));
    assert!(!html.contains("const secret = 42"));
    assert!(!html.contains("private original content"));
    assert!(!html.contains("chunk-data-"));
    let json = html
        .split("id=\"report-data\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let data: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(data["bundles"][0]["sources"][0]["source"], source);
    assert_eq!(data["totals"]["bytes"], 18);
}
