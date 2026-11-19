/**
 * Agent tools for the simulator panel.
 *
 * The tool surface follows the installed simulator plugins (device discovery,
 * boot, screenshot, tap/swipe/type/key, rotate) but is unified: one `sim_*`
 * family works for both iOS simulators and Android emulators/devices, and the
 * platform is inferred from the device id. Tools act on the SAME per-conversation
 * stream the panel shows (`exec.agent.sessionId`), so an agent booting a device
 * makes it appear in that conversation's simulator page.
 */

/**
 * Minimal local `defineTool`: the host's `defineTool` lives in
 * `@deepseek-ai/dsh-tools`, which a directory-installed plugin cannot resolve
 * at import time. A ToolDefinition is just schema + execute + an output
 * renderer, so build it here.
 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters ?? {},
    output: {
      schema: options.output?.schema ?? { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    execute: options.execute,
  }
}

function sessionOf(exec) {
  const agent = exec?.agent
  if (agent !== undefined && agent !== null) {
    const candidates = [agent.sessionId, agent.session?.sessionId, agent.session?.id, agent.id]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return 'tool'
}

function resolvePlatform(devices, id) {
  if (devices.ios.some((device) => device.id === id)) return 'ios'
  if (devices.android.some((device) => device.id === id)) return 'android'
  if (devices.avds.includes(id)) return 'android'
  return undefined
}

export function createTools(manager) {
  const simDevices = defineTool({
    name: 'sim_devices',
    description: 'List the simulator/emulator devices this machine can stream: iOS simulators '
      + '(`ios`, with udid/name/runtime/state), connected Android devices (`android`) and locally '
      + 'defined Android AVDs (`avds`). Pass the id (iOS udid, Android serial, or AVD name) to '
      + 'sim_start to boot it and open it in the conversation\'s simulator panel.',
    parameters: {},
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute() {
      const devices = await manager.devices()
      const reasons = {}
      if (typeof devices.reasons.ios === 'string') reasons.ios = devices.reasons.ios
      if (typeof devices.reasons.android === 'string') reasons.android = devices.reasons.android
      return {
        ios: devices.ios.map((device) => ({
          id: device.id, name: device.name, state: device.state,
          ...(device.runtime === undefined ? {} : { runtime: device.runtime }),
        })),
        android: devices.android.map((device) => ({
          id: device.id, name: device.name, state: device.state, kind: device.kind,
        })),
        avds: devices.avds,
        available: { ios: devices.available.ios === true, android: devices.available.android === true },
        ...(Object.keys(reasons).length === 0 ? {} : { reasons }),
      }
    },
  })

  const simStart = defineTool({
    name: 'sim_start',
    description: 'Boot/attach a device and start its live H.264 stream in the current conversation\'s '
      + 'simulator panel. `device` is an iOS simulator udid (sim_devices.ios), an Android serial '
      + '(`emulator-5554`, a USB serial) or an AVD name. iOS streams come from serve-sim (AVCC/H.264), '
      + 'Android streams from scrcpy-server (H.264). Only this conversation gets the stream.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: { type: 'string', description: 'iOS udid, Android serial or AVD name' },
        platform: { type: 'string', enum: ['ios', 'android'], description: 'Optional; inferred from the device id' },
      },
      required: ['device'],
    },
    timeoutMs: 240_000,
    async execute(args, exec) {
      const devices = await manager.devices()
      const platform = args.platform ?? resolvePlatform(devices, args.device)
      if (platform === undefined) {
        throw new Error(`unknown device "${args.device}" — run sim_devices for the available ids`)
      }
      const sessionId = sessionOf(exec)
      const status = await manager.start(sessionId, {
        platform,
        device: args.device,
        name: args.device,
      })
      return { ...status, sessionId }
    },
  })

  const simStop = defineTool({
    name: 'sim_stop',
    description: 'Stop this conversation\'s simulator stream (the device stays booted).',
    parameters: {},
    async execute(_args, exec) {
      await manager.stop(sessionOf(exec))
      return { running: false }
    },
  })

  const simStatus = defineTool({
    name: 'sim_status',
    description: 'Report which device this conversation\'s simulator panel is streaming, if any.',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return manager.status(sessionOf(exec))
    },
  })

  const simScreenshot = defineTool({
    name: 'sim_screenshot',
    description: 'Capture the streamed device\'s screen as a PNG and return its path and pixel size.',
    parameters: {},
    timeoutMs: 60_000,
    async execute(_args, exec) {
      return manager.screenshot(sessionOf(exec))
    },
  })

  const simTap = defineTool({
    name: 'sim_tap',
    description: 'Tap the streamed screen at normalized coordinates (0..1, origin top-left).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', description: '0..1 horizontal position' },
        y: { type: 'number', description: '0..1 vertical position' },
      },
      required: ['x', 'y'],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      await manager.control(sessionId, { kind: 'touch', action: 'begin', x: args.x, y: args.y })
      await manager.control(sessionId, { kind: 'touch', action: 'end', x: args.x, y: args.y })
      return { tapped: true, x: args.x, y: args.y }
    },
  })

  const simSwipe = defineTool({
    name: 'sim_swipe',
    description: 'Swipe the streamed screen between two normalized points (0..1).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        durationMs: { type: 'number', description: 'Gesture duration (default 300)' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const duration = args.durationMs ?? 300
      await manager.control(sessionId, { kind: 'touch', action: 'begin', x: args.fromX, y: args.fromY })
      const steps = 12
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps
        await manager.control(sessionId, {
          kind: 'touch',
          action: 'move',
          x: args.fromX + (args.toX - args.fromX) * ratio,
          y: args.fromY + (args.toY - args.fromY) * ratio,
        })
        await new Promise((resolve) => setTimeout(resolve, Math.max(8, duration / steps)))
      }
      await manager.control(sessionId, { kind: 'touch', action: 'end', x: args.toX, y: args.toY })
      return { swiped: true }
    },
  })

  const simText = defineTool({
    name: 'sim_text',
    description: 'Type text into the streamed device (ASCII; the device keyboard must be open).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(args, exec) {
      await manager.control(sessionOf(exec), { kind: 'text', text: args.text })
      return { typed: true }
    },
  })

  const simKey = defineTool({
    name: 'sim_key',
    description: 'Press a hardware/navigation key: home, back, recents, power, volume_up, volume_down, enter, delete, menu.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', enum: ['home', 'back', 'recents', 'power', 'volume_up', 'volume_down', 'enter', 'delete', 'menu'] },
      },
      required: ['name'],
    },
    async execute(args, exec) {
      await manager.control(sessionOf(exec), { kind: 'key', name: args.name })
      return { pressed: args.name }
    },
  })

  const simRotate = defineTool({
    name: 'sim_rotate',
    description: 'Rotate the streamed device. iOS takes portrait / landscape_left / landscape_right; Android toggles.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orientation: { type: 'string', enum: ['portrait', 'landscape_left', 'landscape_right'] },
      },
    },
    async execute(args, exec) {
      await manager.control(sessionOf(exec), { kind: 'rotate', orientation: args.orientation })
      return { rotated: true }
    },
  })

  return {
    simDevices,
    simStart,
    simStop,
    simStatus,
    simScreenshot,
    simTap,
    simSwipe,
    simText,
    simKey,
    simRotate,
  }
}
