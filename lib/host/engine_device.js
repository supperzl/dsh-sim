/**
 * Bridge the sim_* tools to the embedded engine's device_* MCP tools.
 *
 * The engine (and the panel) own the device exclusively per agent-device
 * session. To keep the panel usable, every action opens a short-lived session
 * and closes it right after, and stale claims left by an earlier engine
 * instance are cleaned up before opening.
 */
import { execFileSync } from 'node:child_process'
import { deviceRuntimeTool } from './device_runtime.js'

const sessions = new Map()

function sessionName(entry) {
  return 'dsh-' + String(entry.sessionId ?? 'session').replace(/[^\w-]/g, '').slice(-24)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function problemOf(result) {
  const text = JSON.stringify(result ?? {})
  return result?.isError === true || text.includes('Error (') ? text : null
}

function releaseStaleDaemons() {
  try {
    execFileSync('pkill', ['-f', 'agent-device/dist/src/internal/daemon.js'])
  } catch { /* nothing to kill */ }
}

export async function engineDeviceCall(entry, name, args = {}) {
  const session = sessionName(entry)
  const open = () => deviceRuntimeTool('device_open', {
    session,
    platform: entry.platform === 'ios' ? 'apple' : 'android',
    ...(entry.platform === 'ios' ? { udid: entry.device } : { serial: entry.device }),
  })

  if (!sessions.has(session)) {
    try { await deviceRuntimeTool('device_close', { session }) } catch { /* ignore */ }
    let opened = await open()
    if (problemOf(opened)?.includes('DEVICE_IN_USE')) {
      releaseStaleDaemons()
      await sleep(800)
      opened = await open()
    }
    const problem = problemOf(opened)
    if (problem !== null) throw new Error('engine device_open failed: ' + problem.slice(0, 400))
    sessions.set(session, Date.now())
  }

  try {
    const result = await deviceRuntimeTool(name, { session, ...args })
    try { (await import('node:fs')).writeFileSync('/tmp/dsh-sim-engine-last.json', JSON.stringify(result ?? {})) } catch { /* ignore */ }
    const problem = problemOf(result)
    if (problem !== null) throw new Error('engine ' + name + ' failed: ' + problem.slice(0, 400))
    return result
  } finally {
    try { await deviceRuntimeTool('device_close', { session }) } catch { /* ignore */ }
    sessions.delete(session)
  }
}

export function forgetEngineDevice(session) {
  sessions.delete(session)
}
