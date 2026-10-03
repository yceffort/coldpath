# CPU cost

coldpath can add a CPU axis to the same sources it already explains: per-source self time in each scenario, measured in separate profile runs and joined with the byte, coverage, and import evidence. Three rules shape the output:

- Executed is not expensive, and expensive is not unnecessary.
- Not sampled is not cheap. A source the profiler rarely hit is reported as `insufficient`, and one it never hit as having no function samples, never as a small number.
- A CPU number is a distribution over runs, reported with its sample count and spread, never one run's value.

## Record profiles

```sh
coldpath profile --scenarios coldpath.scenarios.json [--runs N]
```

`profile` reads the same [scenario file](collecting.md#scenario-files) as `collect`, including device, network, CPU throttling, and storage state, and writes `<out>/<name>.profile.json` next to the coverage files. Each run is a fresh browser. Only the V8 sampling profiler runs while a window is measured; the collector enables the debugger after profiling stops and then checks every loaded script under `--prefix` or `--cdn-prefix` against the file in `dir` with SHA-256, as `collect` does; a sampled script that V8 already discarded, such as one that ran once, is checked from its network response. A stale build fails the run, and so does a run in which no script matches the prefixes.

Each run records two windows:

- `load`: navigation until `networkidle`, plus `waitMs` (1,000 ms by default).
- `action`: the scenario's custom actions. A scenario without actions has only `load`.

Runs alternate between scenarios (run 1 of every scenario, then run 2), so slow drift on the machine affects every scenario alike. `--runs` defaults to 10 and must be at least 2. The sampling interval is fixed at 100 µs.

Scope:

- Only the page's main thread is profiled. Workers run in their own isolates and are not recorded; `profile` prints a warning when a scenario starts one.
- Multi-document navigation flows are not supported. A navigation that commits a new document after the initial load fails the run (a download or a 204 response commits none); profile each page as its own scenario.
- Playwright evaluates selectors and waits inside the page, on the same main thread. That time appears in the `(other scripts)` bucket of action windows, not in any source.

The file binds each loaded script by `path`, `sha256`, and `sourceMapSha256`, like a coverage envelope, and stores self samples and self time per function start offset instead of raw profiles. Each value is a cell with one entry per run. An abbreviated two-run file:

```json
{
  "schemaVersion": 1,
  "scenario": "open-report",
  "runs": 2,
  "samplingIntervalUs": 100,
  "environment": {"browser": "153.0.8010.12", "cpuSlowdown": 1, "machine": {"cpu": "Apple M5", "cores": 10, "boot": "A3AAA125-AD64-4166-8DA0-4DF64550F410"}},
  "windows": {
    "load": {
      "durationUs": [1508734, 1509120],
      "samples": [11632, 11640],
      "buckets": {"(idle)": {"samples": [11599, 11605], "selfUs": [1494870, 1495410]}}
    },
    "action": {
      "durationUs": [48440, 47920],
      "samples": [372, 368],
      "buckets": {"(other scripts)": {"samples": [25, 24], "selfUs": [3240, 3100]}}
    }
  },
  "scripts": [
    {
      "path": "assets/index-DOnGehAw.js",
      "sha256": "77a378fe...",
      "sourceMapSha256": "7fce70f6...",
      "topLevel": {"load": {"samples": [2, 1], "selfUs": [252, 134]}, "action": {"samples": [0, 0], "selfUs": [0, 0]}},
      "functions": [
        {"offset": 15735, "windows": {"load": {"samples": [30, 29], "selfUs": [3862, 3740]}, "action": {"samples": [1, 0], "selfUs": [131, 0]}}}
      ]
    }
  ]
}
```

`environment` records the same capture settings as a coverage envelope, plus `machine`.

`offset` is the UTF-16 offset V8 reports for a function, which is the start of its parameter list, not the `function` keyword. It is not a coverage `startOffset`. Every sample of a window is counted exactly once: in a function, a script's top level, or a bucket. A sample lasts until the next sample of its window, as in the browser's Performance panel.

## Join profiles in the report

```sh
coldpath analyze --scenarios coldpath.scenarios.json \
  --profile artifacts/coverage/initial.profile.json \
  --profile artifacts/coverage/open-report.profile.json \
  --json artifacts/report.json --markdown artifacts/summary.md --treemap artifacts/report.html
```

`--profile` is repeatable, one file per scenario, and works with or without coverage. `analyze --scenarios` also adds every scenario's coverage file, so run `collect` first, or pass `--dir` and `--profile` to the analyzer alone, as in `coldpath --dir dist --profile artifacts/coverage/initial.profile.json`. A profile binds to an analyzed bundle by path and SHA-256, and to its source map by SHA-256; a mismatch is an error, like stale coverage. Profiles of bundles left out by `--include`/`--exclude` or by a file selection move to the `(excluded bundles)` bucket. A profile that references a file missing from the analysis root is an error. Without `--profile` the output is unchanged.

Attribution follows the function, not the line: minified bundles are mostly one line, so V8's per-line ticks cannot separate sources. Each function's self time goes to the source that owns the byte at its start position, by the same source-map attribution as bytes. Code a minifier inlined into another function counts toward that containing function. Module evaluation that runs in a bundle's top level (for example a scope-hoisted Vite or Rollup chunk) is reported per bundle under `topLevel`, because no single source owns it. A function that starts in bytes no source owns counts toward `[unmapped]`; in webpack builds, every module factory starts in such a wrapper, so module evaluation lands in `[unmapped]` rather than in each module's row.

The JSON report gets a separate `cpu` section; byte rows never contain CPU fields:

- `cpu.minSamples`, `cpu.method`.
- `cpu.scenarios[]`: `scenario`, `runs`, `samplingIntervalUs`, `environment`, `bundles` (the analyzed bundles these runs loaded), and `windows[]`.
- `windows[]`: `window`, per-run `durationUs` and total `samples`, `medianDurationUs`, and rows in `sources` (with `package`), `packages`, `topLevel` (by bundle `path`), and `other` (buckets).
- Every row: `status` (`measured` or `insufficient`), per-run `samples` and `selfUs`, `medianSamples`, and `medianUs`, `q1Us`, `q3Us`. Quartiles interpolate linearly between runs.

A row exists when its functions were sampled in at least one run. A source of a bundle listed in `bundles` with no row in a window had no function samples there: its functions' cost is below what the profiler resolved, not zero, and its module-level code counts toward the bundle's `topLevel` (or `[unmapped]`, as above). A source whose bundles were not loaded has no CPU value for that scenario.

Buckets in `other`:

| Bucket | Time |
| --- | --- |
| `(program)` | Browser work outside JavaScript, such as parsing, style, layout, and paint. Out of scope for source attribution. |
| `(garbage collector)` | V8 garbage collection. |
| `(idle)` | The main thread was idle. |
| `(native)` | Native API calls (DOM methods and other browser APIs) made directly from profiled bundles: scripts under the scenario's `prefix` or `cdnPrefixes`. |
| `(other scripts)` | Scripts that are not profiled bundles (inline and evaluated code, other origins, Playwright's injected scripts) and the native calls they make. |
| `(excluded bundles)` | Analyzed bundles left out by filters or by the file selection. |

Markdown lists, per scenario and window, the 10 sources and the 5 bundle top levels with the largest median self time, and the buckets; the JSON report has every row. The section follows the baseline comparison, so a long report does not push the byte changes out of a pull request comment. Selecting a source in the treemap shows its self time for every scenario window whose profile loaded one of its bundles, including `No function samples`, and the top level of those bundles where it was measured.

### Insufficient values

A row is `insufficient` when its median self samples per run is below 10. Such a value is shown with its samples so it is not mistaken for a cost of zero, but it is not reliable. In the demo, `ReportChart.jsx` renders in the `open-report` action window in microseconds; its median was 0 to 2 samples per run on every machine and condition measured, so it is reported as `insufficient`. `format.js` creates `Intl.NumberFormat` instances during page load and is measured at about 3.9 ms on an Apple M5.

## Compare with a baseline

When the current report and the `--baseline` report both have profiles, `baseline.cpu` compares every source in each scenario window that both reports profiled. A scenario or window that only one report profiled is not compared, with a warning. Each row of `baseline.cpu.sources` has:

- `before` and `after`: status, median self time with quartiles, and median samples per run. A source that the report's profiled bundles contain but that had no function samples counts as `insufficient` with zero samples; `null` means none of the report's profiled bundles contain the source.
- `shiftUs`: the Hodges-Lehmann shift of per-run self time, after minus before; `relativeShift`: the shift divided by the baseline median.
- `pValue`: a two-sided Mann-Whitney U test of the per-run values, exact without ties and otherwise a normal approximation with tie and continuity corrections; `adjustedPValue`: Holm-adjusted across all compared rows (`compared`).
- `change`: `regressed` or `improved` when the adjusted p-value is below 0.05 and the shift is at least 25% of the baseline median; `unchanged` when the shift is smaller than 25%; `inconclusive` otherwise.

A row that is `insufficient` or missing in either report is `inconclusive`, never `unchanged`, even when the other report measured a large value; Markdown lists those rows with both reports' samples so they are not hidden. A scenario whose profile `environment` (browser, emulation, throttling, or machine) or sampling interval differs from the baseline is `inconclusive` in every row, with a warning naming the difference.

Profile the baseline and the current build on the same machine in one session, back to back. The machine identity includes the CPU model, core count, and boot. Two GitHub-hosted runners measured the same sources a median 22 to 24% apart and up to 32%, more than the minimum effect, and the Apple M5's medians differed from either runner's by 83 to 199%.

### In CI

Comparisons are meaningful within one job: build the base and the pull request, profile both on that runner, and pass the profiles to both analyses. With the [GitHub Action](../README.md#github-action), list the profile files in `args` and use `base-directory`; the comment then includes CPU changes. The same `args` run in the base checkout, so its profiles must be at the same relative paths there. A `baseline` report from another run carries profiles from another machine, so its CPU rows are inconclusive. Runners are noisier than a workstation (see below); `--runs 20` narrows the spread. GitHub's macOS runners are virtual machines whose profiler sampled every 0.5 to 1.3 ms instead of 100 µs, a third to an eighth as often as a Linux runner, so far fewer sources reach 10 samples per run there; profile on Linux runners.

## How the defaults were chosen

Issue [#24](https://github.com/yceffort/coldpath/issues/24) profiled the demo and the corpus Vite and webpack builds 20 times per scenario on an Apple M5 and on two GitHub-hosted ubuntu runners (Intel Xeon Platinum 8573C and AMD EPYC 9V45, 4 vCPUs each), with `cpuSlowdown` 1 and 4 and sampling intervals of 100 µs and 1 ms.

- **Sampling interval 100 µs.** V8 achieved one sample per 127 to 153 µs on the M5, depending on the session, and per 162 µs on the runners. At 1 ms, no demo source reached 10 samples per run on any machine.
- **Self time from sample timestamps.** Samples times the window's average interval agreed with timestamps within 2% on the M5 without throttling, but differed by up to 51% on a runner without throttling and by up to 94% with `cpuSlowdown` 4: sampling is irregular on shared VMs and under throttling.
- **10 samples per run.** Without throttling, sources with 10 or more samples per run varied between runs by a coefficient of variation of 0.02 to 0.08 on the M5 and 0.11 to 0.20 on the runners; below 5 samples it was 0.5 or more.
- **10 runs.** The median's spread across resamples (relative interquartile range) was about 3% on the M5 and 6 to 8% on the runners with 10 runs, and 3 to 6% on the runners with 20.
- **25% minimum effect.** Comparing the first 10 runs with the last 10 of the same build never reported a change. Over 2,000 random 10-and-10 splits, the rule above reported a change in 0% of splits on the M5 and 0.6% on the runners; with a 20% minimum it would be 1.4 to 1.5%.
- **CPU throttling is optional.** Profiles use the scenario's `cpuSlowdown`, like coverage. At 4, self time grew about fourfold but samples only 1.7 times on the M5 and 2 times on the runners; run-to-run variation rose on the M5 and stayed about the same on the runners.

The corpus fixtures do almost no work: every corpus source stayed below 10 samples per run in every condition, at most 7.
