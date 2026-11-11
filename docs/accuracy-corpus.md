# Real-build accuracy corpus

Snapshot measured locally on macOS with Node 24.20.0 on 2026-11-11. Reproduce with `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium`, and `pnpm test:corpus`. CI repeats the corpus on Linux/macOS with Node 24 and on Linux with Node 22.12. These checks measure agreement with an independent source-map oracle and known-origin literal probes, not exact semantic ownership of every minified byte.

| Build | Version | Generated B | Source-map oracle disagreement | Known-origin probe errors | Scenario/bundle checks |
| --- | --- | ---: | ---: | ---: | ---: |
| esbuild | 0.28.2 | 1550 | 0.0000% | 0.0000% (0/67 B) | 5 |
| bun | 1.4.4 | 2158 | 0.0000% | 0.0000% (0/67 B) | 4 |
| rollup | 4.64.0 | 1487 | 0.0000% | 0.0000% (0/67 B) | 4 |
| vite | 8.3.3 | 3490 | 0.0000% | 0.0000% (0/67 B) | 4 |
| vue | 3.5.45 | 65076 | 0.0000% | 0.0000% (0/67 B) | 4 |
| svelte | 5.57.3 | 28802 | 0.0000% | 0.0000% (0/67 B) | 4 |
| webpack | 5.111.1 | 2896 | 0.0000% | 0.0000% (0/67 B) | 4 |
| rspack | 2.3.1 | 2804 | 0.0000% | 23.8806% (16/67 B) | 4 |
| next-turbopack | 16.4.1 | 375409 | 0.0000% | 32.8358% (22/67 B) | 16 |

Oracle lookup follows the documented last-mapping-wins rule at duplicate generated coordinates. [`fixtures/corpus/results.json`](../fixtures/corpus/results.json) also publishes `duplicateMappingBytes` and disagreement with the reference library’s default first-duplicate lookup (`defaultOracleDisagreementBytes`); these ambiguities are not hidden.

All builds check static and dynamic import locations, UTF-8 ownership, per-scenario native V8 ranges, and first-observation byte conservation. A negative control relabels a real source while preserving counts and must be detected. This small corpus does not establish an error bound for arbitrary applications or source maps. Re-run on both Linux and macOS in CI; counts can change with pinned toolchain updates.

## Interpreting the Next.js result

The 22/67 B probe error is **32.8358% of these specific marker bytes**, not an estimated error rate for the entire 375,409 B build. Turbopack inlines `drawChart` and `neverDrawn` into JSX event handlers; some mappings inside their literal text point to `page.jsx` instead of `chart.js`. The analyzer and reference decoder agree on those anchors, so reference-map disagreement is zero even though semantic ownership is wrong. The fixture retains this limitation and enforces a maximum of 22 probe errors in `expectations.json`.

Next's maps also contain duplicate generated coordinates. Under coldpath's documented last-mapping-wins policy the oracle agrees. Using trace-mapping's default first-duplicate rule differs at 9 B, all in the Turbopack runtime chunk; the published snapshot records 2,773 B at duplicate coordinates. Neither convention can recover semantic truth from ambiguous maps.

## Interpreting the Rspack result

The 16/67 B probe error is the whole `CP_CORPUS_CHART_` marker. Rspack's default minifier evaluates `drawChart(1234) + registered(1)` at build time and puts the result, `"CP_CORPUS_CHART_4d2CP_CORPUS_REGISTER_1"`, into `openReport` in `entry.js`, and the map points that literal at the call in `entry.js`. The analyzer and the reference decoder agree there, so reference-map disagreement is zero although the marker's text comes from `chart.js`. The fixture retains this limitation and enforces a maximum of 16 probe errors in `expectations.json`. Because of the same folding, `drawChart` and `registered` never run in `open-report`, so the review actions that the Bun, Vite, Vue, Svelte, and webpack builds must produce for `chart.js` and `register.js` are not required of Rspack; its import locations are. Rspack's maps put 18 B at duplicate generated coordinates, and trace-mapping's default first-duplicate rule differs from last-mapping-wins at 1 B.

## What is tested

Each real build has an initially executed source, a statically imported chart action, a dynamically imported search action, and an unvisited action. Outputs include nested chunk directories and Unicode. Three sequential native V8 snapshots record `initial`, `open-report`, and `search`; missing scripts remain unmeasured. Every captured generated UTF-16 offset is checked against an independent pointwise execution oracle; UTF-8 ownership is checked with `@jridgewell/trace-mapping`. First-observation contributions must conserve union-observed bytes.

The graph checks require the actual fixture's chart import line (entry line 2 / Next page line 4), and its dynamic search import line (entry line 10 / Next page line 13). The vue and svelte rows are Vite 8.3.3 builds with `@vitejs/plugin-vue` 6.0.10 and `@sveltejs/vite-plugin-svelte` 7.3.1, and their version column is the framework's. There these imports sit in a component's script blocks, so the checked lines are lines of the component file: `App.vue` lines 11 and 19, with a `<script>` and a TypeScript `<script setup>`, and `Report.svelte` lines 7 and 15, with a `<script module>`. webpack and Rspack module concatenation remains enabled, and the Rspack graph comes from the webpack plugin. The bun row is a `bun build` with splitting, minification and linked source maps, whose metafile the esbuild adapter reads. It keeps Bun's default flat output names, because Bun 1.4.4 writes a map's `sources` relative to the output directory rather than to the map, so the nested chunk directories of the other builds would give it wrong source paths. A negative control relabels `startup.js` while preserving all byte totals; both source-map and known-origin checks must detect it. This ensures byte conservation alone cannot make the corpus pass.

Generated build files, native captures, JSON reports, graphs, interactive HTML, and fresh metrics stay in `artifacts/accuracy-corpus/`. Only source fixtures, explicit probe-error budgets, and this measured snapshot are versioned. CPU cost, network loading times, all possible bundler options, and arbitrary third-party map quality are outside the measured claims.
