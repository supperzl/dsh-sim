#!/usr/bin/env node
/**
 * Patch the runtime server for the DSH embedding (panel UI is built from app/).
 *
 * - allow the panel to be framed (drop frame-ancestors)
 * - physical iOS input waits for a fresh frame instead of rejecting
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'vendor', 'runtime', 'dist', 'server.mjs')
if (!existsSync(server)) {
  console.log('runtime server not found, skip')
  process.exit(0)
}
let text = readFileSync(server, 'utf8')
const cspFrom = `"content-security-policy": "frame-ancestors 'none'; base-uri 'none'"`
const cspTo = `"content-security-policy": "base-uri 'none'"`
if (text.includes(cspFrom)) {
  text = text.replace(cspFrom, cspTo)
  console.log('server.mjs: panel framing allowed')
}
const guardFrom = `if (session.generation !== generation) throw new ExpectedOperationError("device_unavailable", "Wait for a fresh physical iOS screen before sending input.");`
const guardTo = `if (session.generation !== generation) { const deadline = Date.now() + 2000; while (session.generation === generation && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50)); }`
if (text.includes(guardFrom)) {
  text = text.replace(guardFrom, guardTo)
  console.log('server.mjs: physical iOS input waits for a fresh frame')
}
writeFileSync(server, text)
