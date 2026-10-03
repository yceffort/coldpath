# Real-build accuracy corpus

Snapshot measured locally on macOS with Node 24.20.0 on 2026-10-04. Reproduce with `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium`, and `pnpm test:corpus`. CI repeats the corpus on Linux/macOS with Node 24. These checks measure agreement with an independent source-map oracle and known-origin literal probes, not exact semantic ownership of every minified byte.

| Build | Version | Generated B | Source-map oracle disagreement | Known-origin probe errors | Scenario/bundle checks |
| --- | --- | ---: | ---: | ---: | ---: |
| esbuild | 0.28.2 | 702 | 0.0000% | 0.0000% (0/67 B) | 4 |
| rollup | 4.64.0 | 968 | 0.0000% | 0.0000% (0/67 B) | 4 |
| vite | 8.3.2 | 2806 | 0.0000% | 0.0000% (0/67 B) | 4 |
| webpack | 5.111.1 | 2783 | 0.0000% | 0.0000% (0/67 B) | 4 |
| next-turbopack | 16.3.8 | 425932 | 0.0000% | 32.8358% (22/67 B) | 17 |

Oracle lookup follows the documented last-mapping-wins rule at duplicate generated coordinates. [`fixtures/corpus/results.json`](../fixtures/corpus/results.json) also publishes `duplicateMappingBytes` and disagreement with the reference library’s default first-duplicate lookup (`defaultOracleDisagreementBytes`); these ambiguities are not hidden.

All builds check static and dynamic import locations, UTF-8 ownership, per-scenario native V8 ranges, and first-observation byte conservation. A negative control relabels a real source while preserving counts and must be detected. This small corpus does not establish an error bound for arbitrary applications or source maps. Re-run on both Linux and macOS in CI; counts can change with pinned toolchain updates.

## Interpreting the Next.js result

The 22/67 B probe error is **32.8358% of these specific marker bytes**, not an estimated error rate for the entire 425,932 B build. Turbopack inlines `drawChart` and `neverDrawn` into JSX event handlers; some mappings inside their literal text point to `page.jsx` instead of `chart.js`. The analyzer and reference decoder agree on those anchors, so reference-map disagreement is zero even though semantic ownership is wrong. The fixture retains this limitation and enforces a maximum of 22 probe errors in `expectations.json`.

Next's maps also contain duplicate generated coordinates. Under coldpath's documented last-mapping-wins policy the oracle agrees. Using trace-mapping's default first-duplicate rule differs at 27 B in runtime chunks; the published snapshot records 3,175 B at duplicate coordinates. Neither convention can recover semantic truth from ambiguous maps.

## What is tested

Each real build has an initially executed source, a statically imported chart action, a dynamically imported search action, and an unvisited action. Outputs include nested chunk directories and Unicode. Three sequential native V8 snapshots record `initial`, `open-report`, and `search`; missing scripts remain unmeasured. Every captured generated UTF-16 offset is checked against an independent pointwise execution oracle; UTF-8 ownership is checked with `@jridgewell/trace-mapping`. First-observation contributions must conserve union-observed bytes.

The graph checks require the actual fixture's chart import line (entry line 2 / Next page line 4), and its dynamic search import line (entry line 7 / Next page line 12). webpack module concatenation remains enabled. A negative control relabels `startup.js` while preserving all byte totals; both source-map and known-origin checks must detect it. This ensures byte conservation alone cannot make the corpus pass.

Generated build files, native captures, JSON reports, graphs, interactive HTML, and fresh metrics stay in `artifacts/accuracy-corpus/`. Only source fixtures, explicit probe-error budgets, and this measured snapshot are versioned. CPU cost, network loading times, all possible bundler options, and arbitrary third-party map quality are outside the measured claims.
