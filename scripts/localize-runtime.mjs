#!/usr/bin/env node
/**
 * Patch the runtime server for the DSH embedding (panel UI is built from app/).
 *
 * Every patch is idempotent: running this twice leaves one copy of each.
 *
 * - allow the panel to be framed (drop frame-ancestors)
 * - physical iOS input waits for a fresh frame instead of rejecting
 * - the shared physical-iPhone mirror reopens a capture that stopped sending
 *   frames instead of starving every panel that is watching it
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

/* --------------------------------------------------------------- server.mjs */

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

/* ------------------------------------------------ ios-mirror-service.mjs ---
 * The mirror service keeps one capture per iPhone for its whole lifetime. If
 * that capture loses the CoreDevice display stream (a second consumer, a driver
 * reset, the device going to sleep) the native reader keeps returning empty
 * batches: the frame sequence freezes, every panel that joins waits for a
 * keyframe that never comes, and the only way out used to be killing the
 * service. Reopening the native capture inside the pump keeps the existing
 * sessions: they are invalidated, wait for the new keyframe and carry on.
 */
const service = join(root, 'vendor', 'runtime', 'dist', 'ios-mirror-service.mjs')
if (existsSync(service)) {
  let hub = readFileSync(service, 'utf8')
  const before = hub
  let applied = []

  // Remove any copy of an earlier version of the starvation block.
  const blockStart = '        if (batch.frames.length === 0) {'
  const terminators = ['} else if (device.starved !== 0) device.starved = 0;', '} else device.starved = 0;']
  for (;;) {
    const start = hub.indexOf(blockStart)
    if (start < 0) break
    let end = -1
    for (const terminator of terminators) {
      const found = hub.indexOf(terminator, start)
      if (found >= 0 && (end < 0 || found < end)) end = found
    }
    if (end < 0) break
    const lineEnd = hub.indexOf('\n', end) + 1
    hub = hub.slice(0, start) + hub.slice(lineEnd)
  }

  // The pump needs the udid to reopen the capture.
  const deviceInitFrom = 'device = { capture, subscribers:'
  if (hub.includes(deviceInitFrom) && hub.includes('device = { capture, udid, subscribers:') === false) {
    hub = hub.replace(deviceInitFrom, 'device = { capture, udid, subscribers:')
    applied.push('device keeps its udid')
  }

  const pumpAnchor = `      while (device.closed === false) {
        const batch = await device.capture.read();
        if (device.closed) break;
`
  const starvation = `        if (batch.frames.length === 0) {
          device.starved = (device.starved ?? 0) + 1;
          if (device.keyRequested && device.starved >= 6 && device.reopening !== true) {
            device.starved = 0;
            device.reopening = true;
            try {
              await device.capture.close();
              device.capture = await this.openNative(device.udid);
              device.generation = void 0;
              device.configuration = void 0;
              device.keyRequested = true;
              for (const subscriber of device.subscribers) this.invalidate(subscriber);
              device.reopening = false;
              continue;
            } catch (reopenError) {
              device.reopening = false;
              throw reopenError instanceof Error ? reopenError : new Error(String(reopenError));
            }
          }
        } else if (device.starved !== 0) device.starved = 0;
`
  if (hub.includes(pumpAnchor) && hub.includes('device.reopening !== true') === false) {
    hub = hub.replace(pumpAnchor, pumpAnchor + starvation)
    applied.push('starved captures reopen')
  }

  if (applied.length > 0 && hub !== before) {
    writeFileSync(service, hub)
    console.log(`ios-mirror-service.mjs: ${applied.join(', ')}`)
  }
}
