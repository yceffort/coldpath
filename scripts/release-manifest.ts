// Adds the published analyzer packages to package.json as optionalDependencies, pinned to this version.
// Run only in the release job: the platform packages exist on npm only after that job publishes them.
import {readFile, writeFile} from 'node:fs/promises'

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const file = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(await readFile(file, 'utf8'))
if (process.argv[2] && process.argv[2] !== `v${manifest.version}`)
  throw new Error(`tag ${process.argv[2]} does not match version ${manifest.version}`)
// Claude Code updates an installed plugin, and so its skill, only when this version changes.
const plugin = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
if (plugin.version !== manifest.version)
  throw new Error(`.claude-plugin/plugin.json version ${plugin.version} does not match version ${manifest.version}`)
manifest.optionalDependencies = Object.fromEntries(PLATFORMS.map((platform) => [`@yceffort/coldpath-${platform}`, manifest.version]))
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
console.log(`optionalDependencies: ${Object.keys(manifest.optionalDependencies).join(', ')}`)
