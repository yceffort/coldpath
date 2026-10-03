use coldpath::{AnalyzeOptions, Report, analyze_with_options, cpu, sha256};
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
            "coldpath-cpu-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, path: &str, text: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }
    /// `app.js` with one mapping per source, `columns` UTF-16 units apart.
    fn bundle(&self, text: &str, sources: &[&str], columns: &str) {
        self.write("app.js", text);
        let mappings = (0..sources.len())
            .map(|i| {
                if i == 0 {
                    "AAAA".into()
                } else {
                    format!("{columns}CAA")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        self.write(
            "app.js.map",
            &json!({"version":3,"sources":sources,"names":[],"mappings":mappings}).to_string(),
        );
    }
    /// A profile of `app.js` whose window totals are the sum of its rows.
    fn profile(&self, name: &str, mut profile: Value) -> PathBuf {
        let text = fs::read(self.0.join("app.js")).unwrap();
        let map = fs::read(self.0.join("app.js.map")).ok();
        for script in profile["scripts"].as_array_mut().unwrap() {
            if script.get("sha256").is_none() {
                script["sha256"] = json!(sha256(&text));
                script["sourceMapSha256"] = json!(map.as_ref().map(|m| sha256(m)));
            }
        }
        let runs = profile["runs"].as_u64().unwrap() as usize;
        let names = profile["windows"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for window in names {
            let mut total = vec![0u64; runs];
            let mut add = |cell: &Value| {
                for (total, count) in total
                    .iter_mut()
                    .zip(cell["samples"].as_array().into_iter().flatten())
                {
                    *total += count.as_u64().unwrap();
                }
            };
            for cell in profile["windows"][&window]["buckets"]
                .as_object()
                .unwrap()
                .values()
            {
                add(cell);
            }
            for script in profile["scripts"].as_array().unwrap() {
                add(&script["topLevel"][&window]);
                for function in script["functions"].as_array().unwrap() {
                    add(&function["windows"][&window]);
                }
            }
            if profile["windows"][&window].get("samples").is_none() {
                profile["windows"][&window]["samples"] = json!(total);
            }
        }
        self.write(name, &profile.to_string())
    }
    fn analyze(&self, profiles: &[PathBuf]) -> anyhow::Result<Report> {
        self.analyze_with(profiles, AnalyzeOptions::default())
    }
    fn analyze_with(
        &self,
        profiles: &[PathBuf],
        options: AnalyzeOptions,
    ) -> anyhow::Result<Report> {
        analyze_with_options(
            &self.0,
            &[],
            &AnalyzeOptions {
                profiles: profiles.to_vec(),
                ..options
            },
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// a.js owns bytes 0..4, b.js 4..8, and the package 8..12.
fn three_sources() -> Fixture {
    let fixture = Fixture::new();
    fixture.bundle(
        "abcdefghijkl",
        &["src/a.js", "src/b.js", "node_modules/pkg/index.js"],
        "I",
    );
    fixture
}

/// Self samples and microseconds per run.
fn cell(samples: &[u64], self_us: &[f64]) -> Value {
    json!({"samples": samples, "selfUs": self_us})
}

/// 10 µs per sample in the load window; measured gaps in the action window.
fn two_windows() -> Value {
    let zero = cell(&[0; 4], &[0.0; 4]);
    json!({
        "schemaVersion": 1, "scenario": "open", "runs": 4, "samplingIntervalUs": 100,
        "environment": {"cpuSlowdown": 1},
        "windows": {
            "load": {"durationUs": [1000, 1000, 2000, 1000],
                "buckets": {"(idle)": cell(&[57, 56, 155, 58], &[570.0, 560.0, 1550.0, 580.0])}},
            "action": {"durationUs": [500, 500, 500, 500],
                "buckets": {"(other scripts)": cell(&[5; 4], &[100.0; 4])}}
        },
        "scripts": [{
            "path": "app.js",
            "topLevel": {"load": cell(&[2; 4], &[20.0; 4]), "action": zero},
            "functions": [
                {"offset": 1, "windows": {"load": cell(&[10, 12, 11, 9], &[100.0, 120.0, 110.0, 90.0]), "action": zero}},
                {"offset": 5, "windows": {"load": cell(&[1, 0, 2, 1], &[10.0, 0.0, 20.0, 10.0]),
                    "action": cell(&[20, 22, 21, 19], &[400.0, 407.44, 388.88, 395.83])}},
                {"offset": 9, "windows": {"load": cell(&[30; 4], &[300.0; 4]),
                    "action": cell(&[0, 0, 1, 0], &[0.0, 0.0, 18.5, 0.0])}}
            ]
        }]
    })
}

fn window<'a>(report: &'a Report, scenario: &str, name: &str) -> &'a cpu::CpuWindow {
    report
        .cpu
        .as_ref()
        .unwrap()
        .scenarios
        .iter()
        .find(|s| s.scenario == scenario)
        .unwrap()
        .windows
        .iter()
        .find(|w| w.window == name)
        .unwrap()
}

fn source<'a>(window: &'a cpu::CpuWindow, name: &str) -> &'a cpu::Cost {
    &window
        .sources
        .iter()
        .find(|s| s.source == name)
        .unwrap()
        .cost
}

#[test]
fn self_time_is_attributed_by_function_start_and_kept_apart_from_bytes() {
    let f = three_sources();
    let without = f.analyze(&[]).unwrap();
    let report = f.analyze(&[f.profile("open.json", two_windows())]).unwrap();
    assert_eq!(report.totals, without.totals);
    assert_eq!(
        serde_json::to_value(&without).unwrap().get("cpu"),
        None,
        "no profile, no CPU output"
    );
    let scenario = &report.cpu.as_ref().unwrap().scenarios[0];
    assert_eq!(
        (scenario.runs, scenario.bundles.as_slice()),
        (4, &["app.js".to_string()][..])
    );

    let load = window(&report, "open", "load");
    let a = source(load, "src/a.js");
    assert_eq!(a.samples, vec![10, 12, 11, 9]);
    assert_eq!(a.self_us, vec![100.0, 120.0, 110.0, 90.0]);
    assert_eq!((a.median_us, a.q1_us, a.q3_us), (105.0, 97.5, 112.5));
    assert_eq!(a.median_samples, 10.5);
    assert_eq!(a.status, cpu::CpuStatus::Measured);
    let b = source(load, "src/b.js");
    assert_eq!(
        (b.median_samples, b.status),
        (1.0, cpu::CpuStatus::Insufficient)
    );
    assert_eq!(
        load.sources
            .iter()
            .map(|s| s.source.as_str())
            .collect::<Vec<_>>(),
        ["node_modules/pkg/index.js", "src/a.js", "src/b.js"],
        "largest median first"
    );
    let application = &load
        .packages
        .iter()
        .find(|p| p.package == "[application]")
        .unwrap()
        .cost;
    assert_eq!(application.samples, vec![11, 12, 13, 10]);
    assert_eq!(load.top_level[0].path, "app.js");
    assert_eq!(load.top_level[0].cost.self_us, vec![20.0; 4]);
    assert_eq!(load.other[0].name, "(idle)");
    assert_eq!(load.median_duration_us, 1000.0);

    // Rounded to 0.1 µs.
    let action = window(&report, "open", "action");
    let b = source(action, "src/b.js");
    assert_eq!(b.self_us, vec![400.0, 407.4, 388.9, 395.8]);
    assert_eq!(b.median_us, 397.9);
    assert!(
        action.sources.iter().all(|s| s.source != "src/a.js"),
        "unsampled sources have no row"
    );
    assert!(action.top_level.is_empty());
    assert_eq!(action.other[0].name, "(other scripts)");
}

#[test]
fn utf16_offsets_select_the_source_that_owns_the_start_byte() {
    let f = Fixture::new();
    // UTF-16: a=0, 🔥=1..3, b=3, c=4. UTF-8: a=0, 🔥=1..5, b=5, c=6.
    f.bundle("a🔥bc", &["src/first.js", "src/second.js"], "G");
    let profile = |offset: usize| {
        json!({"schemaVersion":1,"scenario":"s","runs":2,"samplingIntervalUs":100,
            "windows":{"load":{"durationUs":[100,100],"buckets":{}}},
            "scripts":[{"path":"app.js","topLevel":{"load":cell(&[0, 0], &[0.0, 0.0])},
                "functions":[{"offset":offset,"windows":{"load":cell(&[3, 3], &[30.0, 30.0])}}]}]})
    };
    for (offset, owner) in [
        (1, "src/first.js"),
        (3, "src/second.js"),
        (4, "src/second.js"),
    ] {
        let report = f.analyze(&[f.profile("p.json", profile(offset))]).unwrap();
        assert_eq!(
            window(&report, "s", "load").sources[0].source,
            owner,
            "offset {offset}"
        );
    }
    for (offset, error) in [
        (2, "surrogate pair"),
        (5, "outside the script"),
        (6, "outside source"),
    ] {
        let message = format!(
            "{:#}",
            f.analyze(&[f.profile("p.json", profile(offset))])
                .unwrap_err()
        );
        assert!(message.contains(error), "offset {offset}: {message}");
    }
}

#[test]
fn stale_builds_and_inconsistent_profiles_are_rejected() {
    let f = three_sources();
    let error = |profile: Value| {
        format!(
            "{:#}",
            f.analyze(&[f.profile("bad.json", profile)]).unwrap_err()
        )
    };
    let mut stale = two_windows();
    stale["scripts"][0]["sha256"] = json!("0".repeat(64));
    stale["scripts"][0]["sourceMapSha256"] = json!(null);
    assert!(error(stale).contains("profile SHA-256 mismatch"));
    let mut map = two_windows();
    map["scripts"][0]["sha256"] = json!(sha256(b"abcdefghijkl"));
    map["scripts"][0]["sourceMapSha256"] = json!(null);
    assert!(error(map).contains("source-map SHA-256 mismatch"));
    let mut lost = two_windows();
    lost["windows"]["load"]["samples"] = json!([1, 1, 1, 1]);
    assert!(error(lost).contains("do not add up"));
    let mut single = two_windows();
    single["runs"] = json!(1);
    assert!(error(single).contains("at least 2 runs"));
    let mut short = two_windows();
    short["windows"]["action"]["durationUs"] = json!([500, 500]);
    assert!(error(short).contains("one value per run"));
    let mut negative = two_windows();
    negative["windows"]["load"]["buckets"]["(idle)"]["selfUs"][0] = json!(-1);
    assert!(error(negative).contains("nonnegative"));
    let mut windows = two_windows();
    windows["windows"]["later"] = windows["windows"]["action"].clone();
    assert!(error(windows).contains("load and optionally action"));
    let mut missing = two_windows();
    missing["scripts"][0]["path"] = json!("gone.js");
    missing["scripts"][0]["sha256"] = json!("0".repeat(64));
    assert!(error(missing).contains("profiles reference files missing"));
    let mut unsafe_path = two_windows();
    unsafe_path["scripts"][0]["path"] = json!("../app.js");
    unsafe_path["scripts"][0]["sha256"] = json!("0".repeat(64));
    assert!(error(unsafe_path).contains("must not contain"));
    let first = f.profile("first.json", two_windows());
    let second = f.profile("second.json", two_windows());
    assert!(
        format!("{:#}", f.analyze(&[first, second]).unwrap_err())
            .contains("duplicate profile scenario")
    );
}

#[test]
fn excluded_and_unselected_bundles_keep_their_samples_in_a_bucket() {
    let f = three_sources();
    f.write("other.js", "zz");
    let profile = f.profile("open.json", two_windows());
    let excluded = f
        .analyze_with(
            std::slice::from_ref(&profile),
            AnalyzeOptions {
                include: vec!["other.js".into()],
                ..Default::default()
            },
        )
        .unwrap();
    let load = window(&excluded, "open", "load");
    assert!(load.sources.is_empty() && load.top_level.is_empty());
    let bucket = load
        .other
        .iter()
        .find(|b| b.name == "(excluded bundles)")
        .unwrap();
    assert_eq!(bucket.cost.samples, vec![43, 44, 45, 42]);
    assert!(
        excluded.cpu.as_ref().unwrap().scenarios[0]
            .bundles
            .is_empty()
    );
    let selected = f
        .analyze_with(
            &[profile],
            AnalyzeOptions {
                files: Some(vec!["other.js".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        selected
            .warnings
            .iter()
            .any(|w| w == "skipped profile data for unselected file: app.js")
    );
    assert_eq!(
        window(&selected, "open", "load")
            .other
            .iter()
            .find(|b| b.name == "(excluded bundles)")
            .unwrap()
            .cost
            .samples,
        vec![43, 44, 45, 42]
    );
}

#[test]
fn cli_writes_cpu_reports_and_exports_profiles_as_evidence() {
    let f = three_sources();
    f.profile("open.json", two_windows());
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args(args)
            .output()
            .unwrap()
    };
    let output = run(&[
        "--dir",
        ".",
        "--profile",
        "open.json",
        "--json",
        "r.json",
        "--markdown",
        "r.md",
        "--treemap",
        "r.html",
        "--export",
        "evidence",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&fs::read(f.0.join("r.json")).unwrap()).unwrap();
    assert_eq!(
        report["cpu"]["scenarios"][0]["windows"][1]["sources"][0]["source"],
        "src/b.js"
    );
    let markdown = fs::read_to_string(f.0.join("r.md")).unwrap();
    assert!(markdown.contains("## CPU self time"));
    assert!(markdown.contains("| src/a.js | 0.10 | 0.10 to 0.11 | 10.5 | measured |"));
    assert!(markdown.contains("| src/b.js | 0.01 | 0.01 to 0.01 | 1 | insufficient |"));
    assert!(
        fs::read_to_string(f.0.join("r.html"))
            .unwrap()
            .contains("\"minSamples\"")
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(f.0.join("evidence/manifest.json")).unwrap()).unwrap();
    assert!(
        manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["role"] == "profile")
    );
    fs::rename(f.0.join("open.json"), f.0.join("moved.json")).unwrap();
    let replay = run(&["--replay", "evidence", "--json", "replay.json"]);
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replayed: Value =
        serde_json::from_slice(&fs::read(f.0.join("replay.json")).unwrap()).unwrap();
    assert_eq!(replayed["cpu"], report["cpu"]);
    let excerpt = run(&[
        "--dir",
        ".",
        "--profile",
        "moved.json",
        "--export",
        "excerpt",
        "--export-select",
        "app.js",
    ]);
    assert!(
        excerpt.status.success(),
        "{}",
        String::from_utf8_lossy(&excerpt.stderr)
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(f.0.join("excerpt/manifest.json")).unwrap()).unwrap();
    assert!(
        manifest["excerpt"]["omitted"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["role"] == "profile")
    );
    assert_eq!(manifest["invocation"]["profile"], json!([]));
}
