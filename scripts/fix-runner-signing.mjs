#!/usr/bin/env node
/**
 * Keep the bundled XCTest runner (agent-device's `AgentDeviceRunner`) free of a
 * developer's personal signing identity before the package is shipped.
 *
 * The runner is only needed by agent-device's `device_*` tools; dsh-sim drives a
 * physical iPhone through the mirror and CoreDevice HID instead. Shipping a
 * runner project that names someone else's team and bundle ids makes the first
 * `device_open` fail on every other machine, so the shipped copy always carries
 * upstream's values.
 *
 *   node scripts/fix-runner-signing.mjs            # revert to upstream defaults
 *   node scripts/fix-runner-signing.mjs --apply    # write this machine's values
 *
 * `--apply` reads ~/.dsh/dsh-sim/runtime.env (and the environment):
 *   AGENT_DEVICE_IOS_TEAM_ID
 *   AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID
 *   AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Upstream leaves the bundle ids to the environment agent-device sets up, and
// names its own team. A shipped package must match that, not a local identity.
const UPSTREAM = {
  team: '2S799L9W4M',
  app: '"$(AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID)"',
  test: '"$(AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID)"',
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const project = join(
  root, 'vendor', 'runtime', 'dist', 'agent-device', 'node_modules', 'agent-device',
  'dist', 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj', 'project.pbxproj',
)
if (!existsSync(project)) {
  console.log('runner project not found, skip')
  process.exit(0)
}

function readRuntimeEnv() {
  const file = join(homedir(), '.dsh', 'dsh-sim', 'runtime.env')
  const env = {}
  if (!existsSync(file)) return env
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const index = text.indexOf('=')
    if (index <= 0) continue
    let value = text.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[text.slice(0, index).trim()] = value
  }
  return env
}

const apply = process.argv.includes('--apply')
const env = { ...readRuntimeEnv(), ...process.env }
const wanted = apply
  ? {
      team: env.AGENT_DEVICE_IOS_TEAM_ID?.trim() || UPSTREAM.team,
      app: env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID?.trim() || 'com.callstack.agentdevice.runner',
      test: env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID?.trim() || 'com.callstack.agentdevice.runner.uitests.xctrunner',
    }
  : UPSTREAM

let project_text = readFileSync(project, 'utf8')
const before = project_text
let changes = 0

// Team ids are all the same value; bundle ids come in the app and test flavour.
project_text = project_text.replace(/DEVELOPMENT_TEAM = [^;]+;/g, (match) => {
  const next = `DEVELOPMENT_TEAM = ${wanted.team};`
  if (next !== match) changes += 1
  return next
})
// One XCBuildConfiguration block per target and configuration; the test target
// is the block that names a TEST_TARGET_NAME/TEST_HOST.
const lines = project_text.split('\n')
let blockStart = -1
let isTestTarget = false
const flush = (endIndex) => {
  if (blockStart < 0) return
  for (let index = blockStart; index <= endIndex; index += 1) {
    const line = lines[index]
    let next
    if (/^\s*DEVELOPMENT_TEAM = [^;]+;\s*$/.test(line)) {
      next = line.replace(/DEVELOPMENT_TEAM = [^;]+;/, `DEVELOPMENT_TEAM = ${wanted.team};`)
    } else if (/^\s*PRODUCT_BUNDLE_IDENTIFIER = .+;\s*$/.test(line)) {
      next = line.replace(/PRODUCT_BUNDLE_IDENTIFIER = .+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${isTestTarget ? wanted.test : wanted.app};`)
    }
    if (next !== undefined && next !== line) {
      lines[index] = next
      changes += 1
    }
  }
}
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  if (/^\t\t\w+ \/\* .* \*\/ = \{$/.test(line)) {
    blockStart = index
    isTestTarget = false
    continue
  }
  if (blockStart >= 0 && /TEST_TARGET_NAME|TEST_HOST/.test(line)) isTestTarget = true
  if (blockStart >= 0 && /^\t\t\};\s*$/.test(line)) {
    flush(index)
    blockStart = -1
    isTestTarget = false
  }
}
project_text = lines.join('\n')
if (project_text !== before) {
  writeFileSync(project, project_text)
  console.log(`runner signing: ${apply ? 'set to this machine' : 'reverted to upstream'} (${changes} lines)`)
} else {
  console.log(`runner signing: already ${apply ? 'local' : 'upstream'}`)
}
