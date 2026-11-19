/**
 * Package resolution for a plugin installed as a link.
 *
 * `plugin_manager install_bundle <dir>` records the package as a pnpm `link:`,
 * so the plugin's own imports resolve from its real directory, not from the
 * profile's node_modules where its dependencies were installed. Resolve the
 * few host-side packages we need (ws, serve-sim) across those locations.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function candidates(name) {
  const dirs = []
  let dir = here
  for (let index = 0; index < 6; index += 1) {
    dirs.push(join(dir, 'node_modules', name))
    dir = dirname(dir)
  }
  const profiles = join(homedir(), '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const profile of readdirSync(profiles)) {
      dirs.push(join(profiles, profile, 'node_modules', name))
    }
  }
  return dirs
}

/** Directory of an installed package, searching the plugin and every profile. */
export function resolvePackageDir(name) {
  try {
    const entry = createRequire(import.meta.url).resolve(name)
    let dir = dirname(entry)
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) {
        try {
          const pkg = createRequire(join(dir, 'package.json'))(join(dir, 'package.json'))
          if (pkg && pkg.name === name) return dir
        } catch { /* keep walking */ }
      }
      dir = dirname(dir)
    }
  } catch { /* fall through to the explicit paths */ }
  for (const candidate of candidates(name)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Filesystem path of a package's file (e.g. `serve-sim/dist/serve-sim.js`). */
export function resolvePackageFile(name, relative) {
  const dir = resolvePackageDir(name)
  if (dir === undefined) return undefined
  const file = join(dir, relative)
  return existsSync(file) ? file : undefined
}

/** Require a package from wherever it lives. */
export function loadPackage(name) {
  const dir = resolvePackageDir(name)
  if (dir === undefined) return undefined
  try {
    return createRequire(join(dir, 'package.json'))(name)
  } catch {
    return undefined
  }
}
