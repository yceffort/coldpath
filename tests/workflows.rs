use coldpath::{AnalyzeOptions, Status, analyze_with_options, ci, graph, sha256};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "coldpath-workflows-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, path: &str, text: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::write(&path, text).unwrap();
        path
    }
    fn map(&self, sources: &[&str]) {
        self.write("app.js.map", &json!({"version":3,"sources":sources,"names":[],"mappings":sources.iter().enumerate().map(|(i,_)| if i==0 {"AAAA"} else {"ICAA"}).collect::<Vec<_>>().join(",")}).to_string());
    }
    fn coverage(&self, name: &str, source: &str, ranges: Value) -> PathBuf {
        self.write(name, &json!({"schemaVersion":1,"scenario":name,"scripts":[{"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":fs::read(self.0.join("app.js.map")).ok().map(|m|sha256(&m)),"functions":if ranges.as_array().unwrap().is_empty() { json!([]) } else {json!([{"isBlockCoverage":true,"ranges":ranges}])}}]}).to_string())
    }
    fn empty(&self, name: &str) -> PathBuf {
        self.write(
            name,
            &json!({"schemaVersion":1,"scenario":name,"scripts":[]}).to_string(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ordered_observation_and_scenario_spans_preserve_unicode_and_overlap() {
    let f = Fixture::new();
    let source = "한🔥xyz";
    f.write("app.js", source);
    f.map(&["src/app.ts"]);
    let initial = f.coverage(
        "initial",
        source,
        json!([{"startOffset":0,"endOffset":3,"count":1}]),
    );
    let open = f.coverage(
        "open",
        source,
        json!([{"startOffset":1,"endOffset":4,"count":1}]),
    );
    let search = f.coverage(
        "search",
        source,
        json!([{"startOffset":3,"endOffset":6,"count":1}]),
    );
    let files = [search, initial, open];
    let mut options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        scenario_order: vec!["initial".into(), "open".into(), "search".into()],
        source_compression: true,
        ..Default::default()
    };
    let mut report = analyze_with_options(&f.0, &files, &options).unwrap();
    let b = &report.bundles[0];
    let s = &b.sources[0];
    assert_eq!(
        s.first_observed
            .iter()
            .map(|p| (&*p.scenario, p.bytes, p.earlier_unmeasured))
            .collect::<Vec<_>>(),
        [
            ("initial", 7, false),
            ("open", 1, false),
            ("search", 2, false)
        ]
    );
    assert_eq!(s.counts.observed_bytes, 10);
    for (scenario, observed) in [("initial", 7), ("open", 5), ("search", 3)] {
        let spans = &b.scenario_spans[scenario];
        assert_eq!(
            spans.iter().map(|s| s.end - s.start).sum::<usize>(),
            source.len()
        );
        assert_eq!(
            spans
                .iter()
                .filter(|s| s.status == Status::Observed)
                .map(|s| s.end - s.start)
                .sum::<usize>(),
            observed
        );
        for span in spans {
            assert_eq!(
                source[..span.start].encode_utf16().count(),
                span.start_utf16
            );
            assert_eq!(source[..span.end].encode_utf16().count(), span.end_utf16);
        }
    }
    assert_eq!(
        s.estimated_compression.as_ref().unwrap().gzip_bytes,
        ci::compress(source.as_bytes()).unwrap().gzip_bytes
    );
    let candidate = &report.scenario_reports[2].interaction_candidates[0];
    assert_eq!(candidate.interaction_only_bytes, 3); // Difference from initial, not preceding interaction.
    assert_eq!(
        candidate
            .estimated_deferrable_compression
            .as_ref()
            .unwrap()
            .gzip_bytes,
        ci::compress(b"xyz").unwrap().gzip_bytes
    );
    let serialized = serde_json::to_value(&report).unwrap();
    assert!(serialized["packages"][0]["estimatedCompression"]["gzipBytes"].is_number());
    report.strip_details();
    assert!(report.bundles[0].scenario_spans.is_empty());
    options.scenario_order.clear();
    let implicit = analyze_with_options(&f.0, &files, &options).unwrap();
    assert_eq!(implicit.scenarios, ["initial", "search", "open"]);
    assert_eq!(implicit.bundles[0].sources[0].first_observed.len(), 2);
    let comparison =
        coldpath::baseline::compare(&implicit, &serde_json::to_vec(&report).unwrap()).unwrap();
    assert!(
        !comparison
            .warnings
            .iter()
            .any(|w| w.contains("Scenario sets differ"))
    );
    for bad in [
        vec!["initial", "open"],
        vec!["initial", "open", "open"],
        vec!["open", "initial", "search"],
    ] {
        options.scenario_order = bad.into_iter().map(String::from).collect();
        assert!(analyze_with_options(&f.0, &files, &options).is_err());
    }
}

#[test]
fn missing_earlier_measurements_never_become_deferral_or_removal_evidence() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.map(&["src/lazy.js"]);
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        source_compression: true,
        ..Default::default()
    };
    let report = analyze_with_options(
        &f.0,
        &[
            f.empty("initial"),
            f.coverage(
                "later",
                "abcd",
                json!([{"startOffset":0,"endOffset":2,"count":1}]),
            ),
        ],
        &options,
    )
    .unwrap();
    assert!(report.bundles[0].sources[0].first_observed[0].earlier_unmeasured);
    assert!(
        report.bundles[0].scenario_spans["initial"]
            .iter()
            .all(|s| s.status == Status::Unmeasured)
    );
    let candidate = &report.scenario_reports[1].interaction_candidates[0];
    assert_eq!(candidate.interaction_only_bytes, 0);
    assert_eq!(candidate.initial_unmeasured_observed_bytes, 2);
    assert!(candidate.estimated_deferrable_compression.is_none());
    assert_eq!(report.recommendations[0].kind, "measure-initial");
    assert!(report.recommendations[0].estimated_compression.is_none());
    let report = analyze_with_options(
        &f.0,
        &[f.empty("initial"), f.coverage("later", "abcd", json!([]))],
        &options,
    )
    .unwrap();
    assert!(report.recommendations.is_empty());
}

#[test]
fn a_copy_in_a_bundle_the_initial_scenario_did_not_load_does_not_require_measuring() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.map(&["src/lazy.js"]);
    // Another route's chunk with a copy of the same module, never loaded in these scenarios.
    f.write("other.js", "wxyz");
    f.write(
        "other.js.map",
        &json!({"version":3,"sources":["src/lazy.js"],"names":[],"mappings":"AAAA"}).to_string(),
    );
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        ..Default::default()
    };
    let report = analyze_with_options(
        &f.0,
        &[
            f.coverage(
                "initial",
                "abcd",
                json!([{"startOffset":0,"endOffset":4,"count":0}]),
            ),
            f.coverage(
                "later",
                "abcd",
                json!([{"startOffset":0,"endOffset":2,"count":1}]),
            ),
        ],
        &options,
    )
    .unwrap();
    let candidate = &report.scenario_reports[1].interaction_candidates[0];
    assert_eq!(candidate.interaction_only_bytes, 2);
    assert_eq!(candidate.initial_unmeasured_observed_bytes, 0);
    assert_eq!(report.recommendations[0].kind, "inspect-imports");
}

fn evidence_graph() -> Value {
    json!({"schemaVersion":1,"bundler":"webpack","modules":[
        {"id":"entry","source":"src/main.js","entry":true},{"id":"middle","source":"src/middle.js"},
        {"id":"a","source":"src/a.js"},{"id":"b","source":"src/b.js"}],"edges":[
        {"from":"entry","to":"a","kind":"dynamic","location":{"line":1,"column":1}},
        {"from":"entry","to":"middle","kind":"static","location":{"line":2,"column":1}},
        {"from":"middle","to":"a","kind":"static","location":{"line":12,"column":3},"locationEvidence":"webpack-stats"},
        {"from":"middle","to":"b","kind":"static","location":{"line":13,"column":1}},
        {"from":"a","to":"middle","kind":"static"}]})
}

#[test]
fn graph_recommendations_prefer_static_evidence_and_distinguish_partial_initial_use() {
    let f = Fixture::new();
    let source = "abcdefghijkl";
    f.write("app.js", source);
    f.map(&[
        "webpack://app/./src/a.js",
        "turbopack:///[project]/src/b.js",
        "src/never.js",
    ]);
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        source_compression: true,
        ..Default::default()
    };
    let files = [
        f.coverage(
            "initial",
            source,
            json!([{"startOffset":0,"endOffset":2,"count":1}]),
        ),
        f.coverage(
            "open",
            source,
            json!([{"startOffset":0,"endOffset":8,"count":1}]),
        ),
    ];
    let mut report = analyze_with_options(&f.0, &files, &options).unwrap();
    let data = evidence_graph();
    graph::attach(&mut report, &serde_json::to_vec(&data).unwrap(), &f.0, &f.0).unwrap();
    let path = report
        .import_paths
        .as_ref()
        .unwrap()
        .iter()
        .find(|p| p.source == "src/a.js")
        .unwrap();
    assert_eq!(
        path.path.as_ref().unwrap(),
        &["src/main.js", "src/middle.js", "src/a.js"]
    );
    assert_eq!(path.edges[1].location.as_ref().unwrap().line, 12);
    assert_eq!(
        path.resolved_source.as_deref(),
        Some("webpack://app/src/a.js")
    );
    let recommendations = &report.recommendations;
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "split-review" && r.bytes == 2 && r.source.ends_with("/a.js"))
    );
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "defer-review" && r.bytes == 4 && r.source.ends_with("/b.js"))
    );
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "removal-review" && r.source == "src/never.js")
    );
    let md = ci::markdown(&report);
    assert!(md.contains("src/middle.js:12:3"));
    assert!(md.contains("not additive transfer savings"));
    // One table per action kind, so small kinds are not crowded out by large ones (#53).
    assert!(md.contains("3 actions: 1 split-review, 1 defer-review, 1 removal-review."));
    let headings = ["split-review", "defer-review", "removal-review"].map(|kind| {
        md.find(&format!(
            "\n### {kind}: 1 on application code, 0 on dependencies\n"
        ))
    });
    assert!(headings.iter().all(Option::is_some), "{md}");
    assert!(headings.is_sorted());
    assert!(recommendations.iter().all(|r| r.package == "[application]"));
    let mut dynamic = data.clone();
    dynamic["edges"][1]["kind"] = json!("dynamic");
    graph::attach(
        &mut report,
        &serde_json::to_vec(&dynamic).unwrap(),
        &f.0,
        &f.0,
    )
    .unwrap();
    assert!(
        report
            .recommendations
            .iter()
            .any(|r| r.kind == "dynamic-boundary-review")
    );
    // A require() that runs whenever its importer evaluates loads the target like a static import (#46).
    let action = |report: &coldpath::Report, file: &str| {
        report
            .recommendations
            .iter()
            .find(|r| r.source.ends_with(file))
            .map(|r| r.kind)
    };
    let mut required = data.clone();
    for edge in [2, 3] {
        required["edges"][edge]["kind"] = json!("require");
        required["edges"][edge]["topLevel"] = json!(true);
    }
    graph::attach(
        &mut report,
        &serde_json::to_vec(&required).unwrap(),
        &f.0,
        &f.0,
    )
    .unwrap();
    let path = report
        .import_paths
        .as_ref()
        .unwrap()
        .iter()
        .find(|p| p.source == "src/a.js")
        .unwrap();
    assert_eq!(
        path.path.as_ref().unwrap(),
        &["src/main.js", "src/middle.js", "src/a.js"]
    );
    assert_eq!(path.edges[1].top_level, Some(true));
    assert_eq!(action(&report, "/a.js"), Some("split-review"));
    assert_eq!(action(&report, "/b.js"), Some("defer-review"));
    // Without that evidence the call may run later, so the shorter dynamic path and the fallback remain.
    required["edges"][2]["topLevel"] = json!(false);
    required["edges"][3]
        .as_object_mut()
        .unwrap()
        .remove("topLevel");
    graph::attach(
        &mut report,
        &serde_json::to_vec(&required).unwrap(),
        &f.0,
        &f.0,
    )
    .unwrap();
    assert_eq!(action(&report, "/a.js"), Some("dynamic-boundary-review"));
    assert_eq!(action(&report, "/b.js"), Some("inspect-imports"));
    let mut bad = data.clone();
    bad["edges"][0]["to"] = json!("missing");
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
    let mut bad = data.clone();
    bad["edges"][0]["location"]["column"] = json!(0);
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
    let mut bad = data;
    bad["schemaVersion"] = json!(99);
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
}

#[test]
fn unmapped_factory_starts_do_not_count_as_previous_module_execution() {
    // Turbopack emits no mapping between factories, so heavy.js's last mapping runs into the next factory (#48).
    let f = Fixture::new();
    let source = "self.T=[1,(e,t,r)=>{t.exports={f:()=>0}},2,e=>{var a=e.i(1)}];";
    f.write("app.js", source);
    f.write(
        "app.js.map",
        &json!({"version":3,"sources":["heavy.js","next.js"],"names":[],"mappings":"oBAAA,aAAK,cCAL"})
            .to_string(),
    );
    let range = |code: &str, count: u64| {
        let start = source.find(code).unwrap();
        json!({"startOffset":start,"endOffset":start + code.len(),"count":count})
    };
    let functions = json!([
        {"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":source.len(),"count":1}]},
        {"isBlockCoverage":true,"ranges":[range("(e,t,r)=>{t.exports={f:()=>0}}", 1)]},
        {"isBlockCoverage":true,"ranges":[range("()=>0", 0)]},
        {"isBlockCoverage":true,"ranges":[range("e=>{var a=e.i(1)}", 1)]},
    ]);
    let file = f.write("initial", &json!({"schemaVersion":1,"scenario":"initial","scripts":[{"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":sha256(&fs::read(f.0.join("app.js.map")).unwrap()),"functions":functions}]}).to_string());
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        ..Default::default()
    };
    let report = analyze_with_options(&f.0, &[file], &options).unwrap();
    let heavy = &report.initial_execution["heavy.js"];
    assert_eq!(heavy.function_bytes, 0);
    assert_eq!(heavy.top_level, b"t.exports={f:}}");
    let next = &report.initial_execution["next.js"];
    assert_eq!(next.function_bytes, 0);
    assert_eq!(next.top_level, b"var a=e.i(1)}");
}

#[test]
fn unobserved_budget_fails_without_selected_measurements_but_accepts_measured_zero_use() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("other.js", "unused");
    f.empty("empty.json");
    f.write(
        "other.json",
        &json!([{"url":"other.js","text":"unused","ranges":[]}]).to_string(),
    );
    f.coverage("measured.json", "abcd", json!([]));
    let run = |coverage: Option<&str>, budget: &str| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_coldpath"));
        cmd.current_dir(&f.0)
            .args(["app.js", "--max-unobserved-bytes", budget, "--json", "-"]);
        if let Some(path) = coverage {
            cmd.args(["--coverage", path]);
        }
        cmd.output().unwrap()
    };
    for coverage in [None, Some("empty.json"), Some("other.json")] {
        let output = run(coverage, "100");
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            report["budgetFailures"][0]
                .as_str()
                .unwrap()
                .contains("without measured coverage")
        );
    }
    assert!(run(Some("measured.json"), "4").status.success());
    assert_eq!(run(Some("measured.json"), "0").status.code(), Some(2));
}

#[test]
fn graph_source_hashes_reject_stale_locations_and_keep_compact_exports_compact() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("app.js.map", &json!({"version":3,"sources":["src/a.js"],"sourcesContent":["ORIGINAL_SNAPSHOT"],"names":[],"mappings":"AAAA"}).to_string());
    let data = json!({"schemaVersion":1,"bundler":"rollup","modules":[
        {"id":"a","source":"src/a.js","entry":true,"sourceSha256":sha256(b"ORIGINAL_SNAPSHOT")},
        {"id":"b","source":"src/b.js"}],"edges":[
        {"from":"a","to":"b","kind":"static","location":{"line":1,"column":1},"locationEvidence":"plugin-input"}]});
    f.write("graph.json", &data.to_string());
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args([
                "--dir",
                ".",
                "--graph",
                "graph.json",
                "--graph-root",
                ".",
                "--json",
                "-",
                "--treemap",
                "compact.html",
                "--why",
                "src/a.js",
            ])
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["details"], false);
    assert!(report["bundles"][0]["generatedSource"].is_null());
    assert!(report["bundles"][0]["scenarioSpans"].is_null());
    assert!(
        report["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("1 matched sourcesContent"))
    );
    assert!(
        !fs::read_to_string(f.0.join("compact.html"))
            .unwrap()
            .contains("ORIGINAL_SNAPSHOT")
    );
    let mut stale = data.clone();
    stale["modules"][0]["sourceSha256"] = json!(sha256(b"OLD_SOURCE"));
    f.write("graph.json", &stale.to_string());
    let output = run();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("graph source snapshot differs"));
    // Babel-style loaders replace sourcesContent; the file on disk still matches the graph.
    fs::create_dir_all(f.0.join("src")).unwrap();
    let on_disk = f.write("src/a.js", "OLD_SOURCE");
    let output = run();
    fs::remove_file(on_disk).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["warnings"].as_array().unwrap().iter().any(|w| {
        let w = w.as_str().unwrap();
        w.contains("0 matched sourcesContent") && w.contains("1 matched only the file on disk")
    }));
    let mut report = coldpath::analyze(&f.0, &[]).unwrap();
    let mut no_entry = data.clone();
    no_entry["modules"][0]["entry"] = json!(false);
    assert!(
        graph::attach(
            &mut report,
            &serde_json::to_vec(&no_entry).unwrap(),
            &f.0,
            &f.0
        )
        .is_err()
    );
    let mut duplicate = data;
    duplicate["modules"][1]["id"] = json!("a");
    assert!(
        graph::attach(
            &mut report,
            &serde_json::to_vec(&duplicate).unwrap(),
            &f.0,
            &f.0
        )
        .is_err()
    );
}

#[test]
fn why_accepts_a_unique_path_suffix_and_lists_candidates_otherwise() {
    let f = Fixture::new();
    // A pnpm monorepo app: packages live in a store two levels above the graph root.
    let pnpm =
        |version: &str| format!("../../node_modules/.pnpm/pkg@{version}/node_modules/pkg/index.js");
    f.write("app.js", "abcdefghijkl");
    f.map(&["src/main.js", &pnpm("1.0.0"), &pnpm("2.0.0")]);
    f.write(
        "graph.json",
        &json!({"schemaVersion":1,"bundler":"webpack","modules":[
        {"id":"main","source":"src/main.js","entry":true},
        {"id":"one","source":pnpm("1.0.0")},{"id":"two","source":pnpm("2.0.0")}],"edges":[
        {"from":"main","to":"one","kind":"static"},{"from":"main","to":"two","kind":"dynamic"}]})
        .to_string(),
    );
    let why = |query: &str| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args([
                "--dir",
                ".",
                "--graph",
                "graph.json",
                "--graph-root",
                ".",
                "--why",
                query,
            ])
            .output()
            .unwrap()
    };
    let output = why("pkg@2.0.0/node_modules/pkg/index.js");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains(&format!("src/main.js --Dynamic--> {}", pnpm("2.0.0")))
    );
    // Ambiguous suffixes and unmatched paths list the graph inputs to pass instead.
    for query in ["node_modules/pkg/index.js", "lib/index.js"] {
        let output = why(query);
        assert_eq!(output.status.code(), Some(1));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&pnpm("1.0.0")) && stderr.contains(&pnpm("2.0.0")),
            "{stderr}"
        );
    }
}

#[test]
fn label_evidence_is_checked_per_copy_of_a_differently_minified_source() {
    let f = Fixture::new();
    for (file, text) in [("a.js", "var q=1;"), ("b.js", "var z=1;")] {
        f.write(file, text);
        f.write(&format!("{file}.map"), &json!({"version":3,"sources":["m/shared.js"],"sourcesContent":[text],"names":[],"mappings":"AAAA"}).to_string());
    }
    let mut report = analyze_with_options(&f.0, &[], &AnalyzeOptions::default()).unwrap();
    let labels = json!({"schemaVersion":1,"sources":{"m/shared.js":{"name":"n","evidence":["var q","var z","nowhere"]}}});
    coldpath::annotations::attach_labels(&mut report, labels.to_string().as_bytes()).unwrap();
    let value = serde_json::to_value(&report).unwrap();
    let copy = |path: &str| {
        value["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["path"] == path)
            .unwrap()["sources"][0]["label"]["evidence"]
            .clone()
    };
    assert_eq!(copy("a.js"), json!(["var q"]));
    assert_eq!(copy("b.js"), json!(["var z"]));
    assert_eq!(
        value["sources"][0]["label"]["evidence"],
        json!(["var q", "var z"])
    );
    assert!(
        value["warnings"]
            .to_string()
            .contains("m/shared.js: dropped 1 label evidence strings not found in any copy")
    );
}

#[test]
fn labels_and_loading_attach_without_changing_counts_and_drop_absent_evidence() {
    let f = Fixture::new();
    let source = "var a=1;var b=2;";
    f.write("app.js", source);
    f.write("app.js.map", &json!({"version":3,"sources":["m/1.js","m/2.js"],"sourcesContent":["var a=1;","var b=2;"],"names":[],"mappings":"AAAA,QCAA"}).to_string());
    let mut report = analyze_with_options(&f.0, &[], &AnalyzeOptions::default()).unwrap();
    let before = serde_json::to_value(&report.totals).unwrap();
    let labels = json!({"schemaVersion":1,"generator":{"provider":"test","model":"m","mode":"identify"},"sources":{
        "m/1.js":{"name":"first","shortName":"first","kind":"app","summary":"s","reasoning":"r","evidence":["var a=1","not in source"]},
        "m/2.js":{"summary":"only a summary","contents":[{"name":"p","kind":"package","evidence":["var b=2"]},{"name":"q","evidence":["missing"]}]},
        "m/missing.js":{"summary":"x"}}});
    coldpath::annotations::attach_labels(&mut report, labels.to_string().as_bytes()).unwrap();
    let loading = json!({"schemaVersion":1,"bundles":{"app.js":{"load":"html","initiator":"parser","startMs":5},"gone.js":{"load":"dynamic"}}});
    coldpath::annotations::attach_loading(&mut report, loading.to_string().as_bytes()).unwrap();
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["totals"], before);
    let first = value["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["source"] == "m/1.js")
        .unwrap();
    assert_eq!(first["label"]["evidence"], json!(["var a=1"]));
    assert_eq!(value["bundles"][0]["sources"][0]["label"]["name"], "first");
    assert_eq!(
        value["bundles"][0]["sources"][1]["label"],
        json!({"summary":"only a summary","contents":[{"name":"p","kind":"package","evidence":["var b=2"]}]})
    );
    assert_eq!(
        value["bundles"][0]["loading"],
        json!({"load":"html","initiator":"parser","startMs":5})
    );
    assert_eq!(value["labelGenerator"]["model"], "m");
    let warnings = value["warnings"].to_string();
    assert!(warnings.contains("m/1.js: dropped 1 label evidence"));
    assert!(warnings.contains("m/2.js: dropped 1 label evidence"));
    assert!(warnings.contains("1 --labels entries match no report source"));
    assert!(warnings.contains("1 --loading entries match no analyzed bundle"));
    let bad = json!({"schemaVersion":1,"bundles":{"app.js":{"load":"prefetch"}}});
    assert!(
        coldpath::annotations::attach_loading(&mut report, bad.to_string().as_bytes()).is_err()
    );
    let future = json!({"schemaVersion":2,"sources":{}});
    assert!(
        coldpath::annotations::attach_labels(&mut report, future.to_string().as_bytes()).is_err()
    );
    let extra = json!({"schemaVersion":1,"sources":{"m/1.js":{"confidence":"high"}}});
    assert!(
        coldpath::annotations::attach_labels(&mut report, extra.to_string().as_bytes()).is_err()
    );
}

#[test]
fn evidence_replays_offline_after_the_workspace_is_gone() {
    let f = Fixture::new();
    let run = |cwd: &PathBuf, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap()
    };
    let work = f.0.join("work");
    fs::create_dir_all(work.join("site/files")).unwrap();
    fs::create_dir_all(work.join("site/maps")).unwrap();
    let source = "ab;cd";
    fs::write(work.join("site/files/app.js"), source).unwrap();
    // Outside the analysis root, as snapshot binds unfetchable maps.
    fs::write(
        work.join("site/maps/app.map"),
        json!({"version":3,"sources":["../src/a.ts","../src/b.ts"],"names":[],"mappings":"AAAA,GCAA"}).to_string(),
    )
    .unwrap();
    // Node coverage names scripts by absolute file:// URL; the factory never ran.
    let url = format!(
        "file://{}/app.js",
        fs::canonicalize(work.join("site/files")).unwrap().display()
    );
    let coverage = json!({"result":[{"url":url,"source":source,"functions":[
        {"functionName":"","isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":5,"count":1}]},
        {"functionName":"factory","isBlockCoverage":true,"ranges":[{"startOffset":3,"endOffset":5,"count":0}]}
    ]}]})
    .to_string();
    fs::write(work.join("node.json"), &coverage).unwrap();
    let exported = run(
        &work,
        &[
            "--dir",
            "site/files",
            "--coverage",
            "node.json",
            "--map",
            "app.js=site/maps/app.map",
            "--export",
            "evidence",
            "--json",
            "original.json",
        ],
    );
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let positional = run(
        &work,
        &[
            "site/files/app.js",
            "--export",
            "static",
            "--json",
            "static.json",
        ],
    );
    assert!(
        positional.status.success(),
        "{}",
        String::from_utf8_lossy(&positional.stderr)
    );

    let offline = f.0.join("offline");
    fs::create_dir_all(&offline).unwrap();
    for name in ["evidence", "static"] {
        fs::rename(work.join(name), offline.join(name)).unwrap();
    }
    let original = fs::read(work.join("original.json")).unwrap();
    let totals: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        totals["totals"]["unobservedBytes"], 2,
        "file:// coverage must match"
    );
    let original_static = fs::read(work.join("static.json")).unwrap();
    fs::remove_dir_all(&work).unwrap();

    let evidence = offline.join("evidence");
    let manifest: Value =
        serde_json::from_slice(&fs::read(evidence.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["kind"], "full");
    assert_eq!(manifest["invocation"]["dir"], "tree/files");
    assert_eq!(
        manifest["invocation"]["maps"],
        json!(["app.js=tree/maps/app.map"])
    );
    assert_eq!(
        manifest["invocation"]["coverage"],
        json!(["inputs/0/node.json"])
    );
    // Raw V8 input, including the zero-count factory, is kept byte for byte.
    assert_eq!(
        fs::read_to_string(evidence.join("inputs/0/node.json")).unwrap(),
        coverage
    );

    for (name, expected) in [("evidence", &original), ("static", &original_static)] {
        let replayed = run(
            &offline,
            &["--replay", name, "--json", &format!("{name}.json")],
        );
        assert!(
            replayed.status.success(),
            "{}",
            String::from_utf8_lossy(&replayed.stderr)
        );
        assert_eq!(
            &fs::read(offline.join(format!("{name}.json"))).unwrap(),
            expected
        );
    }

    // --group-by only shapes output, so a replay accepts it.
    let grouped = run(
        &offline,
        &["--replay", "evidence", "--group-by", "**/src/*"],
    );
    assert!(
        grouped.status.success(),
        "{}",
        String::from_utf8_lossy(&grouped.stderr)
    );
    assert!(String::from_utf8_lossy(&grouped.stdout).contains("Group"));
    // Budgets against a baseline and --why do not affect a replay, so they are rejected, not
    // dropped, and the error names the ones given.
    for (extra, named) in [
        (
            &["--baseline", "x.json", "--max-added-bytes", "1"][..],
            "--baseline, --max-added-bytes",
        ),
        (&["--why", "x"][..], "--why"),
    ] {
        let rejected = run(&offline, &[&["--replay", "evidence"][..], extra].concat());
        assert_eq!(rejected.status.code(), Some(1));
        assert_eq!(
            String::from_utf8_lossy(&rejected.stderr),
            format!(
                "Error: --replay takes only output options (--json, --html, --treemap, --tsv, --markdown, --details, --limit, --group-by), not {named}\n"
            )
        );
    }

    fs::write(evidence.join("tree/maps/app.map"), "{}").unwrap();
    let changed = run(&offline, &["--replay", "evidence"]);
    assert_eq!(changed.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&changed.stderr).contains("tree/maps/app.map no longer matches")
    );
}

#[test]
fn evidence_excerpt_replays_selected_bundles_and_lists_what_it_omits() {
    let f = Fixture::new();
    let run = |cwd: &PathBuf, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap()
    };
    let work = f.0.join("work");
    fs::create_dir_all(work.join("site")).unwrap();
    fs::create_dir_all(work.join("maps")).unwrap();
    let map = |sources: [&str; 2]| {
        json!({"version":3,"sources":sources,"names":[],"mappings":"AAAA,GCAA"}).to_string()
    };
    let (a, b) = ("ab;cd", "ef;gh");
    fs::write(work.join("site/a.js"), a).unwrap();
    fs::write(work.join("site/a.js.map"), map(["a1.ts", "a2.ts"])).unwrap();
    fs::write(work.join("site/b.js"), b).unwrap();
    fs::write(
        work.join("maps/b.map"),
        map(["../site/b1.ts", "../site/b2.ts"]),
    )
    .unwrap();
    let root = fs::canonicalize(work.join("site")).unwrap();
    let entry = |name: &str, source: &str| {
        json!({"url":format!("file://{}/{name}", root.display()),"source":source,"functions":[
            {"functionName":"","isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":5,"count":1}]},
            {"functionName":"factory","isBlockCoverage":true,"ranges":[{"startOffset":3,"endOffset":5,"count":0}]}
        ]})
    };
    fs::write(
        work.join("load.json"),
        json!({"result":[entry("a.js", a), entry("b.js", b)]}).to_string(),
    )
    .unwrap();
    let export = |out: &str, select: &[&str]| {
        let mut args = vec![
            "--dir",
            "site",
            "--coverage",
            "load.json",
            "--map",
            "b.js=maps/b.map",
            "--export",
            out,
            "--json",
        ];
        let json = format!("{out}.json");
        args.push(&json);
        for selector in select {
            args.extend(["--export-select", selector]);
        }
        run(&work, &args)
    };
    for (out, select) in [("full", &[][..]), ("excerpt", &["b1.ts"][..])] {
        let exported = export(out, select);
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
    }
    let missing = export("missing", &["nothing.ts"]);
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("\"nothing.ts\" matches no analyzed bundle or source")
    );
    let full: Value = serde_json::from_slice(&fs::read(work.join("full.json")).unwrap()).unwrap();

    let offline = f.0.join("offline");
    fs::create_dir_all(&offline).unwrap();
    fs::rename(work.join("excerpt"), offline.join("excerpt")).unwrap();
    fs::remove_dir_all(&work).unwrap();
    let evidence = offline.join("excerpt");
    let manifest: Value =
        serde_json::from_slice(&fs::read(evidence.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["kind"], "excerpt");
    let excerpt = &manifest["excerpt"];
    assert_eq!(excerpt["selectors"], json!(["b1.ts"]));
    assert_eq!(excerpt["bundles"], json!(["b.js"]));
    let omitted = excerpt["omitted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap(),
                f["role"].as_str().unwrap(),
                f["sha256"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        omitted,
        [
            ("tree/site/a.js", "bundle", sha256(a.as_bytes()).as_str()),
            (
                "tree/site/a.js.map",
                "map",
                sha256(map(["a1.ts", "a2.ts"]).as_bytes()).as_str()
            ),
        ]
    );
    assert!(!evidence.join("tree/site/a.js").exists());
    assert_eq!(excerpt["fullAnalysis"]["reproducible"], false);
    assert_eq!(
        excerpt["fullAnalysis"]["totals"]["bytes"],
        full["totals"]["bytes"]
    );
    assert_eq!(manifest["expected"].get("totals"), None);
    assert_eq!(excerpt["derived"][0]["removedEntries"], 1);
    // The filtered recording keeps the selected script's raw offsets, not a re-based copy.
    let coverage = fs::read_to_string(evidence.join("inputs/0/load.json")).unwrap();
    assert!(!coverage.contains(a) && coverage.contains(b));
    let recorded: Value = serde_json::from_str(&coverage).unwrap();
    assert_eq!(
        recorded["result"][0]["functions"][1]["ranges"][0]["startOffset"],
        3
    );

    let replayed = run(
        &offline,
        &["--replay", "excerpt", "--json", "replayed.json"],
    );
    assert_eq!(
        replayed.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&replayed.stderr)
    );
    assert!(String::from_utf8_lossy(&replayed.stdout).contains("not a complete reproduction"));
    let replay: Value =
        serde_json::from_slice(&fs::read(offline.join("replayed.json")).unwrap()).unwrap();
    let bundle = |report: &Value| {
        report["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["path"] == "b.js")
            .unwrap()
            .clone()
    };
    assert_eq!(bundle(&replay), bundle(&full));
    assert_eq!(replay["bundles"].as_array().unwrap().len(), 1);

    fs::write(evidence.join("tree/site/b.js"), "ef;gX").unwrap();
    let changed = run(&offline, &["--replay", "excerpt"]);
    assert_eq!(changed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&changed.stderr).contains("tree/site/b.js no longer matches"));
}

#[test]
fn recording_warnings_report_aborted_origins_page_errors_and_prefetched_scripts() {
    let f = Fixture::new();
    let source = "abcd";
    f.write("app.js", source);
    f.map(&["src/a.js"]);
    let path = f.coverage(
        "initial",
        source,
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    let mut envelope: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    envelope["blockedOrigins"] = json!(["https://api.example.com"]);
    envelope["pageErrors"] = json!(["flaky request", "second", "third", "fourth"]);
    envelope["prefetchedScripts"] = json!([{"path": "chunks/about.js", "url": "http://127.0.0.1/_next/static/chunks/about.js", "routes": ["/about", "/tags"]}]);
    fs::write(&path, envelope.to_string()).unwrap();
    f.coverage(
        "older",
        source,
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args(["--dir", ".", "--coverage", "initial", "--coverage", "older"])
        .args(["--json", "-", "--markdown", "summary.md"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["recordingWarnings"],
        json!([
            "initial: the collector aborted requests to https://api.example.com because they are not --allow-origin or --cdn-prefix origins, so the recording shows the page without those responses",
            "initial: allowPageErrors tolerated 4 page errors during collection: \"flaky request\", \"second\", \"third\", ...",
            "initial: the collector left out 1 scripts that only router prefetches for other routes loaded and that ran no module, so their bytes count as unmeasured: chunks/about.js (/about, /tags)"
        ])
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains(
        "recording warning: initial: the collector aborted requests to https://api.example.com"
    ));
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    let notes =
        md.find("> [!WARNING]\n> The collector reported page state problems or left scripts out.");
    assert!(
        notes.is_some_and(|at| at < md.find("| Package |").unwrap()),
        "{md}"
    );
    assert!(md.contains("> - initial: allowPageErrors tolerated 4 page errors"));
}

/// Three first-party sources under two feature directories and two dependencies, the first
/// six bytes observed.
fn feature_fixture() -> Fixture {
    let f = Fixture::new();
    let source = "abcdefghijklmnopqrst";
    f.write("app.js", source);
    f.map(&[
        "src/features/auth/login.js",
        "src/features/auth/form.js",
        "src/features/cart/cart.js",
        "node_modules/a/index.js",
        "node_modules/b/index.js",
    ]);
    f.coverage(
        "initial",
        source,
        json!([{"startOffset":0,"endOffset":6,"count":1}]),
    );
    f
}

fn feature_graph(root: &str) -> String {
    json!({"schemaVersion":1,"bundler":"rollup","root":root,"modules":[
        {"id":"login","source":"src/features/auth/login.js","entry":true},
        {"id":"form","source":"src/features/auth/form.js"},
        {"id":"cart","source":"src/features/cart/cart.js"},
        {"id":"a","source":"node_modules/a/index.js"},
        {"id":"b","source":"node_modules/b/index.js"},
        {"id":"virtual","source":"[next]/entry/page.js","entry":true}],"edges":[
        {"from":"login","to":"form","kind":"static"},
        {"from":"login","to":"a","kind":"static","location":{"line":3,"column":1}},
        {"from":"cart","to":"a","kind":"dynamic","location":{"line":1,"column":8}},
        {"from":"a","to":"b","kind":"static"},
        {"from":"virtual","to":"b","kind":"static"},
        {"from":"login","to":"cart","kind":"dynamic"}]})
    .to_string()
}

#[test]
fn group_by_sums_sources_under_the_shortest_matching_path() {
    let f = feature_fixture();
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args(["--dir", ".", "--coverage", "initial"])
            .args(["--json", "-", "--markdown", "summary.md"])
            .args(extra)
            .output()
            .unwrap()
    };
    let output = run(&[
        "--group-by",
        "src/features/*",
        "--group-by",
        "node_modules/*",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (
                g["group"].as_str().unwrap(),
                g["pattern"].as_str().unwrap(),
                g["sources"].as_u64().unwrap(),
                g["bytes"].as_u64().unwrap(),
                g["observedBytes"].as_u64().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("src/features/auth", "src/features/*", 2, 8, 6),
            ("node_modules/a", "node_modules/*", 1, 4, 0),
            ("node_modules/b", "node_modules/*", 1, 4, 0),
            ("src/features/cart", "src/features/*", 1, 4, 0),
        ]
    );
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    assert!(md.contains("| src/features/auth | 2 | 8 | 6 | 2 | 0 | — |"));
    assert!(
        String::from_utf8_lossy(&run(&["--group-by", "src/["]).stderr)
            .contains("invalid --group-by glob")
    );
}

#[test]
fn a_wrong_graph_root_is_reported_instead_of_a_stale_graph() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("app.js.map", &json!({"version":3,"sources":["webpack://app/./src/a.js"],"sourcesContent":["TRANSFORMED"],"names":[],"mappings":"AAAA"}).to_string());
    fs::create_dir_all(f.0.join("src")).unwrap();
    fs::create_dir_all(f.0.join("nested")).unwrap();
    f.write("src/a.js", "ORIGINAL");
    f.write(
        "graph.json",
        &json!({"schemaVersion":1,"bundler":"webpack","modules":[
        {"id":"a","source":"src/a.js","entry":true,"sourceSha256":sha256(b"ORIGINAL")}],"edges":[]})
        .to_string(),
    );
    let run = |root: &str| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args([
                "--dir",
                ".",
                "--graph",
                "graph.json",
                "--graph-root",
                root,
                "--json",
                "-",
            ])
            .output()
            .unwrap()
    };
    let output = run("nested");
    assert_eq!(output.status.code(), Some(1));
    let root = fs::canonicalize(&f.0).unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&format!(
            "so the graph root looks wrong: pass --graph-root {}.",
            root.display()
        )),
        "{stderr}"
    );
    assert!(run(".").status.success());
}

#[test]
fn a_recorded_graph_root_replaces_the_current_directory() {
    let f = feature_fixture();
    fs::create_dir_all(f.0.join("out")).unwrap();
    fs::create_dir_all(f.0.join("elsewhere")).unwrap();
    // Run elsewhere, so the current directory is not the graph root.
    let run = || {
        let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(f.0.join("elsewhere"))
            .args(["--dir", "..", "--coverage", "../initial"])
            .args(["--graph", "../out/graph.json", "--json", "-"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    f.write("out/graph.json", &feature_graph(".."));
    assert_eq!(run()["importPaths"].as_array().unwrap().len(), 5);
    // A recorded root that does not exist falls back to the current directory, and the
    // warning names the directory where the graph's sources match.
    f.write("out/graph.json", &feature_graph("../missing"));
    let report = run();
    let warnings = report["warnings"].to_string();
    let root = fs::canonicalize(&f.0).unwrap();
    assert!(warnings.contains("recorded root"), "{warnings}");
    assert!(
        warnings.contains(&format!(
            "but 5 match under {}: pass --graph-root {}",
            root.display(),
            root.display()
        )),
        "{warnings}"
    );
    assert!(report["importPaths"].as_array().unwrap().is_empty());
}

#[test]
fn package_importers_name_the_first_party_imports_that_load_a_dependency() {
    let f = feature_fixture();
    f.write("graph.json", &feature_graph("."));
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args([
            "--dir",
            ".",
            "--coverage",
            "initial",
            "--graph",
            "graph.json",
        ])
        .args(["--json", "-", "--markdown", "summary.md"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let package = |name: &str| {
        report["packages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["package"] == name)
            .unwrap()["importers"]
            .clone()
    };
    assert_eq!(
        package("a"),
        json!([
            {"source":"src/features/auth/login.js","kind":"static","location":{"line":3,"column":1}},
            {"source":"src/features/cart/cart.js","kind":"dynamic","location":{"line":1,"column":8}}
        ])
    );
    // Reached through a: the location is that of the import into a. The virtual entry is not first-party code.
    assert_eq!(
        package("b"),
        json!([
            {"source":"src/features/auth/login.js","kind":"static","location":{"line":3,"column":1},"via":"a"},
            {"source":"src/features/cart/cart.js","kind":"dynamic","location":{"line":1,"column":8},"via":"a"}
        ])
    );
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    assert!(
        md.contains("| a | 4 | 4 | 0 | src/features/auth/login.js, src/features/cart/cart.js |")
    );
    assert!(md.contains(
        "| b | 4 | 4 | 0 | src/features/auth/login.js via a, src/features/cart/cart.js via a |"
    ));
}

#[test]
fn baselines_record_their_mode_and_reject_the_other_mode() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.map(&["src/a.js"]);
    let coverage = f.coverage(
        "initial",
        "abcd",
        json!([{"startOffset":0,"endOffset":2,"count":1}]),
    );
    let fixed = coldpath::analyze(&f.0, &[]).unwrap();
    let covered = coldpath::analyze(&f.0, &[coverage]).unwrap();
    assert_eq!(fixed.mode, "static");
    assert_eq!(covered.mode, "coverage");
    let fixed_json = serde_json::to_vec(&fixed).unwrap();
    let covered_json = serde_json::to_vec(&covered).unwrap();
    assert!(coldpath::baseline::compare(&fixed, &fixed_json).is_ok());
    assert!(coldpath::baseline::compare(&covered, &covered_json).is_ok());
    let error = coldpath::baseline::compare(&covered, &fixed_json)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains(
            "baseline mode mismatch: the baseline is a static analysis (no coverage) and this one is a coverage analysis (scenarios [\"initial\"])"
        ),
        "{error}"
    );
    assert!(coldpath::baseline::compare(&fixed, &covered_json).is_err());
    // A baseline from before `mode` existed is classified by its scenarios.
    let mut old: Value = serde_json::from_slice(&fixed_json).unwrap();
    old.as_object_mut().unwrap().remove("mode");
    let old = old.to_string().into_bytes();
    assert!(coldpath::baseline::compare(&fixed, &old).is_ok());
    assert!(coldpath::baseline::compare(&covered, &old).is_err());
    // Inconsistent counts name the row and the numbers.
    let mut bad: Value = serde_json::from_slice(&fixed_json).unwrap();
    bad["packages"][0]["observedBytes"] = json!(99);
    let error = coldpath::baseline::compare(&fixed, &bad.to_string().into_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains(
            "invalid baseline counts for \"[application]\": observed 99 + unobserved 0 + unmeasured 4 is not bytes 4"
        ),
        "{error}"
    );
}

#[test]
fn package_budgets_limit_growth_and_new_packages() {
    let f = Fixture::new();
    let map = |sources: Vec<&str>, mappings: &str| {
        json!({"version":3,"sources":sources,"names":[],"mappings":mappings}).to_string()
    };
    f.write("app.js", "abcdefgh");
    f.write(
        "app.js.map",
        &map(vec!["src/main.js", "node_modules/a/index.js"], "AAAA,ICAA"),
    );
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args(["--dir", ".", "--json", "-"])
            .args(extra)
            .output()
            .unwrap()
    };
    let baseline = run(&[]);
    assert!(baseline.status.success());
    fs::write(f.0.join("main.json"), &baseline.stdout).unwrap();
    // Package a grows by 4 bytes and b is new.
    f.write("app.js", "abcdefghijklmnop");
    f.write(
        "app.js.map",
        &map(
            vec![
                "src/main.js",
                "node_modules/a/index.js",
                "node_modules/b/index.js",
            ],
            "AAAA,ICAA,QCAA",
        ),
    );
    let failures = |output: &std::process::Output| {
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        report["budgetFailures"].clone()
    };
    let output = run(&[
        "--baseline",
        "main.json",
        "--max-added-package-bytes",
        "a=3",
    ]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(failures(&output), json!(["package a: +4 exceeds budget 3"]));
    assert!(
        run(&[
            "--baseline",
            "main.json",
            "--max-added-package-bytes",
            "a=4"
        ])
        .status
        .success()
    );
    let output = run(&["--baseline", "main.json", "--fail-on-new-package"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        failures(&output),
        json!(["new package b: 4 bytes, not in the baseline"])
    );
    assert!(
        run(&[
            "--baseline",
            "main.json",
            "--fail-on-new-package",
            "--allow-new-package",
            "b"
        ])
        .status
        .success()
    );
    assert_eq!(
        run(&["--baseline", "main.json", "--max-added-package-bytes", "a"])
            .status
            .code(),
        Some(1)
    );
    // The same budgets in the config; without a baseline they are reported as unchecked.
    f.write(
        "ci.json",
        r#"{"budgets":{"maxAddedPackageBytes":{"a":3},"failOnNewPackages":true,"allowedNewPackages":["c"]}}"#,
    );
    let output = run(&["--config", "ci.json"]);
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let warnings = report["warnings"].to_string();
    assert!(
        warnings.contains("budgets.maxAddedPackageBytes compares against a baseline")
            && warnings.contains("budgets.failOnNewPackages compares against a baseline"),
        "{warnings}"
    );
    let output = run(&["--config", "ci.json", "--baseline", "main.json"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(failures(&output).as_array().unwrap().len(), 2);
}

#[test]
fn unmeasured_and_unmapped_breakdowns_name_bundles_and_causes() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.map(&["src/a.js"]);
    // No map at all, and a map whose mappings stop before the last line.
    f.write("other.js", "unused!");
    f.write("third.js", "xy\nz");
    f.write(
        "third.js.map",
        &json!({"version":3,"sources":["src/t.js"],"names":[],"mappings":"AAAA"}).to_string(),
    );
    let path = f.coverage(
        "initial",
        "abcd",
        json!([{"startOffset":0,"endOffset":4,"count":1}]),
    );
    let mut envelope: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    envelope["prefetchedScripts"] =
        json!([{"path": "third.js", "url": "http://127.0.0.1/third.js", "routes": ["/t"]}]);
    fs::write(&path, envelope.to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args(["--dir", ".", "--coverage", "initial", "--limit", "1"])
        .args(["--json", "-", "--markdown", "summary.md"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["unmeasured"],
        json!({"bytes": 11, "notRecordedBytes": 7, "prefetchOnlyBytes": 4, "bundles": [
            {"path": "other.js", "bytes": 7, "reason": "not-recorded"},
            {"path": "third.js", "bytes": 4, "reason": "prefetch-only", "scenarios": ["initial"]}
        ]})
    );
    assert_eq!(
        report["scenarioReports"][0]["unmeasuredBundles"],
        report["unmeasured"]["bundles"]
    );
    assert_eq!(
        report["unmapped"],
        json!({"bytes": 9, "bundlesWithoutMap": 1, "bytesWithoutMap": 7, "bundlesWithGaps": 1, "gapBytes": 2})
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Unmeasured: 11 bytes in 2 bundles no scenario recorded (7 not loaded, 4 left out after router prefetches):")
            && stderr.contains("           7  other.js  no scenario loaded it")
            && stderr.contains("... and 1 more in the JSON report")
            && stderr.contains("Unmapped: 9 bytes (7 in 1 bundles without a source map, 2 in mapping gaps of 1 mapped bundles)"),
        "{stderr}"
    );
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    assert!(
        md.contains("## Unmeasured bytes")
            && md.contains("| other.js | 7 | no scenario loaded it |")
            && md.contains(
                "| third.js | 4 | left out: only router prefetches for other routes loaded it (initial) |"
            )
            && md.contains("`[unmapped]` holds 9 B"),
        "{md}"
    );
}

#[test]
fn initial_html_names_the_bundles_a_document_loads() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("lazy.js", "efghij");
    f.write("index.html", "<html><head><script src=\"/assets/app.js\" async></script><script>self.__next_f.push([1,\"\\\"static/lazy.js.map\\\"\"])</script></head></html>");
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args(["--dir", ".", "--initial-html", "index.html", "--json", "-"])
            .args(extra)
            .output()
            .unwrap()
    };
    let output = run(&["--markdown", "summary.md", "--export", "evidence"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    // lazy.js.map is not lazy.js: paths match as whole segments.
    assert_eq!(
        report["initialLoad"],
        json!({"html": "index.html", "bytes": 4, "bundles": ["app.js"]})
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Initial load named by index.html: 4 bytes in 1 bundles")
    );
    assert!(
        fs::read_to_string(f.0.join("summary.md"))
            .unwrap()
            .contains("Initial load named by `index.html`: **4 B** in 1 bundles")
    );
    fs::write(f.0.join("main.json"), &output.stdout).unwrap();
    let output = run(&["--max-initial-bytes", "3"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("budget failed: initial-load bytes: 4 exceeds budget 3")
    );
    // The evidence replays with the document.
    let replayed = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args(["--replay", "evidence", "--json", "-"])
        .output()
        .unwrap();
    assert!(
        replayed.status.success(),
        "{}",
        String::from_utf8_lossy(&replayed.stderr)
    );
    let replay: Value = serde_json::from_slice(&replayed.stdout).unwrap();
    assert_eq!(replay["initialLoad"]["bytes"], 4);
    // Growth against the baseline, with the bundles that entered the initial load.
    f.write("app.js", "abcdef");
    f.write("index.html", "<script src=\"/assets/app.js\"></script><link rel=\"modulepreload\" href=\"/assets/lazy.js\">");
    let output = run(&["--baseline", "main.json", "--max-added-initial-bytes", "1"]);
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["baseline"]["initialLoad"],
        json!({"beforeBytes": 4, "afterBytes": 12, "deltaBytes": 8, "addedBundles": ["lazy.js"], "removedBundles": []})
    );
    assert_eq!(
        report["budgetFailures"],
        json!(["initial-load byte growth: +8 exceeds budget 1"])
    );
    // A baseline made without --initial-html cannot be compared.
    let mut old: Value = serde_json::from_slice(&fs::read(f.0.join("main.json")).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("initialLoad");
    f.write("old.json", &old.to_string());
    let output = run(&["--baseline", "old.json", "--max-added-initial-bytes", "1"]);
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report["baseline"]["warnings"]
            .to_string()
            .contains("The baseline has no initial load")
    );
    assert!(
        report["budgetFailures"][0]
            .as_str()
            .unwrap()
            .starts_with("initial-load byte growth: cannot check budget")
    );
    f.write("index.html", "<html>nothing</html>");
    let output = run(&[]);
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report["warnings"]
            .to_string()
            .contains("names none of the analyzed bundles")
    );
}

#[test]
fn initial_html_names_percent_encoded_chunk_paths() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("chunks/app/[slug]")).unwrap();
    f.write("chunks/main-1.js", "abcd");
    f.write("chunks/app/[slug]/page-abc.js", "efghij");
    // Next.js encodes each path segment with encodeURIComponent.
    f.write("index.html", "<script src=\"/_next/static/chunks/main-1.js\" async></script><script src=\"/_next/static/chunks/app/%5Bslug%5D/page-abc.js\" async></script>");
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args(["--dir", ".", "--initial-html", "index.html", "--json", "-"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["initialLoad"],
        json!({"html": "index.html", "bytes": 10, "bundles": ["chunks/app/[slug]/page-abc.js", "chunks/main-1.js"]})
    );
}

#[test]
fn repeated_runs_report_their_spread_per_scenario_package_and_source() {
    let f = Fixture::new();
    let source = "abcdefgh";
    f.write("app.js", source);
    f.map(&["src/a.js", "node_modules/p/index.js"]);
    f.write("other.js", "wxyz");
    f.write(
        "other.js.map",
        &json!({"version":3,"sources":["src/o.js"],"names":[],"mappings":"AAAA"}).to_string(),
    );
    let run = |number: u32, ranges: Value, other: bool| {
        let mut scripts = vec![
            json!({"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":sha256(&fs::read(f.0.join("app.js.map")).unwrap()),"functions":[{"isBlockCoverage":true,"ranges":ranges}]}),
        ];
        if other {
            scripts.push(json!({"path":"other.js","sha256":sha256(b"wxyz"),"sourceMapSha256":sha256(&fs::read(f.0.join("other.js.map")).unwrap()),"functions":[{"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":4,"count":1}]}]}));
        }
        f.write(
            &format!("scroll-{number}"),
            &json!({"schemaVersion":1,"scenario":"scroll","run":number,"scripts":scripts})
                .to_string(),
        )
    };
    // Run 1 executes 2 bytes of a and loads other.js; run 2 executes 6 bytes (a and p) without other.js.
    let files = [
        run(1, json!([{"startOffset":0,"endOffset":2,"count":1}]), true),
        run(2, json!([{"startOffset":0,"endOffset":6,"count":1}]), false),
    ];
    let report = analyze_with_options(&f.0, &files, &AnalyzeOptions::default()).unwrap();
    // The scenario itself unions the runs, as before.
    assert_eq!(report.scenario_reports[0].totals.observed_bytes, 10);
    let runs = &report.runs;
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!((run.scenario.as_str(), run.runs), ("scroll", 2));
    let spread = |s: &coldpath::Spread| (s.min, s.max, s.mean, s.stddev);
    assert_eq!(spread(&run.totals.observed_bytes), (6, 6, 6.0, 0.0));
    assert_eq!(
        spread(&run.totals.unobserved_bytes),
        (2, 6, 4.0, 2.0f64.sqrt() * 2.0)
    );
    assert_eq!(
        spread(&run.totals.unmeasured_bytes),
        (0, 4, 2.0, 2.0f64.sqrt() * 2.0)
    );
    let package = |name: &str| run.packages.iter().find(|p| p.package == name).unwrap();
    assert_eq!(
        spread(&package("p").spread.observed_bytes),
        (0, 2, 1.0, 2.0f64.sqrt())
    );
    assert_eq!(package("[application]").spread.unmeasured_bytes.max, 4);
    assert_eq!(
        run.varying_sources
            .iter()
            .map(|s| (
                s.source.as_str(),
                s.spread.observed_bytes.min,
                s.spread.observed_bytes.max,
                s.spread.unmeasured_bytes.max
            ))
            .collect::<Vec<_>>(),
        [
            ("src/o.js", 0, 4, 4),
            ("node_modules/p/index.js", 0, 2, 0),
            ("src/a.js", 2, 4, 0)
        ]
    );
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["runs"][0]["totals"]["observedBytes"]["stddev"], 0.0);
    let md = ci::markdown(&report);
    assert!(
        md.contains("## Run-to-run spread")
            && md.contains("| scroll | 2 | 6 to 6 (mean 6.0, sd 0.0) |"),
        "{md}"
    );
    // The same run number twice is an input error; a single run reports no spread.
    f.write("dup", &fs::read_to_string(f.0.join("scroll-1")).unwrap());
    assert!(
        analyze_with_options(
            &f.0,
            &[f.0.join("scroll-1"), f.0.join("dup")],
            &AnalyzeOptions::default()
        )
        .unwrap_err()
        .to_string()
        .contains("run 1 of scenario \"scroll\" was already read")
    );
    assert!(
        analyze_with_options(&f.0, &files[..1], &AnalyzeOptions::default())
            .unwrap()
            .runs
            .is_empty()
    );
}

#[test]
fn diff_lists_scripts_and_ranges_that_only_one_recording_executed() {
    let f = Fixture::new();
    let source = "abcdefgh";
    f.write("app.js", source);
    f.map(&["src/a.js", "node_modules/p/index.js"]);
    f.write("other.js", "wxyz");
    f.write(
        "other.js.map",
        &json!({"version":3,"sources":["src/o.js"],"names":[],"mappings":"AAAA"}).to_string(),
    );
    let write = |name: &str, ranges: Value, other: bool| {
        let mut scripts = vec![
            json!({"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":sha256(&fs::read(f.0.join("app.js.map")).unwrap()),"functions":[{"isBlockCoverage":true,"ranges":ranges}]}),
        ];
        if other {
            scripts.push(json!({"path":"other.js","sha256":sha256(b"wxyz"),"sourceMapSha256":sha256(&fs::read(f.0.join("other.js.map")).unwrap()),"functions":[{"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":4,"count":1}]}]}));
        }
        // Both recordings carry the same scenario name, as two runs of one setup would.
        f.write(
            name,
            &json!({"schemaVersion":1,"scenario":"scroll","scripts":scripts}).to_string(),
        );
    };
    write(
        "a.json",
        json!([{"startOffset":0,"endOffset":2,"count":1}]),
        true,
    );
    write(
        "b.json",
        json!([{"startOffset":1,"endOffset":6,"count":1}]),
        false,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args(["--dir", ".", "--diff", "a.json", "b.json", "--details"])
        .args(["--json", "-", "--markdown", "summary.md"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["scenarios"], json!(["A", "B"]));
    let diff = &report["recordingDiff"];
    assert_eq!(diff["a"], "a.json");
    assert_eq!(diff["onlyA"], json!([{"path": "other.js", "bytes": 4}]));
    assert_eq!(diff["onlyB"], json!([]));
    assert_eq!(
        diff["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (
                s["source"].as_str().unwrap().to_owned(),
                s["delta"]["observedBytes"].as_i64().unwrap(),
                s["delta"]["unmeasuredBytes"].as_i64().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("src/o.js".to_owned(), -4, 4),
            ("node_modules/p/index.js".to_owned(), 2, 0),
            ("src/a.js".to_owned(), 1, 0)
        ]
    );
    // Ranges are compared where both recorded the bundle; other.js is listed above instead.
    assert_eq!(
        diff["bundles"],
        json!([{"path": "app.js", "onlyA": [{"start": 0, "end": 1, "source": "src/a.js"}], "onlyB": [{"start": 2, "end": 4, "source": "src/a.js"}, {"start": 4, "end": 6, "source": "node_modules/p/index.js"}]}])
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Scripts recorded only in A: other.js (4 bytes)")
            && stderr.contains("3 sources executed differently")
            && stderr.contains("          -4  src/o.js (A 4 of 4, B 0 of 4)"),
        "{stderr}"
    );
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    assert!(
        md.contains("## Recording difference")
            && md.contains("| src/o.js | &#91;application&#93; | 4 | 0 | -4 | +4 |"),
        "{md}"
    );
    // Exactly two files, and not together with --coverage.
    let bad = Command::new(env!("CARGO_BIN_EXE_coldpath"))
        .current_dir(&f.0)
        .args([
            "--dir",
            ".",
            "--diff",
            "a.json",
            "b.json",
            "--coverage",
            "a.json",
        ])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
}

#[test]
fn prefetch_evaluated_scripts_are_left_out_unless_a_mapped_function_ran() {
    // A Turbopack chunk another route's prefetch loaded: its factories ran (module evaluation),
    // and in one recording a component function inside a module did too.
    let f = Fixture::new();
    let source = "self.T=[1,(e,t,r)=>{t.exports={f:()=>0}},2,e=>{var a=e.i(1)}];";
    f.write("app.js", source);
    f.write(
        "app.js.map",
        &json!({"version":3,"sources":["heavy.js","next.js"],"names":[],"mappings":"oBAAA,aAAK,cCAL"})
            .to_string(),
    );
    f.write("main.js", "ok()");
    let range = |code: &str, count: u64| {
        let start = source.find(code).unwrap();
        json!({"startOffset":start,"endOffset":start + code.len(),"count":count})
    };
    let envelope = |name: &str, inner: u64| {
        let functions = json!([
            {"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":source.len(),"count":1}]},
            {"isBlockCoverage":true,"ranges":[range("(e,t,r)=>{t.exports={f:()=>0}}", 1)]},
            {"isBlockCoverage":true,"ranges":[range("()=>0", inner)]},
            {"isBlockCoverage":true,"ranges":[range("e=>{var a=e.i(1)}", 1)]},
        ]);
        f.write(name, &json!({"schemaVersion":1,"scenario":name,"scripts":[
            {"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":sha256(&fs::read(f.0.join("app.js.map")).unwrap()),"functions":functions},
            {"path":"main.js","sha256":sha256(b"ok()"),"sourceMapSha256":null,"functions":[{"isBlockCoverage":true,"ranges":[{"startOffset":0,"endOffset":4,"count":1}]}]}
        ],"prefetchEvaluatedScripts":[{"path":"app.js","url":"http://127.0.0.1/app.js","routes":["/about"]}]}).to_string())
    };
    let files = [envelope("initial", 0), envelope("navigate", 1)];
    let report = analyze_with_options(&f.0, &files, &AnalyzeOptions::default()).unwrap();
    let app = report.bundles.iter().find(|b| b.path == "app.js").unwrap();
    // initial: left out, so app.js is unmeasured there; navigate: kept, its bytes observed.
    let scenario = |name: &str| {
        report
            .scenario_reports
            .iter()
            .find(|s| s.scenario == name)
            .unwrap()
    };
    let initial = scenario("initial")
        .bundles
        .iter()
        .find(|b| b.path == "app.js")
        .unwrap();
    assert_eq!(
        (
            initial.counts.unmeasured_bytes,
            initial.counts.observed_bytes
        ),
        (source.len(), 0)
    );
    assert_eq!(
        scenario("initial").unmeasured_bundles[0].reason,
        coldpath::UnmeasuredReason::PrefetchOnly
    );
    let navigate = scenario("navigate")
        .bundles
        .iter()
        .find(|b| b.path == "app.js")
        .unwrap();
    assert!(navigate.counts.observed_bytes > 0 && navigate.counts.unmeasured_bytes == 0);
    assert_eq!(
        app.verification
            .iter()
            .map(|v| v.scenario.as_str())
            .collect::<Vec<_>>(),
        ["navigate"]
    );
    assert_eq!(
        report.recording_warnings,
        [
            "initial: the analyzer left out 1 scripts that only router prefetches for other routes loaded and in which only module evaluation ran, so their bytes count as unmeasured: app.js (/about)",
            "navigate: kept 1 scripts that only router prefetches for other routes loaded, because functions in them ran: app.js (/about)"
        ]
    );
    // Left out in every scenario: unmeasured overall, with the prefetch reason.
    let report = analyze_with_options(&f.0, &files[..1], &AnalyzeOptions::default()).unwrap();
    assert_eq!(report.totals.unmeasured_bytes, source.len());
    assert_eq!(report.unmeasured.bundles[0].scenarios, ["initial"]);
    assert_eq!(report.unmeasured.prefetch_only_bytes, source.len());
}
