#!/usr/bin/env node
/**
 * Zero-dependency sanity check: syntax-check every runtime module and validate
 * the bundle manifest, so a broken import never reaches an installed profile.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') walk(full)
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      files.push(full)
    }
  }
}

walk(join(root, 'lib'))
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const required = ['name', 'version', 'main', 'exports', 'dsh']
for (const key of required) {
  if (pkg[key] === undefined) throw new Error(`package.json is missing "${key}"`)
}
for (const path of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg',
  'locale/en.json', 'locale/zh.json']) {
  const full = join(root, path)
  statSync(full)
  if (path.endsWith('.json')) JSON.parse(readFileSync(full, 'utf8'))
}
const locale = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
if (!locale.meta?.title || !locale.meta?.description) {
  throw new Error('locale/zh.json is missing meta.title or meta.description')
}
if (statSync(join(root, 'icon.svg')).size > 256 * 1024) {
  throw new Error('icon.svg exceeds the 256 KiB plugin icon limit')
}

console.log(`checked ${files.length} modules; manifest ok (${pkg.name}@${pkg.version})`)
