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
pnpm lint
pnpm typecheck
pnpm test:browser
pnpm test:corpus
```

Use Node.js 24+ and the pnpm version in `package.json`. The Node code is TypeScript, checked with `strict`. Node runs `.ts` files directly by stripping types, so only erasable syntax is allowed (no `enum`, namespaces, or parameter properties) and type-only imports use `import type`. The repository root is the published `coldpath` npm package. Node does not strip types under `node_modules`, so `bin/` and `lib/` ship compiled: `pnpm build:js` writes JavaScript and declarations to the ignored `build/` directory, and `npm pack` and `npm publish` run it first. `scripts/` and `benchmarks/` run without a build, but `verify-corpus.ts` and the demo's Vite config import the plugins by package name, so `pnpm test:browser` and `pnpm test:corpus` build first. Only `@babel/parser` is a runtime dependency (Playwright and `@anthropic-ai/sdk` are optional peers). Everything else is development-only. Generated verification files belong in the ignored `artifacts/` directory.

The two report pages, the treemap (`--treemap`) and the code inspector (`--html`), are built from `ui/`: TypeScript with React's API on the Preact runtime, which keeps each self-contained report about 200 KB smaller than React would, and StyleX for component styles. Theme tokens, a reset, and element defaults stay in each page's `base.css`, because the browser checks read some token names and inline colors refer to them. `pnpm build:ui` writes `src/ui/report.html` and `src/ui/treemap.html`, which the analyzer embeds, so Rust builds need no JavaScript toolchain. Commit both files with your `ui/` change; CI rebuilds them and fails when they differ. `pnpm dev:ui` serves `/report/` and `/treemap/` with sample payloads from `ui/dev/`, which `node ui/dev/sample.ts` regenerates from `examples/recorded`. The StyleX compiler drops some shorthands without a warning: oxlint's StyleX rules (`valid-styles`, `valid-shorthands`) catch `border`, but not `background`, so write longhands such as `backgroundColor`.

## Test boundaries

- `tests/analysis.rs`: nested V8 ranges, Unicode offsets, source maps, verification evidence, filters, compression, reports, and budget exits.
- `scripts/verify.ts`: captures actual Chromium coverage and compares every interval with an independent per-code-unit reference implementation.
- `scripts/verify-formats.ts`: imports real Playwright and Node coverage, validates Chrome-shaped input, and exercises the offline HTML UI and embedded-data escaping.
- `scripts/verify-collector.ts`: runs `coldpath collect` as a separate process against a local fixture, including a custom interaction and stale-source rejection.
- `scripts/verify-environment.ts`: device emulation, viewport override, and saved cookie state must change which fixture functions V8 records; throttled requests must take at least the emulated latency; cookie values must stay out of the envelope.
- `scripts/verify-flows.ts`: one scenario across a CDN script and a link navigation, including code that runs in the click just before unloading; unlisted origins stay blocked, a stale CDN copy is rejected, and the worker started by the second page stays unmeasured.
- `scripts/verify-treemap.ts`: checks hierarchical navigation one level deep, complete small-file access, merged small tiles, the Area switch, area totals, coverage colors/data, the details panel on hover, focus, and touch, labels that fit their tiles, zoom motion, search, package grouping, keyboard navigation, offline operation, and mobile layout.
- `scripts/verify-comparison.ts`: three ordered scenario colors, missing initial evidence, baseline changes, graph locations, estimates, recommendations, scenario-specific inspection, and mobile/offline behavior.
- `scripts/verify-profile.ts`: `coldpath profile` on the demo with the default runs and sampling interval, stale-build, multi-document, and run-count rejection, the worker warning, CPU rows in JSON, Markdown, and the treemap, and a controlled regression detected against an unchanged rerun.
- `scripts/verify-inferred.ts`: `coldpath snapshot` against a local site (load causes, an unreachable declared map), exact per-module bytes from `coldpath modules`, `coldpath label` evidence filtering against mock OpenAI-compatible and Anthropic servers, and the annotated treemap.
- `tests/workflows.rs`: scenario ordering/Unicode partitions, missing measurements, compression fragments, graph path selection/validation, actionable evidence, and coverage budget failures.
- `tests/cpu.rs`: profile validation and SHA-256 binding, attribution by UTF-16 function start, insufficient rows, excluded bundles, baseline rank tests across environments, and profiles in evidence export and replay.
- `scripts/verify-graphs.ts`: import declaration versus usage positions, type-only syntax, source snapshot evidence, and malformed Turbopack graph rejection.
- `scripts/verify-corpus.ts`: real esbuild, Rollup, Vite, webpack, and Next/Turbopack builds, native Chromium recordings, independent map oracle and known-origin probes, graph location assertions, plus a source-ownership negative control. Rollup, Vite, and webpack graphs come from the `@yceffort/coldpath/rollup`, `@yceffort/coldpath/vite`, and `@yceffort/coldpath/webpack` exports. [Published results and limitations](docs/accuracy-corpus.md).
- `scripts/verify-package.ts`: packs `@yceffort/coldpath` and a platform analyzer package, installs both into a fresh npm project, and runs the Rollup plugin, `coldpath graph`, `coldpath collect --scenarios`, `coldpath profile --scenarios`, and `coldpath analyze --scenarios --profile` there.

Do not format or regenerate `examples/recorded/entry.js` or its map as a cosmetic edit. Their exact bytes are part of the recorded coverage's SHA-256 evidence. Source fixtures for new captures live in `fixtures/`.

Preserve the distinction between unobserved and unmeasured code, source verification and map verification, UTF-16 offsets and UTF-8 bytes. A source-map anchor cannot prove that an original source line was fully executed.

## Scope

The project analyzes generated JavaScript bytes. It does not currently produce Istanbul/LCOV test reports, attribute style, layout, or paint time to sources, analyze CSS ([feasibility decision](docs/css-coverage.md)) or automatically remove code. Import-path explanations require a bundler graph or esbuild metafile; source maps alone do not provide an import graph. A [local comparison](benchmarks/RESULTS.md) covers one build and explicit report workflows. There is no supported prebuilt-binary release process yet.

Changes to the CLI or JSON schema should update the usage guide. Contributions are distributed under the project's MIT license.

Graph changes require `pnpm test:corpus`. CI runs the corpus on Linux and macOS. The Next.js fixture deliberately retains a known source-map attribution limitation; `fixtures/corpus/expectations.json` bounds probe errors. Do not raise that bound or alter probes simply to hide failures. Inspect the generated code and map, publish any changed limitations, and update the documented snapshot when intentionally upgrading pinned bundlers.

## Releasing

Set `version` in `package.json`, `Cargo.toml`, and `.claude-plugin/plugin.json`, commit, and push a matching `v<version>` tag. Claude Code updates an installed plugin only when the plugin version changes, so the release job stops when `plugin.json` does not match. `.github/workflows/release.yml` builds and tests the analyzer on macOS arm64/x64 and Linux arm64/x64, publishes each `@yceffort/coldpath-<platform>-<arch>` package, adds them to `@yceffort/coldpath`'s `optionalDependencies` (`scripts/release-manifest.ts`), publishes `@yceffort/coldpath` with npm provenance, and creates a GitHub release. It authenticates with npm trusted publishing (GitHub OIDC) and needs no npm token. Each of the five packages (`@yceffort/coldpath` and the four `@yceffort/coldpath-<platform>-<arch>` packages) must list this repository and `release.yml` as a trusted publisher on npmjs.com; a package without one fails to publish with E404.
