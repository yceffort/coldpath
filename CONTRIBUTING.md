# Contributing

Issues and pull requests are welcome. For incorrect byte counts, include a small generated JavaScript file, its source map, the coverage input, your command, and the expected result. Synthetic reproductions are fine; source maps and reports can contain your application's source code.

## Setup and checks

Rust 1.88+ builds the analyzer with no JavaScript toolchain:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Keep `Cargo.lock` committed and preserve the minimum Rust version. CI checks stable Rust on Linux/macOS and Rust 1.88 on Linux.

For changes to input adapters, report HTML, or the collector, also run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:corpus
```

Use Node.js 24+ and the pnpm version in `package.json`. The repository root is the published `coldpath` npm package: `bin/` and `lib/` ship, and only `@babel/parser` is a runtime dependency (Playwright and `@anthropic-ai/sdk` are optional peers). Everything else is development-only. Generated verification files belong in the ignored `artifacts/` directory.

## Test boundaries

- `tests/analysis.rs`: nested V8 ranges, Unicode offsets, source maps, verification evidence, filters, compression, reports, and budget exits.
- `scripts/verify.mjs`: captures actual Chromium coverage and compares every interval with an independent per-code-unit reference implementation.
- `scripts/verify-formats.mjs`: imports real Playwright and Node coverage, validates Chrome-shaped input, and exercises the offline HTML UI and embedded-data escaping.
- `scripts/verify-collector.mjs`: runs `coldpath collect` as a separate process against a local fixture, including a custom interaction and stale-source rejection.
- `scripts/verify-environment.mjs`: device emulation, viewport override, and saved cookie state must change which fixture functions V8 records; throttled requests must take at least the emulated latency; cookie values must stay out of the envelope.
- `scripts/verify-flows.mjs`: one scenario across a CDN script and a link navigation, including code that runs in the click just before unloading; unlisted origins stay blocked, a stale CDN copy is rejected, and the worker started by the second page stays unmeasured.
- `scripts/verify-treemap.mjs`: checks hierarchical navigation, complete small-file access, area totals, coverage colors/data, search, package grouping, keyboard navigation, offline operation, and mobile layout.
- `scripts/verify-comparison.mjs`: three ordered scenario colors, missing initial evidence, baseline changes, graph locations, estimates, recommendations, scenario-specific inspection, and mobile/offline behavior.
- `scripts/verify-profile.mjs`: `coldpath profile` on the demo with the default runs and sampling interval, stale-build, multi-document, and run-count rejection, the worker warning, and CPU rows in JSON, Markdown, and the treemap.
- `scripts/verify-inferred.mjs`: `coldpath snapshot` against a local site (load causes, an unreachable declared map), exact per-module bytes from `coldpath modules`, `coldpath label` evidence filtering against mock OpenAI-compatible and Anthropic servers, and the annotated treemap.
- `tests/workflows.rs`: scenario ordering/Unicode partitions, missing measurements, compression fragments, graph path selection/validation, actionable evidence, and coverage budget failures.
- `tests/cpu.rs`: profile validation and SHA-256 binding, attribution by UTF-16 function start, insufficient rows, excluded bundles, and profiles in evidence export and replay.
- `scripts/verify-graphs.mjs`: import declaration versus usage positions, type-only syntax, source snapshot evidence, and malformed Turbopack graph rejection.
- `scripts/verify-corpus.mjs`: real esbuild, Rollup, Vite, webpack, and Next/Turbopack builds, native Chromium recordings, independent map oracle and known-origin probes, graph location assertions, plus a source-ownership negative control. Rollup, Vite, and webpack graphs come from the `@yceffort/coldpath/rollup`, `@yceffort/coldpath/vite`, and `@yceffort/coldpath/webpack` exports. [Published results and limitations](docs/accuracy-corpus.md).
- `scripts/verify-package.mjs`: packs `@yceffort/coldpath` and a platform analyzer package, installs both into a fresh npm project, and runs the Rollup plugin, `coldpath graph`, `coldpath collect --scenarios`, `coldpath profile --scenarios`, and `coldpath analyze --scenarios --profile` there.

Do not format or regenerate `examples/recorded/entry.js` or its map as a cosmetic edit. Their exact bytes are part of the recorded coverage's SHA-256 evidence. Source fixtures for new captures live in `fixtures/`.

Preserve the distinction between unobserved and unmeasured code, source verification and map verification, UTF-16 offsets and UTF-8 bytes. A source-map anchor cannot prove that an original source line was fully executed.

## Scope

The project analyzes generated JavaScript bytes. It does not currently produce Istanbul/LCOV test reports, attribute style, layout, or paint time to sources, analyze CSS ([feasibility decision](docs/css-coverage.md)) or automatically remove code. Import-path explanations require a bundler graph or esbuild metafile; source maps alone do not provide an import graph. A [local comparison](benchmarks/RESULTS.md) covers one build and explicit report workflows. There is no supported prebuilt-binary release process yet.

Changes to the CLI or JSON schema should update the usage guide. Contributions are distributed under the project's MIT license.

Graph changes require `pnpm test:corpus`. CI runs the corpus on Linux and macOS. The Next.js fixture deliberately retains a known source-map attribution limitation; `fixtures/corpus/expectations.json` bounds probe errors. Do not raise that bound or alter probes simply to hide failures. Inspect the generated code and map, publish any changed limitations, and update the documented snapshot when intentionally upgrading pinned bundlers.

## Releasing

Set `version` in `package.json` and `Cargo.toml`, commit, and push a matching `v<version>` tag. `.github/workflows/release.yml` builds and tests the analyzer on macOS arm64/x64 and Linux arm64/x64, publishes each `@yceffort/coldpath-<platform>-<arch>` package, adds them to `@yceffort/coldpath`'s `optionalDependencies` (`scripts/release-manifest.mjs`), publishes `@yceffort/coldpath` with npm provenance, and creates a GitHub release. It authenticates with npm trusted publishing (GitHub OIDC) and needs no npm token. Each of the five packages (`@yceffort/coldpath` and the four `@yceffort/coldpath-<platform>-<arch>` packages) must list this repository and `release.yml` as a trusted publisher on npmjs.com; a package without one fails to publish with E404.
