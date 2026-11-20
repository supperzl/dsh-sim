#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localizeRuntime } from './localize-runtime.mjs'

const dist = mkdtempSync(join(tmpdir(), 'dsh-sim-localize-'))
try {
  writeFileSync(join(dist, 'app.html'), '<html><head><title>Mobile Dev</title></head><body><script>const key = "Choose a React Native project"</script>{value:"cupertino",city:"Cupertino",label:"Cupertino",latitude:37.323,longitude:-122.0322}],Tvt=1</body></html>')
  writeFileSync(join(dist, 'browser-panel.html'), '<html><head><title>Mobile Dev</title></head><body><script>async function open(){let I={contentDocument:null};I.title="Mobile Dev";const context={locale:navigator.language};await a.sendToolResult(Dt)}</script></body></html>')
  writeFileSync(join(dist, 'server.mjs'), '"content-security-policy": "frame-ancestors \'none\'; base-uri \'none\'"\nconst session = this.session(id3);\n    if (session.generation !== generation) throw new ExpectedOperationError("device_unavailable", "Wait for a fresh physical iOS screen before sending input.");')

  localizeRuntime(dist)
  localizeRuntime(dist)

  const app = readFileSync(join(dist, 'app.html'), 'utf8')
  const shell = readFileSync(join(dist, 'browser-panel.html'), 'utf8')
  const server = readFileSync(join(dist, 'server.mjs'), 'utf8')
  assert.doesNotMatch(app, /dsh-sim-i18n/)
  assert.match(app, /const key = "Choose a React Native project"/)
  assert.match(app, /value:"beijing",city:"北京"/)
  assert.doesNotMatch(app, /\[\[\{value:"beijing",city:"北京"/)
  assert.match(app, /<title>模拟器<\/title>/)
  assert.equal((shell.match(/dsh-sim-i18n:start/g) ?? []).length, 1)
  assert.match(shell, /locale:"zh-CN"/)
  assert.match(shell, /requestIdleCallback/)
  assert.match(shell, /setTimeout\(\(\)=>\{\/\* dsh-sim-i18n:start \*\//)
  assert.match(shell, /I\.title="模拟器"/)
  const script = /<script>([\s\S]*)<\/script>/.exec(shell)?.[1]
  assert.ok(script)
  new Function(script)
  assert.doesNotMatch(server, /frame-ancestors 'none'/)
  assert.match(server, /const deadline = Date\.now\(\) \+ 2000/)
  console.log('runtime localization patch is idempotent')
} finally {
  rmSync(dist, { recursive: true, force: true })
}
