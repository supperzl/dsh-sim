#!/usr/bin/env node
/**
 * Patch the runtime server for the DSH embedding (panel UI is built from app/).
 *
 * - allow the panel to be framed (drop frame-ancestors)
 * - physical iOS input waits for a fresh frame instead of rejecting
 * - the shared physical-iPhone mirror fails a starved capture instead of
 *   serving empty batches forever (see the watchdog below)
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

// The mirror service keeps one capture per iPhone for its whole lifetime. If
// that capture loses the CoreDevice display stream (a second consumer, a driver
// reset, the device going to sleep) the native reader keeps returning empty
// batches: the frame sequence freezes, every panel that joins then waits for a
// keyframe that never comes, and the panel reports "The iPhone has not produced
// a screen frame" until the service process is killed. Failing the capture after
// a few seconds of asking for a keyframe makes the subscriber see the real
// error, lets the session close, and lets the next open start a fresh capture.
const service = join(root, 'vendor', 'runtime', 'dist', 'ios-mirror-service.mjs')
if (existsSync(service)) {
  let hub = readFileSync(service, 'utf8')
  const pumpFrom = `      while (device.closed === false) {
        const batch = await device.capture.read();
        if (device.closed) break;`
  const pumpTo = `      while (device.closed === false) {
        const batch = await device.capture.read();
        if (device.closed) break;
        if (batch.frames.length === 0) {
          device.starved = (device.starved ?? 0) + 1;
          if (device.keyRequested && device.starved >= 6) throw new Error("The physical iPhone screen stopped sending frames. Reopen the panel to restart its mirror.");
        } else device.starved = 0;`
  if (hub.includes(pumpFrom)) {
    hub = hub.replace(pumpFrom, pumpTo)
    writeFileSync(service, hub)
    console.log('ios-mirror-service.mjs: starved captures fail instead of starving the panel')
  }
}
