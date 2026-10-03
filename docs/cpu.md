# CPU cost

`coldpath profile` records CPU profiles of a scenario file's scenarios in runs separate from coverage, because the coverage collector's debugger and precise coverage change timing. A CPU number is a distribution over runs, recorded with its sample count, never one run's value.

## Record profiles

```sh
coldpath profile --scenarios coldpath.scenarios.json [--runs N]
```

`profile` reads the same [scenario file](collecting.md#scenario-files) as `collect`, including device, network, CPU throttling, and storage state, and writes `<out>/<name>.profile.json` next to the coverage files. Each run is a fresh browser. Only the V8 sampling profiler runs while a window is measured; the collector enables the debugger after profiling stops and then checks every loaded script under `--prefix` or `--cdn-prefix` against the file in `dir` with SHA-256, as `collect` does. A stale build fails the run.

Each run records two windows:

- `load`: navigation until `networkidle`, plus `waitMs` (1,000 ms by default).
- `action`: the scenario's custom actions. A scenario without actions has only `load`.

Runs alternate between scenarios (run 1 of every scenario, then run 2), so slow drift on the machine affects every scenario alike. `--runs` defaults to 10 and must be at least 2. The sampling interval is fixed at 100 µs.

Scope:

- Only the page's main thread is profiled. Workers run in their own isolates and are not recorded; `profile` prints a warning when a scenario starts one.
- Multi-document navigation flows are not supported. A navigation to a new document after the initial load fails the run; profile each page as its own scenario.
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

## How the defaults were chosen

Issue [#24](https://github.com/yceffort/coldpath/issues/24) profiled the demo and the corpus Vite and webpack builds 20 times per scenario on an Apple M5 and on two GitHub-hosted ubuntu runners (Intel Xeon Platinum 8573C and AMD EPYC 9V45, 4 vCPUs each), with `cpuSlowdown` 1 and 4 and sampling intervals of 100 µs and 1 ms.

- **Sampling interval 100 µs.** V8 achieved one sample per 127 to 153 µs on the M5, depending on the session, and per 162 µs on the runners. At 1 ms, no demo source reached 10 samples per run on any machine.
- **Self time from sample timestamps.** Samples times the window's average interval agreed with timestamps within 2% on the M5 without throttling, but differed by up to 51% on a runner without throttling and by up to 94% with `cpuSlowdown` 4: sampling is irregular on shared VMs and under throttling.
- **10 runs.** The median's spread across resamples (relative interquartile range) was about 3% on the M5 and 6 to 8% on the runners with 10 runs, and 3 to 6% on the runners with 20.
- **CPU throttling is optional.** Profiles use the scenario's `cpuSlowdown`, like coverage. At 4, self time grew about fourfold but samples only 1.7 times on the M5 and 2 times on the runners; run-to-run variation rose on the M5 and stayed about the same on the runners.

The corpus fixtures do almost no work: every corpus source stayed below 10 samples per run in every condition, at most 7.
