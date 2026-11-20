/**
 * Bridge the sim_* tools to the embedded engine's device_* MCP tools, so the
 * panel and the agent drive the same device session.
 */
import { deviceRuntimeTool } from './device_runtime.js'

const sessions = new Map()

function sessionName(entry) {
  return 'dsh-' + String(entry.sessionId ?? 'session').replace(/[^\w-]/g, '').slice(-24)
}

export async function engineDeviceCall(entry, name, args = {}) {
  const session = sessionName(entry)
  if (!sessions.has(session)) {
    await deviceRuntimeTool('device_open', {
      session,
      platform: entry.platform === 'ios' ? 'apple' : 'android',
      ...(entry.platform === 'ios' ? { udid: entry.device } : { serial: entry.device }),
    })
    sessions.set(session, Date.now())
  }
  try {
    return await deviceRuntimeTool(name, { session, ...args })
  } catch (error) {
    sessions.delete(session)
    throw error
  }
}

export function forgetEngineDevice(session) {
  sessions.delete(session)
}
