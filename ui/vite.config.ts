import stylex from '@stylexjs/unplugin'
import {defineConfig} from 'vite'
import type {Plugin} from 'vite'

const PLACEHOLDERS = ['__COLDPATH_DATA__', '__COLDPATH_PAYLOADS__']

// src/report.rs embeds each built page and replaces the placeholder in its data slot, so a report is one offline
// file: scripts and styles go inline, and the page's Content-Security-Policy allows nothing else.
function singleFile(): Plugin {
  return {
    name: 'coldpath-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const [page, ...others] = Object.values(bundle).filter((output) => output.fileName.endsWith('.html'))
      if (!page || others.length || page.type !== 'asset') throw new Error('build one page at a time')
      let html = String(page.source)
      for (const output of Object.values(bundle)) {
        if (output === page) continue
        if (output.type === 'chunk') {
          if (/<\/script|<!--/i.test(output.code)) throw new Error(`${output.fileName} cannot be inlined in a script element`)
          const tag = new RegExp(`<script type="module" crossorigin src="[^"]*/${output.fileName}"></script>`)
          if (!tag.test(html)) throw new Error(`${output.fileName} is not referenced by the page`)
          html = html.replace(tag, () => `<script type="module">${output.code}</script>`)
        } else if (output.fileName.endsWith('.css')) {
          const css = String(output.source)
          if (/<\/style/i.test(css)) throw new Error(`${output.fileName} cannot be inlined in a style element`)
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*/${output.fileName}">`)
          if (!tag.test(html)) throw new Error(`${output.fileName} is not referenced by the page`)
          html = html.replace(tag, () => `<style>${css}</style>`)
        } else throw new Error(`unexpected asset ${output.fileName}`)
        delete bundle[output.fileName]
      }
      const found = PLACEHOLDERS.filter((placeholder) => html.includes(placeholder))
      if (found.length !== 1 || html.split(found[0]).length !== 2) throw new Error('the page must contain one placeholder exactly once')
      page.source = html
      page.fileName = page.fileName.replace(/\/index\.html$/, '.html')
    },
  }
}

// The development server loads scripts from itself, which the reports' policy forbids.
const withoutPolicy: Plugin = {
  name: 'coldpath-dev-policy',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/, ''),
}

export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  plugins: [stylex.vite(), singleFile(), withoutPolicy],
  // React APIs on Preact's runtime: about 16 KB instead of React's 220 KB in every report.
  resolve: {
    alias: {
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react-dom/client': 'preact/compat/client',
      'react-dom': 'preact/compat',
      react: 'preact/compat',
    },
  },
  build: {
    outDir: '../src/ui',
    emptyOutDir: false,
    modulePreload: false,
    reportCompressedSize: false,
  },
})
