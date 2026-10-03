// Builds each report page into one HTML file under src/ui/, which the analyzer embeds. The files are committed, so
// Rust builds need no JavaScript toolchain; CI rebuilds them and fails when they differ.
import {fileURLToPath} from 'node:url'
import {build} from 'vite'

const configFile = fileURLToPath(new URL('vite.config.ts', import.meta.url))
for (const page of ['report', 'treemap']) {
  await build({
    configFile,
    logLevel: 'warn',
    build: {rollupOptions: {input: fileURLToPath(new URL(`${page}/index.html`, import.meta.url))}},
  })
}
