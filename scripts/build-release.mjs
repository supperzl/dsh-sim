#!/usr/bin/env node
/**
 * Build the installable release artifact: run the checks, then `npm pack` into
 * dist/. The tarball is what the GitHub release publishes and what a profile
 * installs (`plugin_manager install_bundle dist/dsh-sim-<version>.tgz`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')

execFileSync(process.execPath, [join(root, 'scripts', 'check.mjs')], { stdio: 'inherit' })
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
execFileSync('npm', ['pack', '--pack-destination', dist], { cwd: root, stdio: 'inherit' })

const tarball = join(dist, `${pkg.name}-${pkg.version}.tgz`)
const size = statSync(tarball).size
console.log(`release artifact: ${tarball} (${Math.round(size / 1024)} KB)`)
