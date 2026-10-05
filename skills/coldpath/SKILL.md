---
name: coldpath
description: Use when someone wants to know which JavaScript in a web app they build themselves runs on initial load versus only after an interaction, why a module ends up in the initial bundle, how much shipped JavaScript never executes, what to lazy load or split, which of their source files cost main-thread CPU time during page load or an interaction, whether a change made that CPU time worse, or to enforce JavaScript byte budgets in CI. Applies to Vite, Rollup, webpack, esbuild, and Next.js builds with the @yceffort/coldpath package.
---

# coldpath

## Overview

coldpath records V8 coverage of a production build in Chromium, attributes the executed bytes to original sources through source maps, and explains with the bundler's import graph why each source is loaded. Every number is evidence from the recorded scenarios only: code that no scenario ran is **unobserved**, which never means unused or safe to delete. In separate runs it can also sample main-thread CPU and attribute self time to the same sources (see [CPU cost](#cpu-cost)).

This skill covers apps whose build you control. For a site you cannot build (no source maps, `coldpath snapshot`, `coldpath modules`, `coldpath label`), stop and point the user to <https://github.com/yceffort/coldpath/blob/main/docs/third-party.md> instead of improvising.

## Requirements

- Node.js 24 or newer, macOS or Linux (Windows is not supported).
- `@yceffort/coldpath` 0.3.2 or newer in devDependencies (earlier versions report nearly every later-only static import as `split-review`). Collection also needs Playwright and Chromium. Before adding `playwright` to `package.json`, tell the user; `npm install --no-save playwright` is the non-invasive option for a one-off analysis. Then run `npx playwright install chromium`.
- The npm package ships only the README. Full docs live at <https://github.com/yceffort/coldpath/tree/main/docs>. `npx coldpath --help` lists every analyzer flag.

## Workflow

1. **Enable source maps and graph export** in the real production build config (see [Bundler setup](#bundler-setup)). Without the graph, coldpath still measures bytes but cannot say why a module is loaded.
2. **Build for production.** Never record a dev server: its files, hashes, and maps differ from the build on disk and collection fails or measures the wrong thing.
3. **Write the scenario file and action modules** (see [Scenarios](#scenarios)).
4. **Serve the build on a fixed port.** Use `npx vite preview --host 127.0.0.1 --port 4173 --strictPort`, `npx next start -p 3000`, or any static server for the output directory. Without `--strictPort`, Vite silently moves to another port when the port is busy and the scenario `url` points at the wrong server. If the port is taken, pick a free one and update `url` to match. Run the server in the background and stop only that process when done.
5. **Record:** `npx coldpath collect --scenarios coldpath.scenarios.json`
6. **Analyze:**

   ```sh
   npx coldpath analyze --scenarios coldpath.scenarios.json \
     --graph dist/coldpath.graph.json --source-compression \
     --markdown artifacts/coldpath.md --json artifacts/coldpath.json \
     --treemap artifacts/coldpath.html
   ```

   `--scenarios` already supplies `--dir`, every `--coverage`, `--scenario-order` (file order), and `--initial-scenario` (the first scenario); pass one of them only to override it.
7. **Read `artifacts/coldpath.md` and the stdout summary.** They are bounded (about 20 rows per table) and contain no code. For one source, run the same command with `--why src/path/File.jsx` to print its import chain. `--why` takes a source as the report prints it, or trailing path segments that match exactly one graph source (`node_modules/swiper/modules/pagination.mjs` finds the copy in a pnpm store); when several or none match, the error lists the candidates. Do not add `--details` for your own reading: it embeds source code and span data, and the JSON easily reaches tens of MB. Offer `--details --treemap` to the user only as an HTML report to open in a browser.

## Bundler setup

| Bundler | Config | Graph file |
| --- | --- | --- |
| Vite | `import coldpathGraph from '@yceffort/coldpath/vite'`, `plugins: [coldpathGraph()]` (early in the list), `build: {sourcemap: true}` | `dist/coldpath.graph.json` |
| Rollup | `@yceffort/coldpath/rollup`, same plugin, `output.sourcemap: true` | next to output chunks |
| webpack | `import ColdpathGraphPlugin from '@yceffort/coldpath/webpack'`, `plugins: [new ColdpathGraphPlugin()]`, `devtool: 'source-map'` | `coldpath.graph.json` in `output.path` (`new ColdpathGraphPlugin({fileName})` changes it) |
| esbuild | `metafile: true`, write the metafile, then `npx coldpath graph --format esbuild --input meta.json --root . --out artifacts/graph.json` | `--out` path |

The `--dir` of the scenario file is the build output directory, and `prefix` is the URL path it is served under (Vite default `/`; webpack uses `output.publicPath`).

### Next.js (webpack)

Next.js 15 and earlier build with webpack by default; Next.js 16 needs `next build --webpack`. Add the plugin to the client compilation only:

```js
// next.config.mjs
import ColdpathGraphPlugin from '@yceffort/coldpath/webpack'

export default {
  productionBrowserSourceMaps: true,
  webpack(config, {isServer}) {
    if (!isServer) config.plugins.push(new ColdpathGraphPlugin())
    return config
  },
}
```

`next build` writes `.next/coldpath.graph.json`. Use the scenario `dir` and `prefix` from the Turbopack section below, and pass `--graph .next/coldpath.graph.json --graph-root .` to `analyze`, run from the Next project directory (webpack's `context`), even in a monorepo.

### Next.js (Turbopack)

Order matters, because `next build` deletes the analyzer output under `.next`:

```sh
# next.config: productionBrowserSourceMaps: true
npx next experimental-analyze --output
npx coldpath graph --format turbopack --input .next/diagnostics/analyze \
  --root . --out artifacts/graph.json   # --root is turbopack.root; keep the file outside .next
npx next build
npx next start -p 3000
```

In the scenario file use `"dir": ".next/static"` and `"prefix": "/_next/static/"`. Pass `--graph artifacts/graph.json --graph-root .` (the same Turbopack root) to `analyze`. The adapter is tested against Next.js 16.3.8 and the format is experimental; if it fails on another version, report the error rather than guessing a workaround.

## Scenarios

```json
{
  "url": "http://127.0.0.1:4173/",
  "dir": "dist",
  "out": "artifacts/coverage",
  "scenarios": [
    {"name": "initial"},
    {"name": "open-report", "actions": "scenarios/open-report.mjs"},
    {"name": "settings", "url": "/settings"}
  ]
}
```

```js
// scenarios/open-report.mjs
export default async function ({page}) {
  await page.getByRole('button', {name: 'Open report'}).click()
  await page.getByRole('img', {name: 'Weekly orders'}).waitFor()
}
```

- `initial` (page load only) comes first. List the rest in the order a user would meet them. Paths are relative to the scenario file.
- Each scenario is a fresh browser: page load, `networkidle`, 1 s, then the actions, so every recording includes the initial load.
- **Every action must wait for the visible result of the interaction**, not just click. Otherwise the code it triggers is not recorded and shows up as unobserved.
- Record every interaction the question depends on. A feature nobody exercised is unobserved by construction, so do not draw conclusions about it.
- Take selectors from the real UI. If a browser automation tool (such as a Playwright MCP server) is available, use its accessibility snapshot on the served build; otherwise read the component source for roles, labels, and test ids. Either way, a successful `collect` run is the check.
- For logged-in pages, ask the user for a Playwright storage state file and pass it as `storageState`. Never ask for or type their password.
- Cross-origin requests are blocked except `cdnPrefixes`. An app that needs an external API during the scenario cannot be recorded this way; tell the user.

## Reading the results

| Field | Meaning |
| --- | --- |
| observed | executed in at least one recording |
| unobserved | in a recorded script, never executed in any supplied scenario |
| unmeasured | in a script no recording loaded |

Bytes are generated, uncompressed UTF-8, not original source size or transfer size. Compression figures from `--source-compression` are isolated estimates, not guaranteed savings.

Review actions (`recommendations` in JSON, "Review actions" in Markdown):

| Action | Evidence | What you may propose |
| --- | --- | --- |
| `defer-review` | static import chain; initially nothing ran, or only top-level declarations without side effects | load it behind `import()` or a route boundary at the importing line `--why` shows |
| `split-review` | a function of the source ran initially, or its top-level code calls, constructs, or writes properties | move only the later-only functions to a new module and lazy load that one; if `initialTopLevelOnly` is true, check those top-level statements first |
| `dynamic-boundary-review` | already behind a dynamic import | usually nothing; check the boundary is where you expect |
| `measure-initial` | no initial recording for its bundle | record it in `initial` before concluding anything |
| `inspect-imports` | import path evidence only | show the chain; no change implied |
| `removal-review` | zero observed bytes, fully measured in every scenario | a candidate for the user to investigate, never an instruction to delete |

Each recommendation carries `initialObservedBytes` and `initialTopLevelOnly` in the JSON. The side-effect check scans generated code and misses getters triggered by property reads; when a bundler inlines a module into another source's function (for example Turbopack), its initial bytes count as function execution and the action is `split-review` even for pure declarations. Read the source before deferring either way.

Rules for the answer:

- Say "did not run in these scenarios", never "unused" or "dead". Deletion needs a `removal-review` plus the user confirming no untested path (other routes, error handling, feature flags, other browsers) reaches it.
- Unobserved bytes inside a function that did run are branches the scenarios did not take (validation errors, other inputs). Name those branches and suggest the scenario that would exercise them instead of calling them dead.
- Report measured numbers as they are. If a figure looks wrong (for example unobserved bytes in a function you believe ran), say that it contradicts your reading, name what would confirm it (the treemap inspector, `--why`, an extra scenario), and keep the number. Do not relabel it as source map noise without evidence.
- Most unobserved bytes in dependencies such as `react-dom` are not removable from the app; say so rather than proposing edits inside `node_modules`.
- Give one prioritized change first, with its evidence (source, action, bytes, import chain).

## After a change

Recordings are bound to the exact build by SHA-256. After editing code, rebuild, restart the server, collect again, and compare:

```sh
npx coldpath analyze --scenarios coldpath.scenarios.json --baseline artifacts/before.json \
  --markdown artifacts/after.md --json artifacts/after.json
```

Keep the earlier `--json` report as `before.json` before re-running. Only the new measurement shows the effect.

## CPU cost

For "which of our files make page load or this interaction slow", coldpath reports per-source CPU self time: the time V8's sampling profiler spent in each source's own functions, never in the functions they call. It needs a version whose `npx coldpath --help` lists `coldpath profile`; if that line is missing, tell the user CPU profiling needs a newer `@yceffort/coldpath` instead of profiling some other way.

1. Build, serve, and write scenarios as above, then record both kinds of evidence: `npx coldpath collect --scenarios coldpath.scenarios.json` and `npx coldpath profile --scenarios coldpath.scenarios.json`. `profile` runs every scenario 10 times in fresh browsers with only the profiler on, sampling every 100 µs (fixed), and writes `<out>/<name>.profile.json` next to the coverage files.
2. Analyze with one `--profile` per scenario. `--scenarios` adds the coverage files but never the profiles:

   ```sh
   npx coldpath analyze --scenarios coldpath.scenarios.json \
     --profile artifacts/coverage/initial.profile.json \
     --profile artifacts/coverage/open-report.profile.json \
     --markdown artifacts/coldpath.md --json artifacts/coldpath.json
   ```

3. Read "CPU self time" in the Markdown. Every scenario has a `load` window (navigation until `networkidle`, plus 1 s), and a scenario with actions also has an `action` window, where an interaction's cost is. Report each row's median ms, Q1 to Q3, and samples per run together.

| Row | How to read it |
| --- | --- |
| `measured` | a median of at least 10 self samples per run: a usable number |
| `insufficient` | fewer samples: below what the profiler resolves, neither cheap nor zero. More runs narrow the spread but never raise samples per run |
| no row (treemap: "No function samples") | its functions were never sampled in that window; read it like `insufficient` |
| Top level of a bundle | module-level code of a scope-hoisted bundle (Vite, Rollup) that no single source owns |
| `[unmapped]` | functions starting in bytes no source owns. In webpack builds every module factory starts there, so module evaluation lands here; it is not source map noise |
| `(program)` | parsing, style, layout, and paint, which no source owns |
| `(native)` | DOM and other browser API calls made directly from the bundles |
| `(other scripts)` | scripts outside the analyzed bundles, including Playwright's own work during actions |

Because self time excludes callees, a slow interaction's time often sits in framework or library code (`react-dom`, a chart library), `(native)`, and `(program)` rather than in the component that triggered it. Say so instead of calling that component cheap.

### Comparing CPU

CPU time depends on the machine: two GitHub-hosted runners measured the same build 22 to 32% apart. Compare only profiles of both builds made on one machine in one session, back to back, such as before and after an edit. Each profile records its environment, including the browser, throttling, CPU model, cores, and boot; any difference makes every row of that scenario `inconclusive`, with a warning. Analyze the earlier build with its `--profile` files and `--json artifacts/before.json`, then the new build with its own `--profile` files and `--baseline artifacts/before.json`.

"CPU change from baseline" (`baseline.cpu` in JSON) marks a source and window `regressed` or `improved` only when a rank test across runs stays significant after Holm correction (adjusted p below 0.05) and the shift is at least 25% of the earlier median. `unchanged` means a shift under 25%; anything else, including insufficient or missing rows, is `inconclusive`. Report `inconclusive` as "no reliable comparison" and offer the same-session rerun.

In CI, build and profile both the base and the pull request in one job. The GitHub Action runs `args` in both checkouts, so each checkout needs its own profiles at the same relative paths. There is no CPU budget flag: CPU changes are reported, not enforced.

## CI budgets

Budget flags: `--max-bytes`, `--max-unobserved-bytes`, `--max-unmeasured-bytes`, and with `--baseline`, `--max-added-bytes`, `--max-added-unobserved-bytes`. Exit codes: `0` ok, `1` input or analysis error, `2` budget exceeded (reports are still written) **or** invalid CLI arguments. Check stderr for `budget failed:` before calling it a budget failure. For pull requests, the repository ships a GitHub Action (`uses: yceffort/coldpath@<tag>`) that compares against the base branch and keeps one PR comment; see the README's GitHub Action section.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| hash or "stale" error during collect | the served files differ from `dir`: rebuild, restart the server, and record again |
| timeout waiting for `networkidle` | the page keeps a connection open (polling, websockets); this collector cannot record it, tell the user |
| an action times out | the awaited element never appeared; check the selector against the real UI. Popups: `page.waitForEvent('popup')` |
| everything `[unmapped]` | source maps are disabled or not next to the bundles |
| `requires Playwright` | install Playwright and Chromium as in Requirements |
| `graph has no entry modules`, or a webpack graph far smaller than the build | with `@yceffort/coldpath` 0.6.1 or earlier, the webpack plugin leaves out modules restored from webpack's persistent cache (`.next/cache` in Next.js). Upgrade, or delete the cache and rebuild |
| worker code always unmeasured | workers are not recorded; not a bug in the app |
