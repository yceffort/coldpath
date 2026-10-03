# Analyzing a site you do not build

When you cannot build a site yourself, you usually have no source maps, no bundler graph, and no local copy of its scripts. Three commands fill part of that gap. Each one records its own kind of evidence, and the report keeps those kinds separate.

| Command | Produces | Kind of evidence |
| --- | --- | --- |
| `coldpath snapshot` | served scripts, their V8 coverage, and what caused each script to load | measured in Chromium |
| `coldpath modules` | one synthetic source per webpack module factory | recovered from the bundle's own structure |
| `coldpath label` | a summary of each source and, for recovered modules, a guessed identity | a language model's inference |

```sh
npm install --save-dev playwright @anthropic-ai/sdk
npx playwright install chromium

coldpath snapshot --url https://example.com/ --out artifacts/site
coldpath modules --dir artifacts/site/files --out artifacts/site/modules --maps-json artifacts/site/maps.json --chunks
coldpath analyze --dir artifacts/site/files --coverage artifacts/site/coverage.json --url-prefix https:// \
  --maps-json artifacts/site/maps.json --maps-json artifacts/site/modules/maps.json \
  --loading artifacts/site/loading.json --details --json artifacts/site/report.json
coldpath label --report artifacts/site/report.json --out artifacts/site/labels.json
coldpath analyze --dir artifacts/site/files --coverage artifacts/site/coverage.json --url-prefix https:// \
  --maps-json artifacts/site/maps.json --maps-json artifacts/site/modules/maps.json \
  --loading artifacts/site/loading.json --labels artifacts/site/labels.json --details --treemap artifacts/site/report.html
```

Use `--url-prefix http://` for plain HTTP sites. Both prefixes may be passed.

## snapshot

`coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE] [--scenario NAME]` loads the page once in Chromium with precise V8 coverage, waits for `load` plus `--wait-ms` (default 5,000), runs an optional action module (the same `{page, context}` interface as [`collect`](collecting.md#custom-interactions)), and writes:

- `files/<host>/<path>`: the exact text of every external `.js`, `.mjs`, and `.cjs` script. Coverage is Playwright-format with source text, so the analyzer compares each file with what was recorded.
- `coverage.json`: the recording. Inline scripts are left out.
- `maps.json`: explicit map bindings for scripts that declare a `sourceMappingURL`. A map the snapshot could fetch is saved at its own URL path under `files/`, so relative source paths inside it resolve as they would on the site. A declared map that could not be fetched is bound to an empty map under `maps/`, so the analyzer treats the script as unmapped instead of failing. The analyzer itself never fetches.
- `loading.json`: why each script loaded (see below).

Actions may follow links or otherwise navigate the whole page. As in [`collect`](collecting.md#multi-page-flows), every document gets an empty `beforeunload` listener with a debugger breakpoint, so each document's coverage is saved just before it unloads, including code its click handlers ran on the way out. All documents of one visit go into one recording, where a script can appear once per document; the analyzer unions them. A script whose text changes between documents fails the snapshot. Code that runs after `beforeunload` (such as `pagehide` or `unload` handlers) is not recorded.

With `--scenario NAME`, the recording goes to `coverage/NAME.json` instead, and repeated snapshots into the same directory accumulate: scripts, map bindings, and load causes from earlier visits are kept, and a later visit only adds scripts it saw first. If the site serves a script whose text differs from the copy already saved, the snapshot fails, because recordings of different builds cannot be combined. Each visit starts a fresh browser, so an interaction scenario also contains its own initial load. Pass the recordings in visit order, with the analyzer's scenario name being the file name:

```sh
for s in initial search; do coldpath snapshot --url https://example.com/ --out artifacts/site --scenario $s $([ $s = search ] && echo --actions search.mjs); done
coldpath analyze --dir artifacts/site/files --url-prefix https:// \
  --coverage artifacts/site/coverage/initial.json --coverage artifacts/site/coverage/search.json \
  --initial-scenario initial.json --scenario-order initial.json,search.json ...
```

Unlike `collect`, `snapshot` does not block cross-origin requests and has no local build to check against: the saved text is the only evidence of what ran. Keep the snapshot directory together; a later visit may serve different files. To hand an analysis to someone else, add `--export DIRECTORY` to the analyze command (see [evidence export and replay](usage.md#evidence-export-and-replay)).

### Load causes

| `load` | Meaning |
| --- | --- |
| `html` | The HTML of the document that requested the script references the URL in a `<script src>` or `<link href>` tag. |
| `inline` | No tag references it, but its file name appears elsewhere in that document's HTML, for example in a Next.js RSC payload or an inline loader snippet. This is a text match. |
| `dynamic` | Neither: other scripts requested it at runtime (dynamic `import()`, injected tags). |

Each entry also records the Chrome DevTools Protocol `initiator` type and `startMs`, the request start relative to the first request of the visit. The requesting document is the request's `documentURL`; a script first requested by a later document is classified against that document's HTML. A load cause says what requested a script, not whether it was needed for the first render.

## modules

`coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--graph FILE]` parses every script with `@babel/parser` and looks for chunk registrations with one function per module:

- webpack chunks: `(self.webpackChunk<name> = ...).push([[chunk ids], modules])`, where `modules` is `{id: factory}`, webpack 5's method shorthand `{id(e, t, n) {...}}`, or the array form `[factory, ...]`, and webpack 4's default `(this.webpackJsonp = ...).push(...)`. A renamed global (webpack 5 `output.chunkLoadingGlobal`, webpack 4 `jsonpFunction`) is recognized when every module in the registration is a function.
- webpack entry chunks: the runtime keeps entry modules in its own table, `(() => {var e = {id(e, t, n) {...}}; ...})()` in webpack 5 or `!function(e){...}([factories])` in webpack 4. A table counts only when the runtime calls it as `e[id](module, exports, require)`. Its modules share the chunk global the runtime pushes to, so ids resolve across entry and async chunks; a runtime that loads no chunks names them `runtime/<bundle path>`.
- Turbopack: `(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([currentScript, id, factory, id, factory, ...])`.

### Checked builds

`scripts/verify-recovery.ts` (part of `pnpm test:corpus`) builds the corpus with source maps, recovers modules while ignoring the maps, and uses the maps as ground truth: each recovered module should contain mapping segments from exactly one original source, no source may own two recovered modules in one chunk, and no original code may sit outside the recovered modules. Measured on 2026-09-27:

| Build | Version | Chunks | Modules | Async loaders | One source | Several sources | No mapped source | Mappings outside modules |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| webpack, object form | 5.111.1 | 3 | 15 | 0 | 15 | 0 | 0 | 0 |
| webpack, array form (`moduleIds: 'natural'`) | 5.111.1 | 3 | 15 | 0 | 15 | 0 | 0 | 0 |
| webpack, custom `chunkLoadingGlobal` | 5.111.1 | 3 | 15 | 0 | 15 | 0 | 0 | 0 |
| webpack, module federation remote | 5.111.1 | 4 | 16 | 0 | 16 | 0 | 0 | 0 |
| webpack, `concatenateModules` | 5.111.1 | 3 | 10 | 0 | 9 | 1 | 0 | 0 |
| Next.js Turbopack | 16.3.6 | 7 | 158 | 7 | 143 | 5 | 3 | 0 |
| Next.js Turbopack | 15.5.25 | 7 | 156 | 7 | 141 | 5 | 3 | 0 |

"Several sources" are merges made by the bundler (module concatenation, Turbopack's scope hoisting), not recovery errors. Async loaders are Turbopack's generated `e.v(...)` stubs, which have no source of their own. The only newer Next.js than 16.3.6 at the time was a canary, so an older release was checked instead.

A public Vite site (`https://vite.dev/`, VitePress, snapshot on 2026-09-25) served 7 scripts (427,049 B) without source maps. `coldpath modules` recovered 0 modules there, as expected for scope-hoisted output, and `--chunks` turned each script into one whole-chunk source; the report showed 216,493 B (51%) not executed on the initial load.

Not recognized, or not checked:

- webpack output wrapped as a library (`output.library` UMD or similar), where the runtime is not a top-level function call.
- A module federation `remoteEntry.js` holds no module table in the checked build; its exposed modules live in ordinary chunks, which are recognized.
- webpack 4 is checked only with hand-written fixtures; Rspack and other webpack-compatible bundlers are not checked.

For each chunk it writes a source map in which every module's factory body becomes the source `webpack://inferred/<chunk global>/<module id>.js` with that text as `sourcesContent`. The factory header (`id:(e,t,n)=>` or `id:function(e,t,n)`) is left out.

With `--chunks`, a script without recognizable modules (for example Rollup or Vite output) becomes a single source, `webpack://inferred/chunk/<bundle path>`, holding the whole file. That gives `label` something to read; it recovers no boundaries.

With `--graph FILE`, it also writes a dependency graph in the [adapter format](graphs.md#exported-contract-and-evidence-limits), so `--graph` and `--why` work without a bundler export. Pass the file to the analyzer's `--graph`; `--graph-root` does not affect recovered sources. Each edge is a call through a factory's own require binding with a literal module id, located in the recovered source:

| Bundler | Call | Edge kind |
| --- | --- | --- |
| webpack | `n(id)` | `unknown` (a static import and a `require()` compile to the same call) |
| webpack | `n.bind(n, id)`, `n.t.bind(n, id, mode)` | `dynamic` |
| Turbopack | `e.i(id)` / `e.r(id)` | `static` / `require` |
| Turbopack | `e.A(id)`, and `t(id)` inside a loader's `e.v(t => ...)` | `dynamic` |

The graph's `bundler` is `recovered` and it carries a warning saying so. Entries are modules that no recovered factory loads, which includes modules loaded only by the runtime or by chunks that were not captured. Self references and ids without a recovered factory are left out and counted in warnings. A nested function that rebinds the require name (for example a browserify bundle inside a module) is skipped, so its ids never become edges; this can also drop real edges in such a function. A module shipped in several chunks becomes one graph module; if its copies differ, its edge locations and source hash are omitted.

`--maps-json` takes existing bindings such as the snapshot's `maps.json`. Scripts bound to a map that has sources are skipped, so a real map is never replaced by a recovered one. Scripts bound to an empty map are treated as unmapped. Chunk wrappers stay unmapped. `maps.json` lists the bindings; pass it after the snapshot's `maps.json` so recovered maps override the empty ones (later `--maps-json` files win).

Limitations:

- Only webpack and Turbopack module tables are recognized. Rollup, Vite, and esbuild hoist modules into one scope per chunk, so their output keeps no module boundaries to recover; `--chunks` can only treat such a chunk as a whole.
- A factory is the smallest unit. Module concatenation (webpack) and scope hoisting merge many original modules into one factory, and those cannot be separated.
- As with any source map, line terminators and the text between factories are unmapped.
- Coverage counts a factory's header as observed when its chunk ran, even if the factory itself was never called. Headers are therefore left unmapped: their bytes appear under `[unmapped]`, and a module whose factory never executed has 0 observed bytes. Bundle totals are unchanged.
- Module ids name modules only within one webpack runtime. Sources are grouped by chunk global so that two runtimes on the same page do not collide.

## label

`coldpath label --report report.json --out labels.json` reads a report generated with `--details` and asks a language model about the sources with the most unobserved bytes (`--top`, default 50). The model sees a digest of each source: its first 600 characters plus string literals and property keys sampled evenly across the whole text. The limits are 80 strings and 60 keys up to 40,000 characters and grow with size to at most 400 and 300, so a large chunk is still only sampled. **This sends code to the model provider.** Do not use it on code you may not share.

- `--mode identify` (default) handles only recovered `webpack://inferred/` sources. For a module it asks for a `summary` of what the code does, plus a guessed `name`, `shortName`, `kind` (`package`, `app`, `polyfill`, `data`, or `unknown`), `reasoning`, and `evidence`. For a whole chunk (`webpack://inferred/chunk/`) it asks for a `summary`, `shortName`, `reasoning`, and `contents`: a list of parts, each with its own `name`, `kind`, and `evidence`.
- `--mode describe` handles every source with content and asks only for a `summary`. Use it on your own source-mapped builds. Scripts without source content (unmapped, or with maps that lack `sourcesContent`) cannot be described.
- `--lang` sets the language of summaries and reasoning (default English).

Identity guesses are checked mechanically. An evidence string is kept only if it has at least 6 characters, occurs in the source, and occurs in no more than `max(3, 0.5%)` of all sources in the report, which rejects boilerplate such as `"use strict"`. A guess with no remaining evidence, or with kind `unknown`, is discarded and only its summary is kept. For a chunk, each part is checked on its own: parts without evidence are dropped, and if none remain only the summary is kept. The analyzer checks evidence again against the source content when it attaches labels. None of this makes a guess correct: several strings can be distinctive and still point to the wrong package, and the model's summaries are not verified.

### Measuring identification accuracy

`node scripts/label-accuracy.ts [label options]` (run after `pnpm test:corpus`, which builds the corpus) removes the source maps from the corpus's webpack and Next.js builds, runs `modules`, `analyze`, and `label` on them, and scores every guess against the package that the real maps say each module came from (`scripts/label-score.ts`). It calls the model provider. It reports separately:

- package or application: whether `kind` (`package` or `polyfill` versus anything else) matches whether the module's code lives under `node_modules`.
- exact package: the package a guess names (`react-dom/client` names `react-dom`; scoped names are kept whole) must equal the owning package. Substring and same-family names do not count (`@snowplow/browser-tracker` is not `@snowplow/browser-tracker-core`); a different name counts only through an explicit alias passed to the scorer.
- application features: counted, never scored, because there is no reference to check them against.

Modules whose code comes from several packages, and guesses the evidence filter dropped, are counted and left out of both scores. One vendoring rule is built in: code under `next/dist/compiled/<package>` belongs to `<package>`. `scripts/verify-label-score.ts` holds the scorer's negative and positive controls.

Measured on 2026-09-25 with `claude-haiku-4-5`, two runs each (the model's answers vary between runs), on the Next.js 16.3.6 Turbopack build (129 labeled modules):

| Identify prompt | Exact package | Package or app |
| --- | ---: | ---: |
| Before | 75.0%, 69.2% (81/108, 72/104) | 84.1%, 78.9% |
| Current: exact npm names, framework internals named after the framework | 86.8%, 87.0% (92/106, 94/108) | 93.7%, 93.8% |

The webpack build has only 5 or 6 package modules and is too small to compare. The corpus is mostly Next.js and React, and the prompt names Next.js as an example, so part of the gain may not carry over to other sites. Whole-chunk labeling (`contents`) is not measured, because the corpus has no whole-chunk sources.

Providers:

| `--provider` | Endpoint | Credentials |
| --- | --- | --- |
| `anthropic` (default, model `claude-haiku-4-5`) | Anthropic Messages API with a JSON schema output format | the Anthropic SDK's usual sources, for example `ANTHROPIC_API_KEY`; requires `@anthropic-ai/sdk` |
| `openai` | any OpenAI-compatible `POST {--base-url}/chat/completions` with a strict JSON schema `response_format` (OpenAI by default; also local servers such as Ollama or LM Studio) | `COLDPATH_LABEL_API_KEY` or `OPENAI_API_KEY` as a bearer token, if set |

`--model` is required for `openai`. Servers that do not honor strict JSON schemas may return answers that fail validation; those sources are reported and skipped. The command prints token usage.

## Report fields

`--labels FILE` attaches `label` (including `contents` for whole chunks) to `sources[]` and `bundles[].sources[]` and records `labelGenerator` (`provider`, `model`, `mode`). `--loading FILE` attaches `loading` (`load`, `initiator`, `startMs`) to `bundles[]`. Neither changes any byte count, budget, or recommendation. Entries that match nothing produce warnings; unknown fields and unknown `load` values are errors.

```json
{"schemaVersion": 1, "generator": {"provider": "anthropic", "model": "claude-haiku-4-5", "mode": "identify"},
 "sources": {"webpack://inferred/webpackChunk_N_E/94337.js": {"name": "asn1.js", "shortName": "asn1-js", "kind": "package",
   "summary": "...", "reasoning": "...", "evidence": ["DecoderBuffer overrun"]}}}
```

```json
{"schemaVersion": 1, "bundles": {"cdn.example.com/app/main.js": {"load": "html", "initiator": "parser", "startMs": 83}}}
```

The treemap groups bundles by load cause when `--loading` is given, shows labeled sources as `≈ shortName (file)`, includes label names, part names, and summaries in search, and shows the summary, guessed identity or chunk contents, reasoning, and evidence on a source's page, marked as a model's guess.
