# Reproduce the comparison

The [measured results](RESULTS.md) compare coldpath 0.1.0, source-map-explorer 2.5.3, and monocart-coverage-reports 2.13.0. These scripts are independent of the analyzer's dependencies. Raw generated reports live in the ignored `artifacts/comparison/` directory; compact evidence is in `results/`.

Use Node.js 24 and Python 3 on macOS or Linux. Install the main project's dev dependencies for the real Chromium reproductions, and the separate benchmark dependencies:

```sh
cargo build --locked --release
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm --dir benchmarks install --frozen-lockfile
```

## Recorded example and small regression

From the repository root:

```sh
node benchmarks/prepare.ts
node benchmarks/prepare.ts --name recorded-union \
  --coverage examples/recorded/initial.coverage.json \
  --coverage examples/recorded/interaction.coverage.json

node benchmarks/capture-regression.ts
node benchmarks/evaluate.ts \
  recorded recorded-union regex-template regex-plain regex-control
```

The regression script creates three small valid JavaScript programs, runs them in Chromium, and saves actual V8 recordings. The evaluator compares native UTF-16 ranges and UTF-8 byte totals with an independent point-by-point oracle, then runs both other tools. It records comparator failures as outcomes, rather than hiding them. The generated-only Monocart diagnostic retains source text (`logging: debug`) and prevents source-map loading with its resolver hook. Normal Monocart runs use source maps and ordinary logging.

`benchmarks/results/correctness.json` is overwritten with the selected datasets. No dependency source is patched, and no issues or comments are sent upstream.

## A real build

The published measurements use the blog experiment's preserved baseline build and its `baseline-initial.coverage.json`. Generated bundles and original-source payloads are not checked into this repository. Use a saved build and a hash-bound capture from that exact build:

```sh
node benchmarks/prepare.ts --dir /path/to/saved/static \
  --coverage /path/to/initial.coverage.json --name blog-measured --measured
node benchmarks/prepare.ts --dir /path/to/saved/static \
  --coverage /path/to/initial.coverage.json --name blog-all
node benchmarks/prepare.ts --dir /path/to/saved/static \
  --coverage /path/to/initial.coverage.json --name blog-mapped --mapped

node benchmarks/evaluate.ts
python3 benchmarks/measure.py --node node --rounds 9
```

`blog-measured` contains scripts with observations; `blog-all` contains every generated script; `blog-mapped` selects mapped scripts for the common static-analysis workload. The last comparison deliberately excludes mapless files because source-map-explorer cannot include those in a successful complete report. The full-directory compatibility outcome is recorded separately.

Preparation checks captured JavaScript and map hashes before copying inputs. It preserves generated text and maps, creates Playwright-shaped inputs for coldpath/Monocart, and normalizes the same ranges to Chrome export format for source-map-explorer. The latter normalization is checked independently and is outside timed measurements. The preparation helper currently expects adjacent or final-line relative external maps, matching these preserved inputs.

Timing uses fresh child processes in randomized serial order: one warmup and nine measured repetitions per task, with a fixed seed. It includes process startup, parsing, analysis, and report writes. It excludes installation, compilation, input conversion, and browser capture. Filesystem caches are warm. `wait4` records each child's maximum resident set size, not a sampled heap estimate. No analyzer runs concurrently with another in this harness. JSON schemas and HTML functionality differ, so timings represent complete configured workflows, not equal algorithms.

The Node wrapper preserves source-map-explorer source names (`noRoot: true`) and uses its documented `noBorderChecks: true` fallback for successful timing runs. Strict runs are still included in correctness results. Monocart's timed HTML uses `inline: true` to make a single offline file, matching the other tools' output form.

Outputs:

- `artifacts/comparison/evaluation/`: complete native reports, errors, and diagnostic ranges.
- `artifacts/comparison/runs/`: report and process log for every measurement.
- `artifacts/comparison/timings.jsonl`: every raw process measurement, including warmups.
- `artifacts/comparison/measurements.json`: environment and median/min/max summaries.
- `benchmarks/results/correctness.json`: compact correctness and compatibility outcomes.

For a single manual run:

```sh
node benchmarks/run-tool.ts sme \
  artifacts/comparison/inputs/blog-measured artifacts/comparison/manual/sme json relaxed
node benchmarks/run-tool.ts monocart \
  artifacts/comparison/inputs/blog-measured artifacts/comparison/manual/monocart html default
```

Set `COMPARISON_DIAGNOSTICS=1` for full intermediate rows in `summary.json`. It is explicitly disabled during timing to avoid duplicate diagnostic serialization. The native report is always written.

## Profile the Rust implementation

After preparing `blog-mapped` and `blog-measured` and building the production release binary:

```sh
python3 benchmarks/profile.py --rounds 9
python3 benchmarks/profile-lookup.py
```

Both scripts create isolated source copies and binaries under ignored `artifacts/profiling/`. They preserve production source files and the production release binary, compare complete output bytes, and record fresh-process measurements in `benchmarks/results/profile*.json`. Run them sequentially. The second script is a diagnostic change to aggregation key lookups, not a production patch. See the [profiling findings](PROFILE.md).

These historical scripts now obtain their source and baseline executable from the pinned original commit through `baseline.py`, so later analyzer changes do not change what they profile.

## Measure the optimized explorer

After preparing the same inputs and installing the benchmark dependencies:

```sh
python3 benchmarks/baseline.py
cargo build --release --locked
python3 benchmarks/measure-mvp.py --node node --rounds 9
```

The baseline helper reads commit `537b08500d0a0df2f543ebb63460da4ff441d15f` into ignored `artifacts/baseline/`, without changing the working tree. The measurement script compares the baseline, current release binary, and source-map-explorer serially. It verifies byte-identical baseline/current summary JSON after every round and records all samples in `results/mvp-measurements.json`. Compact treemaps and full code inspectors are separate workloads. See [MVP features and measured results](MVP.md).
