# Bundler graph adapters

Graph export is optional and uses the `coldpath` package (`coldpath graph` and the bundler plugins). The Rust analyzer consumes the exported JSON offline. Source maps alone cannot recover dependency edges or import locations. For map-less webpack and Turbopack chunks you did not build, `coldpath modules --graph` recovers a graph from the minified factories instead (see [third-party.md](third-party.md#modules)).

```sh
coldpath --dir dist --graph artifacts/graph.json --graph-root . \
  --coverage initial.json --coverage interaction.json --initial-scenario initial \
  --source-compression --details --treemap artifacts/actions.html \
  --json artifacts/actions.json --markdown artifacts/actions.md
```

`--graph-root` is the bundler's project/working directory, defaulting to CWD. It is independent of the analysis root. Export and analyze from the same source revision and build. `--why src/chart.js` prints the chosen chain and available one-based locations. The treemap links the same evidence to source tiles and review suggestions.

## esbuild

Enable `metafile: true` (or `--metafile=meta.json`) in your real build, then:

```sh
coldpath graph \
  --format esbuild --input meta.json --root /path/to/project --out artifacts/graph.json
```

The adapter takes edges and import kinds from the metafile and parses source syntax for locations. Roots come from emitted entry points, excluding inputs identified as dynamic imports. If an explicitly configured entry is also dynamically imported by another entry, that ambiguity cannot be resolved from these fields alone; set its exported `modules[].entry` to `true` from your build configuration. Legacy `--metafile` remains available without location parsing and cannot be combined with `--graph`.

## webpack

Add the plugin to your webpack configuration. After a successful build it writes `coldpath.graph.json` to the output directory. Optional `root` defaults to webpack's `context`, and `fileName` changes the output name:

```js
import ColdpathGraphPlugin from '@yceffort/coldpath/webpack'

export default {
  devtool: 'source-map',
  plugins: [new ColdpathGraphPlugin()],
}
```

To export from saved stats instead, include modules, nested modules, reasons, and child compilations. Avoid grouped or truncated module lists. With the webpack Node API, write the result of:

```js
stats.toJson({
  all: false, modules: true, nestedModules: true, reasons: true, children: true,
  ids: true, groupModulesByType: false, groupModulesByPath: false,
  groupModulesByAttributes: false, modulesSpace: Infinity, nestedModulesSpace: Infinity,
})
```

```sh
coldpath graph \
  --format webpack --input stats.json --root /path/to/project --out artifacts/graph.json
```

Module identifiers remain distinct across child compilations. Active reasons provide edges. Syntax parsing supplies import declaration positions when available; native `loc` values are the fallback. An import-specifier reason points at a use site and is never relabeled as an import declaration. Concatenated inner modules may omit reasons; their recorded first issuer supplies a dependency, and parsing the issuer can establish a matching static/dynamic import and position. That fallback is not an exhaustive list of all importers. Module source size is not treated as emitted bytes.

See webpack's [stats format](https://webpack.js.org/api/stats/) for the underlying evidence.

## Rollup and Vite

Put the exporter early in your plugin list. It uses actual resolved module IDs and records import syntax before later transformations where possible:

```js
import coldpathGraph from '@yceffort/coldpath/rollup' // or '@yceffort/coldpath/vite'

export default {
  // Rollup: also configure input/output and sourcemap: true.
  // Vite: configure build: { sourcemap: true }.
  plugins: [coldpathGraph({root: '/path/to/project'})],
}
```

The build emits `coldpath.graph.json` next to output chunks. Vite supplies its configured project root automatically. Pass that asset to `--graph`. Optional `fileName` changes its output name. The plugin uses [Rollup module information and resolution hooks](https://rollupjs.org/plugin-development/); the real-build corpus also exercises Vite 8's Rolldown implementation.

Locations tagged `plugin-input` refer to the text seen by this plugin. Earlier transforms can affect them. Literal imports/reexports and `require()` are parsed; computed dynamic expressions remain without a location when they cannot be resolved exactly. Type-only imports are excluded.

## Next.js / Turbopack

Tested with **Next.js 16.3.8**. Enable production browser source maps in Next configuration. Run the native analyzer from the same checkout as the production build:

```sh
pnpm exec next experimental-analyze --output
coldpath graph \
  --format turbopack --input .next/diagnostics/analyze \
  --root /path/to/turbopack-root --out artifacts/graph.json
pnpm exec next build
coldpath --dir .next/static --graph artifacts/graph.json \
  --graph-root /path/to/turbopack-root --treemap artifacts/next.html
```

Export the graph **before** running `next build`, which clears the analyzer output under `.next`. Keep the exported JSON outside `.next`. You can also pass a saved `modules.data` file directly to `--input`.

Use `turbopack.root`, which can be the workspace root rather than the Next project directory. The adapter reads the native `data/modules.data` JSON header and binary adjacency lists; it does not invent a webpack-shaped graph. Synchronous, asynchronous, and traced dependencies remain distinct. The synchronous list holds static imports and `require()` calls alike, so the adapter parses the importing file: an edge matched to a `require()` call becomes `require`, an unmatched edge from a file that also calls `require()` becomes `unknown` (counted in a warning), and other synchronous edges stay `static`, including those from virtual or unparsable importers. By default only client module variants are exported; `--environment server` or `all` selects other variants. Source paths under `[project]/` bind to `turbopack:///` report identities. Runtime/virtual modules with no matching original source retain unknown locations.

This file format and [Next's analyzer](https://nextjs.org/docs/pages/guides/package-bundling) are experimental. Unsupported layouts and invalid binary offsets fail. The analyzer and build are separate runs; keep settings, revision, and generated files consistent. A graph is dependency evidence, not a recording of browser download time. The corpus checks this exact version, not every past/future Turbopack version.

## Exported contract and evidence limits

```json
{
  "schemaVersion": 1,
  "bundler": "webpack",
  "modules": [
    {"id": "entry", "source": "src/dashboard.tsx", "entry": true},
    {"id": "chart", "source": "node_modules/chart.js/dist/chart.js"}
  ],
  "edges": [{
    "from": "entry", "to": "chart", "kind": "static",
    "specifier": "chart.js",
    "location": {"line": 12, "column": 1},
    "locationEvidence": "webpack-stats"
  }],
  "warnings": []
}
```

Module IDs must be unique; every edge must reference existing IDs; at least one module must be an entry. Optional `emittedBytes` is bundler evidence, not source-map attribution. Optional `sourceSha256` binds locations to a source snapshot. Edges use `static`, `dynamic`, `require`, or `unknown`. Locations are one-based and omitted when unavailable.

The analyzer prefers a static chain even when a shorter dynamic path exists, handles cycles, and then uses a shortest available chain. It does not claim the displayed path is unique. Static recommendations require every edge in that chain to be static; `require` and unknown edges do not establish a safe deferral boundary. Unmatched source identities remain unmatched rather than using ambiguous filename suffix matching.

When snapshot hashes and matching `sourcesContent` exist, the analyzer compares them. On a mismatch it hashes the source file under `--graph-root`: if that file matches the snapshot, `sourcesContent` was transformed by a loader such as Babel, so the analysis continues with a warning and those locations stay unverified; otherwise the graph is rejected as stale. Verified edge locations append `+sources-content-sha256` to their provenance. The CLI temporarily retains source content for this check even without `--details`; compact exports still omit code. Missing content/hashes remain unverified, and graph topology itself is not capture-hash verified. Original file parsing cannot establish whether a stale graph describes the current build.

See the [accuracy corpus](accuracy-corpus.md) for pinned versions, real build checks, and measured source-map limitations.
