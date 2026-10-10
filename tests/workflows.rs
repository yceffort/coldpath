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
fn recording_warnings_report_aborted_origins_and_tolerated_page_errors() {
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
            "initial: allowPageErrors tolerated 4 page errors during collection: \"flaky request\", \"second\", \"third\", ..."
        ])
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains(
        "recording warning: initial: the collector aborted requests to https://api.example.com"
    ));
    let md = fs::read_to_string(f.0.join("summary.md")).unwrap();
    let notes = md.find("> [!WARNING]\n> The collector reported page state problems.");
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
