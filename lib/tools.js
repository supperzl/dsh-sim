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

  const simInstall = defineTool({
    name: 'sim_install',
    description: 'Install an app on the streamed device. Android takes an .apk path (adb install -r -t, '
      + 'replacing an existing install by default); iOS takes a built .app bundle path (simctl install). '
      + 'Start the device with sim_start first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to the .apk file or .app bundle' },
        reinstall: { type: 'boolean', description: 'Android only: replace an existing install (default true)' },
      },
    },
    async execute(args, exec) {
      return manager.install(sessionOf(exec), { path: args.path, reinstall: args.reinstall })
    },
  })

  const simUninstall = defineTool({
    name: 'sim_uninstall',
    description: 'Uninstall an app from the streamed device by package name (Android) or bundle id (iOS).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Android package name or iOS bundle id' },
      },
    },
    async execute(args, exec) {
      return manager.uninstall(sessionOf(exec), { id: args.id })
    },
  })

  const simLaunch = defineTool({
    name: 'sim_launch',
    description: 'Launch an installed app on the streamed device. Android takes the package name, or an '
      + 'explicit component via `activity` (e.g. com.example/.MainActivity); iOS takes the bundle id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Android package name or iOS bundle id' },
        activity: { type: 'string', description: 'Android only: explicit component, pkg/.Activity' },
      },
    },
    async execute(args, exec) {
      return manager.launch(sessionOf(exec), { id: args.id, activity: args.activity })
    },
  })

  const simOpenUrl = defineTool({
    name: 'sim_open_url',
    description: 'Open a URL or deep link on the streamed device (Android intent VIEW, iOS simctl openurl).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'http(s) URL or app deep link' },
      },
    },
    async execute(args, exec) {
      return manager.openUrl(sessionOf(exec), { url: args.url })
    },
  })

  const simPermission = defineTool({
    name: 'sim_permission',
    description: 'Grant or revoke a permission. Android: `permission` is an android.permission.* name. '
      + 'iOS: `permission` is a simctl privacy service (camera, microphone, photos, location, contacts, ...).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['op', 'id', 'permission'],
      properties: {
        op: { type: 'string', enum: ['grant', 'revoke'] },
        id: { type: 'string', description: 'Android package name or iOS bundle id' },
        permission: { type: 'string', description: 'android.permission.* (Android) or privacy service (iOS)' },
      },
    },
    async execute(args, exec) {
      return manager.permission(sessionOf(exec), { op: args.op, id: args.id, permission: args.permission })
    },
  })

  const simUi = defineTool({
    name: 'sim_ui',
    description: 'Dump the accessibility hierarchy of the streamed device as a flat node list '
      + '(text, content-desc, resource-id, class, bounds, clickable). Android only; iOS returns '
      + 'supported:false because it needs WebDriverAgent.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      return manager.ui(sessionOf(exec))
    },
  })

  const simLogcat = defineTool({
    name: 'sim_logcat',
    description: 'Read recent Android logcat lines from the streamed device (last N lines, optional tag '
      + 'filter). iOS returns supported:false; use sim_shell with `log show` instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'How many recent lines (default 200)' },
        filter: { type: 'string', description: 'Optional tag filter, passed to logcat -s' },
      },
    },
    async execute(args, exec) {
      return manager.logcat(sessionOf(exec), { lines: args.lines, filter: args.filter })
    },
  })

  const simShell = defineTool({
    name: 'sim_shell',
    description: 'Run a shell command on the streamed device via adb shell (Android only). iOS simulators '
      + 'have no shell and return supported:false. Use for diagnostics and settings without a dedicated tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Command to run inside the device' },
      },
    },
    async execute(args, exec) {
      return manager.shell(sessionOf(exec), { command: args.command })
    },
  })

  const simShutdown = defineTool({
    name: 'sim_shutdown',
    description: 'Stop the conversation\'s stream and power the device down (iOS simctl shutdown; Android '
      + 'emulator via adb emu kill). Physical Android devices are only disconnected.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      return manager.shutdown(sessionOf(exec))
    },
  })


  const snapshotOf = async (sessionId) => manager.elementSnapshot(sessionId)
  const unsupported = (snapshot) => snapshot.supported !== true
    ? { supported: false, platform: snapshot.platform, reason: snapshot.reason ?? 'element snapshots are not supported on this device' }
    : null

  const matchNodes = (nodes, args) => nodes.filter((node) => {
    const contains = args.contains !== false
    const hit = (value, wanted) => wanted === undefined
      || (contains ? String(value ?? '').includes(wanted) : String(value ?? '') === wanted)
    if (args.ref !== undefined) return node.ref === args.ref
    const checks = [hit(node.text, args.text), hit(node.id, args.id), hit(node.desc, args.desc)]
    const used = [args.text, args.id, args.desc].filter((v) => v !== undefined).length
    return used > 0 && checks.every(Boolean)
  })

  const pressNode = async (sessionId, node) => {
    await manager.control(sessionId, { kind: 'touch', action: 'begin', x: node.center.x, y: node.center.y })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await manager.control(sessionId, { kind: 'touch', action: 'end', x: node.center.x, y: node.center.y })
  }

  const describeNode = (node) => ({
    ref: node.ref, text: node.text, desc: node.desc, id: node.id, class: node.class,
    clickable: node.clickable === true, center: node.center,
  })

  const simSnapshot = defineTool({
    name: 'sim_snapshot',
    description: 'Export the current UI element tree with refs and centered normalized coordinates (Android).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        interactiveOnly: { type: 'boolean', description: 'Only clickable/editable nodes' },
        text: { type: 'string', description: 'Only nodes whose text/desc/id contains this' },
        limit: { type: 'number', description: 'Max nodes (default 200)' },
      },
    },
    async execute(args, exec) {
      const snapshot = await snapshotOf(sessionOf(exec))
      const missing = unsupported(snapshot)
      if (missing !== null) return missing
      let nodes = snapshot.nodes
      if (args.interactiveOnly === true) nodes = nodes.filter((node) => node.clickable === true)
      if (typeof args.text === 'string' && args.text !== '') nodes = matchNodes(nodes, { text: args.text })
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 500))
      return { supported: true, platform: snapshot.platform, screen: snapshot.screen, count: nodes.length, nodes: nodes.slice(0, limit).map(describeNode) }
    },
  })

  const simFind = defineTool({
    name: 'sim_find',
    description: 'Find UI elements by text/resource id/content description; returns refs to use with sim_press/sim_fill.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Text substring' },
        id: { type: 'string', description: 'Resource id substring' },
        desc: { type: 'string', description: 'Content description substring' },
        contains: { type: 'boolean', description: 'Substring match (default true)' },
        limit: { type: 'number', description: 'Max matches (default 20)' },
      },
    },
    async execute(args, exec) {
      if (args.text === undefined && args.id === undefined && args.desc === undefined) throw new Error('sim_find needs text, id or desc')
      const snapshot = await snapshotOf(sessionOf(exec))
      const missing = unsupported(snapshot)
      if (missing !== null) return missing
      const matches = matchNodes(snapshot.nodes, args)
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))
      return { count: matches.length, matches: matches.slice(0, limit).map(describeNode) }
    },
  })

  const simPress = defineTool({
    name: 'sim_press',
    description: 'Press an element by ref (from sim_snapshot/sim_find) or by text/id/desc; taps its center.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12)' },
        text: { type: 'string' }, id: { type: 'string' }, desc: { type: 'string' },
        contains: { type: 'boolean', description: 'Substring match (default true)' },
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const snapshot = await snapshotOf(sessionId)
      const missing = unsupported(snapshot)
      if (missing !== null) return missing
      const matches = matchNodes(snapshot.nodes, args)
      if (matches.length === 0) throw new Error('no element matched; call sim_snapshot again')
      if (matches.length > 1) throw new Error('matched ' + matches.length + ' elements; retry with one of: ' + matches.slice(0, 8).map((n) => n.ref + ' ' + (n.text || n.desc || n.id)).join(' | '))
      await pressNode(sessionId, matches[0])
      return { pressed: matches[0].ref, text: matches[0].text, center: matches[0].center }
    },
  })

  const simFill = defineTool({
    name: 'sim_fill',
    description: 'Focus an element and type text into it (ASCII; scrcpy injects the text).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: { type: 'string' }, text: { type: 'string' }, id: { type: 'string' }, desc: { type: 'string' },
        value: { type: 'string', description: 'Text to type' },
      },
      required: ['value'],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const snapshot = await snapshotOf(sessionId)
      const missing = unsupported(snapshot)
      if (missing !== null) return missing
      const matches = matchNodes(snapshot.nodes, args)
      if (matches.length !== 1) throw new Error('sim_fill needs exactly one matching element (got ' + matches.length + ')')
      await pressNode(sessionId, matches[0])
      await new Promise((resolve) => setTimeout(resolve, 150))
      await manager.control(sessionId, { kind: 'text', text: String(args.value) })
      return { filled: matches[0].ref, value: args.value }
    },
  })

  const simWait = defineTool({
    name: 'sim_wait',
    description: 'Wait until an element appears (or disappears) with a timeout; returns the matching ref.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string' }, id: { type: 'string' }, desc: { type: 'string' },
        contains: { type: 'boolean' },
        gone: { type: 'boolean', description: 'Wait until it disappears instead' },
        timeoutMs: { type: 'number', description: 'Timeout (default 10000)' },
        intervalMs: { type: 'number', description: 'Poll interval (default 500)' },
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const timeout = Math.max(200, Math.min(Number(args.timeoutMs) || 10_000, 120_000))
      const interval = Math.max(100, Math.min(Number(args.intervalMs) || 500, 5_000))
      const initial = await snapshotOf(sessionId)
      const missing = unsupported(initial)
      if (missing !== null) return missing
      const started = Date.now()
      for (;;) {
        let matches = []
        try {
          const snapshot = await snapshotOf(sessionId)
          matches = matchNodes(snapshot.nodes, args)
        } catch { matches = [] }
        const found = matches.length > 0
        if (args.gone === true ? !found : found) {
          return { found, waitedMs: Date.now() - started, ref: found ? matches[0].ref : undefined }
        }
        if (Date.now() - started >= timeout) {
          throw new Error(args.gone === true ? 'element is still present after ' + timeout + 'ms' : 'element not found within ' + timeout + 'ms')
        }
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    },
  })

  const simAssert = defineTool({
    name: 'sim_assert',
    description: 'Assert that an element is visible (or not), by text/id/desc; returns pass and the matches.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string' }, id: { type: 'string' }, desc: { type: 'string' },
        contains: { type: 'boolean' },
        visible: { type: 'boolean', description: 'Expected visibility (default true)' },
        limit: { type: 'number' },
      },
    },
    async execute(args, exec) {
      const snapshot = await snapshotOf(sessionOf(exec))
      const missing = unsupported(snapshot)
      if (missing !== null) return missing
      const matches = matchNodes(snapshot.nodes, args)
      const visible = args.visible !== false
      const pass = visible ? matches.length > 0 : matches.length === 0
      return { pass, visible, count: matches.length, matches: matches.slice(0, 10).map(describeNode) }
    },
  })


  const simListApps = defineTool({
    name: 'sim_list_apps',
    description: 'List installed app packages on the streamed device (Android).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { thirdParty: { type: 'boolean', description: 'Only third-party apps' } },
    },
    async execute(args, exec) {
      const result = await manager.apps(sessionOf(exec), { thirdParty: args.thirdParty === true })
      if (result.supported !== true) throw new Error(result.reason ?? 'app listing is not supported')
      return result
    },
  })

  const simAppState = defineTool({
    name: 'sim_app_state',
    description: 'Report the foreground app package/activity on the streamed device (Android).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(args, exec) {
      const result = await manager.appState(sessionOf(exec))
      if (result.supported !== true) throw new Error(result.reason ?? 'app state is not supported')
      return result
    },
  })

  const simStopApp = defineTool({
    name: 'sim_stop_app',
    description: 'Force-stop an app by package name on the streamed device (Android).',
    parameters: {
      type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'Android package name' } }, required: ['id'],
    },
    async execute(args, exec) {
      const result = await manager.stopApp(sessionOf(exec), args.id)
      if (result.supported !== true) throw new Error(result.reason ?? 'stopping an app is not supported')
      return result
    },
  })

  const simLogs = defineTool({
    name: 'sim_logs',
    description: 'Read recent device logs with level/tag filtering (Android logcat; iOS later).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        lines: { type: 'number', description: 'How many lines (default 200)' },
        filter: { type: 'string', description: 'Tag or text filter' },
        level: { type: 'string', enum: ['all', 'info', 'warn', 'error'], description: 'Minimum level' },
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const result = await manager.logcat(sessionId, { lines: args.lines, filter: args.filter })
      if (result.supported !== true) throw new Error(result.reason ?? 'logs are not supported')
      let lines = result.lines ?? []
      const level = args.level ?? 'all'
      if (level !== 'all') {
        const mark = level === 'error' ? ' E ' : level === 'warn' ? ' W ' : ' I '
        lines = lines.filter((line) => line.includes(mark) || line.includes(' E ') || line.includes(' W '))
      }
      return { supported: true, platform: 'android', count: lines.length, lines: lines.slice(-(Math.max(1, Math.min(Number(args.lines) || 200, 2000)))) }
    },
  })

  return {
    simListApps,
    simAppState,
    simStopApp,
    simLogs,
    simSnapshot,
    simFind,
    simPress,
    simFill,
    simWait,
    simAssert,
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
    simInstall,
    simUninstall,
    simLaunch,
    simOpenUrl,
    simPermission,
    simUi,
    simLogcat,
    simShell,
    simShutdown,
  }
}
