/**
 * dsh-sim host plugin.
 *
 * Owns per-conversation simulator streams and exposes:
 *  - `sim_*` agent tools (device discovery, start/stop, screenshot, input),
 *  - `/_dsh/dsh-sim/*` routes used by the native sidebar page,
 *  - a WebSocket video relay (iOS: serve-sim AVCC H.264; Android: scrcpy H.264).
 */
import { SimManager } from './host/manager.js'
import { createTools } from './tools.js'
import { parameterDescriptionZh, toolDescriptionZh } from './tool_locale.js'
import { mountRoutes } from './host/routes.js'
import { disposeDeviceRuntime } from './host/device_runtime.js'

export const name = 'dsh-sim'

export const inject = ['tools']

export function apply(ctx) {
  const logger = ctx.logger
  const manager = new SimManager({ logger })
  const tools = createTools(manager)

  const localizeSchema = (schema) => {
    if (Array.isArray(schema)) return schema.map(localizeSchema)
    if (schema === null || typeof schema !== 'object') return schema
    const out = {}
    for (const [name, value] of Object.entries(schema)) {
      out[name] = name === 'description' && typeof value === 'string'
        ? (parameterDescriptionZh[value] ?? value)
        : localizeSchema(value)
    }
    return out
  }

  const disposers = []
  for (const [key, tool] of Object.entries(tools)) {
    const localized = {
      ...tool,
      description: toolDescriptionZh[tool.name] ?? tool.description,
      parameters: localizeSchema(tool.parameters),
    }
    disposers.push(ctx.effect(() => ctx.tools.register(localized), `dsh-sim:${key}`))
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = mountRoutes(webCtx.webServer, manager, logger)
      return dispose
    }, 'dsh-sim: routes')
  })

  logger?.info?.('dsh-sim mounted (10 tools + /_dsh/dsh-sim routes)')

  return async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose() } catch { /* ignore */ }
    }
    disposeDeviceRuntime()
    await manager.dispose()
  }
}
