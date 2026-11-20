#!/usr/bin/env node
/**
 * Build the simulator panel from the vendored source (engine/).
 *
 * Usage: npm run build:panel
 *
 * Produces engine/dist/app.html and engine/dist/browser-panel.html from
 * packages/mcp-app (React/TSX, Chinese strings included) and copies them into
 * the runtime the plugin ships. Requires `npm install` in engine/ once.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'engine')
const out = join(src, 'dist')
const target = join(root, 'vendor', 'runtime', 'dist')

if (!existsSync(join(src, 'node_modules'))) {
  console.error('engine/node_modules is missing: run `npm install` in engine/ first')
  process.exit(1)
}
execFileSync(process.execPath, ['tooling/build-panel-only.mjs'], { cwd: src, stdio: 'inherit' })
execFileSync(process.execPath, [join(root, 'scripts', 'localize-runtime.mjs')], { stdio: 'inherit' })
mkdirSync(target, { recursive: true })
for (const file of ['app.html', 'browser-panel.html']) {
  cpSync(join(out, file), join(target, file))
  console.log(`installed ${file}`)
}
