/**
 * Per-conversation simulator sessions.
 *
 * Each conversation (sessionId) owns at most one stream. Nothing is shared
 * between conversations: starting a device in one conversation never changes
 * what another conversation shows, and stopping one leaves the others alone.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAllDevices, listAndroidDevices } from './devices.js'
import {
  iosDeviceButton, iosDeviceHidDrag, iosDeviceHidTap, iosDeviceScreenshot, listPhysicalIosDevices,
} from './ios_device.js'
import { panelServedRecently } from './device_runtime.js'
import { PhysicalMirror, invalidatePhysicalMirror, reapStrayDisplayConsumers } from './ios_mirror.js'
import {
  IosControl, iosInstall, iosLaunch, iosOpenUrl, iosPermission, iosScreenshot, iosShutdown,
  iosUninstall, startIosStream, stopIosStream,
} from './ios.js'
import {
  AndroidStream, androidInstall, androidLaunch, androidLogcat, androidOpenUrl, androidPermission,
  androidAppState, androidListApps, androidScreenshot, androidScreenSize, androidShell, androidShutdown, androidStopApp, androidUi, androidUninstall, bootAvd, readPngSize,
} from './android.js'

const IDLE_MS = 30 * 60 * 1000

/** A conversation can own several simulator tabs; each tab has its own stream. */
function keyOf(sessionId, streamId) {
  return `${sessionId}::${streamId === undefined || streamId === '' ? 'default' : streamId}`
}

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    import('node:http').then(({ get }) => {
      get(url, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          clearTimeout(timer)
          try { resolve(JSON.parse(body)) } catch { resolve(undefined) }
        })
      }).on('error', () => { clearTimeout(timer); resolve(undefined) })
    }).catch(() => { clearTimeout(timer); resolve(undefined) })
  })
}

export class SimManager {
  constructor(options = {}) {
    this.sessions = new Map()
    this.clientInfo = new Map()
    this.logger = options.logger
    this.timer = setInterval(() => this.reap(), 60_000)
    this.timer.unref?.()
  }

  async devices() {
    const devices = await listAllDevices()
    const physical = await listPhysicalIosDevices().catch(() => [])
    return { ...devices, physical }
  }

  /** Entry for a specific tab stream, or the most recently used one. */
  #entry(sessionId, streamId) {
    if (typeof streamId === 'string' && streamId !== '') {
      return this.sessions.get(keyOf(sessionId, streamId))
    }
    let latest
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${sessionId}::`)) continue
      if (latest === undefined || (entry.lastAccess ?? 0) > (latest.lastAccess ?? 0)) latest = entry
    }
    return latest
  }

  get(sessionId, streamId) {
    return this.#entry(sessionId, streamId)
  }

  status(sessionId, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) return { running: false }
    entry.lastAccess = Date.now()
    return {
      running: true,
      streamId: entry.streamId,
      physical: entry.physical === true,
      platform: entry.platform,
      device: entry.device,
      name: entry.name,
      ...(entry.width === undefined ? {} : { width: entry.width }),
      ...(entry.height === undefined ? {} : { height: entry.height }),
      startedAt: entry.startedAt,
      ...(entry.key !== undefined && this.clientInfo.has(entry.key) ? { client: this.clientInfo.get(entry.key) } : {}),
    }
  }

  setClientInfo(sessionId, info, streamId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (info === null || typeof info !== 'object') return
    const record = {
      frames: Number(info.frames) || 0,
      errors: Number(info.errors) || 0,
      at: Date.now(),
    }
    if (typeof info.error === 'string' && info.error !== '') record.error = info.error.slice(0, 300)
    for (const key of ['configs', 'chunks', 'bytes', 'failed', 'width', 'height']) {
      if (info[key] !== undefined && info[key] !== null) record[key] = info[key]
    }
    this.clientInfo.set(keyOf(sessionId, streamId), record)
  }

  async start(sessionId, request) {
    const { platform, device } = request
    // Agent tools do not name a slot: route them to the workspace pane for
    // their platform so sim_start shows up beside the chat.
    const streamId = typeof request.streamId === 'string' && request.streamId !== ''
      ? request.streamId
      : (platform === 'android' ? 'android' : 'ios')
    if (typeof platform !== 'string' || typeof device !== 'string') {
      throw new Error('start requires platform and device')
    }
    await this.stop(sessionId, streamId)
    if (platform === 'ios') {
      const physical = (await listPhysicalIosDevices().catch(() => [])).find((item) => item.id === device)
      if (physical !== undefined) {
        // The engine's panel owns the display stream; a second CoreDevice
        // consumer would starve it, so nothing here opens one.
        reapStrayDisplayConsumers(this.logger)
        const entry = {
          sessionId,
          platform,
          device,
          name: request.name ?? physical.name,
          physical: true,
          width: request.width ?? 1206,
          height: request.height ?? 2622,
          startedAt: Date.now(),
          lastAccess: Date.now(),
          mirror: new PhysicalMirror(device, {
            points: { width: (request.width ?? 1206) / 3, height: (request.height ?? 2622) / 3 },
            logger: this.logger,
          }),
        }
        this.sessions.set(keyOf(sessionId, streamId), { ...entry, key: keyOf(sessionId, streamId), streamId })
        return this.status(sessionId, streamId)
      }
      const stream = await startIosStream(device)
      let config = await fetchJson(stream.configUrl)
      for (let attempt = 0; attempt < 10 && (config === undefined || !config.width); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        config = await fetchJson(stream.configUrl)
      }
      const entry = {
        sessionId,
        platform,
        device,
        name: request.name ?? device,
        stream,
        control: new IosControl(stream.wsUrl),
        width: config?.width,
        height: config?.height,
        startedAt: Date.now(),
        lastAccess: Date.now(),
      }
      this.sessions.set(keyOf(sessionId, streamId), { ...entry, key: keyOf(sessionId, streamId), streamId })
      return this.status(sessionId, streamId)
    }
    if (platform === 'android') {
      const serial = await this.#resolveAndroid(device)
      const stream = await new AndroidStream(serial).start()
      const entry = {
        sessionId,
        platform,
        device: serial,
        name: request.name ?? serial,
        stream,
        width: undefined,
        height: undefined,
        startedAt: Date.now(),
        lastAccess: Date.now(),
      }
      this.sessions.set(keyOf(sessionId, streamId), { ...entry, key: keyOf(sessionId, streamId), streamId })
      return this.status(sessionId, streamId)
    }
    throw new Error(`unsupported platform: ${platform}`)
  }

  async #resolveAndroid(device) {
    const { devices } = await listAndroidDevices()
    if (devices.some((candidate) => candidate.id === device)) return device
    return bootAvd(device)
  }

  async stop(sessionId, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) return { running: false }
    this.sessions.delete(entry.key ?? keyOf(sessionId, entry.streamId))
    try {
      if (entry.physical === true) {
        await entry.mirror?.close()
        entry.stream?.stop()
      } else if (entry.platform === 'ios') {
        entry.control?.dispose()
        await stopIosStream(entry.device)
      } else {
        await entry.stream?.stop()
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-sim: stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { running: false }
  }

  async screenshot(sessionId, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) throw new Error('no simulator is running in this conversation')
    const path = join(tmpdir(), `dsh-sim-${sessionId.replace(/[^\w-]/g, '_')}-${Date.now()}.png`)
    if (entry.physical === true) {
      await iosDeviceScreenshot(entry.device, path)
    } else if (entry.platform === 'ios') {
      await iosScreenshot(entry.device, path)
    } else {
      await androidScreenshot(entry.device, path)
    }
    return { path, ...(existsSync(path) ? readPngSize(path) : {}) }
  }

  #require(sessionId, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) throw new Error('no simulator is running in this conversation')
    entry.lastAccess = Date.now()
    return entry
  }

  /** Install an .apk (Android) or a built .app (iOS) on the streamed device. */
  async install(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') {
      return { platform: 'ios', ...(await iosInstall(entry.device, request.path)) }
    }
    return { platform: 'android', ...(await androidInstall(entry.device, request.path, request.reinstall !== false)) }
  }

  async uninstall(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') return { platform: 'ios', ...(await iosUninstall(entry.device, request.id)) }
    return { platform: 'android', ...(await androidUninstall(entry.device, request.id)) }
  }

  /** Launch an app by package (Android) or bundle id (iOS). */
  async launch(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') return { platform: 'ios', ...(await iosLaunch(entry.device, request.id)) }
    return { platform: 'android', ...(await androidLaunch(entry.device, request.id, request.activity)) }
  }

  async openUrl(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') return { platform: 'ios', ...(await iosOpenUrl(entry.device, request.url)) }
    return { platform: 'android', ...(await androidOpenUrl(entry.device, request.url)) }
  }

  /** grant/revoke a permission (Android permission name, or iOS privacy service). */
  async permission(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') {
      return { platform: 'ios', ...(await iosPermission(entry.device, request.op, request.permission, request.id)) }
    }
    return { platform: 'android', ...(await androidPermission(entry.device, request.op, request.id, request.permission)) }
  }

  async apps(sessionId, options = {}) {
    const entry = this.#require(sessionId)
    if (entry.platform !== 'android') return { supported: false, platform: entry.platform, reason: 'app listing is Android-only for now' }
    return { supported: true, platform: 'android', ...(await androidListApps(entry.device, options)) }
  }

  async appState(sessionId) {
    const entry = this.#require(sessionId)
    if (entry.platform !== 'android') return { supported: false, platform: entry.platform, reason: 'foreground app state is Android-only for now' }
    return { supported: true, platform: 'android', ...(await androidAppState(entry.device)) }
  }

  async stopApp(sessionId, id) {
    const entry = this.#require(sessionId)
    if (entry.platform !== 'android') return { supported: false, platform: entry.platform, reason: 'stopping an app is Android-only for now' }
    return { supported: true, platform: 'android', ...(await androidStopApp(entry.device, id)) }
  }

  /** Flattened element tree with refs and normalized centers (Android today). */
  async elementSnapshot(sessionId) {
    const entry = this.#require(sessionId)
    if (entry.platform !== 'android') {
      return { supported: false, platform: entry.platform, reason: 'element snapshots are Android-only for now; use sim_screenshot + sim_tap on iOS' }
    }
    const [ui, screen] = await Promise.all([androidUi(entry.device), androidScreenSize(entry.device)])
    const nodes = []
    for (const node of ui.nodes ?? []) {
      const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(node.bounds ?? '')
      if (match === null) continue
      const bounds = { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) }
      if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue
      nodes.push({
        ref: 'e' + (nodes.length + 1),
        class: node.class,
        text: node.text,
        desc: node.desc,
        id: node.id,
        clickable: node.clickable === true,
        bounds,
        center: { x: (bounds.x1 + bounds.x2) / 2 / screen.width, y: (bounds.y1 + bounds.y2) / 2 / screen.height },
      })
    }
    return { supported: true, platform: 'android', screen, nodes, count: nodes.length }
  }

  /** Accessibility hierarchy: full support on Android, unavailable on iOS. */
  async ui(sessionId) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') {
      return { supported: false, reason: 'iOS accessibility trees need WebDriverAgent; use sim_screenshot + sim_tap instead' }
    }
    return { supported: true, ...(await androidUi(entry.device)) }
  }

  async logcat(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') {
      return { supported: false, reason: 'logcat is Android-only; use sim_shell with `log show` on iOS' }
    }
    return { supported: true, ...(await androidLogcat(entry.device, request.lines, request.filter)) }
  }

  /** Run a shell command on the device (Android only; iOS has no shell). */
  async shell(sessionId, request) {
    const entry = this.#require(sessionId)
    if (entry.platform === 'ios') {
      return {
        platform: 'ios',
        supported: false,
        reason: 'iOS simulators do not ship a shell; use sim_launch, sim_open_url, sim_screenshot and sim_tap',
      }
    }
    return { platform: 'android', supported: true, ...(await androidShell(entry.device, request.command)) }
  }

  /** Recent logs for the bottom dock (Android logcat; iOS unsupported). */
  async logs(sessionId, streamId, request = {}) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) return { supported: false, lines: [], reason: 'no simulator is running' }
    if (entry.platform !== 'android') {
      return { supported: false, platform: entry.platform, lines: [], reason: 'iOS logs need WebDriverAgent or a syslog bridge' }
    }
    const lines = Math.max(1, Math.min(2000, Number(request.lines) || 300))
    const filter = typeof request.filter === 'string' && request.filter !== '' ? request.filter : undefined
    const result = await androidLogcat(entry.device, lines, filter)
    return { supported: true, platform: 'android', ...result }
  }

  /** Stop the stream and power the device down. */
  async shutdown(sessionId, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) return { running: false, shutdown: false, reason: 'no simulator is running' }
    await this.stop(sessionId, streamId)
    if (entry.physical === true) {
      return { running: false, shutdown: false, platform: 'ios', physical: true }
    }
    if (entry.platform === 'ios') {
      await iosShutdown(entry.device)
      return { running: false, shutdown: true, platform: 'ios' }
    }
    return { running: false, ...(await androidShutdown(entry.device)) }
  }

  /** Apply one control frame from the panel. Coordinates are normalized. */
  async control(sessionId, event, streamId) {
    const entry = this.#entry(sessionId, streamId)
    if (entry === undefined) throw new Error('no simulator is running in this conversation')
    entry.lastAccess = Date.now()
    if (entry.physical === true) {
      // Mirror input goes straight to the device's HID service, so the panel
      // keeps showing whatever the user is looking at. The XCTest runner used
      // to be launched for every tap, which put the runner app in front of the
      // phone and froze the mirror on it; it is kept only for the hardware
      // buttons a touch surface cannot reach.
      const mirror = entry.mirror ??= new PhysicalMirror(entry.device, {
        points: { width: (entry.width ?? 1206) / 3, height: (entry.height ?? 2622) / 3 },
        logger: this.logger,
      })
      // While the panel is open it holds the mirror's capture, and input through
      // that same session is both fastest and invisible to the video. Without a
      // panel nothing is watching the stream, so the HID service is used
      // instead: it hands the display back to the device and answers at once.
      const live = panelServedRecently()
      switch (event.kind) {
        case 'touch': {
          const x = Number(event.x ?? 0.5)
          const y = Number(event.y ?? 0.5)
          if (event.action === 'begin') { entry.gesture = [[x, y]]; return }
          if (event.action === 'move') { entry.gesture?.push([x, y]); return }
          if (event.action !== 'end') return
          const path = entry.gesture ?? []
          entry.gesture = undefined
          path.push([x, y])
          const from = path[0]
          const travel = Math.max(Math.abs(x - from[0]), Math.abs(y - from[1]))
          if (live === false) {
            // The HID service takes the display stream for itself, so the
            // mirror's health is unknown afterwards; the next panel open probes
            // (and repairs) it instead of trusting a stale answer.
            try {
              if (travel < 0.02) await iosDeviceHidTap(entry.device, x, y)
              else await iosDeviceHidDrag(entry.device, from[0], from[1], x, y)
            } finally { invalidatePhysicalMirror() }
            return
          }
          try {
            if (travel < 0.02) return await mirror.tap(x, y)
            return await mirror.swipe(path)
          } catch (error) {
            // Only a mirror that is actually broken is worth re-checking: a
            // screen that merely kept changing under the gesture recovers on
            // its own, and re-probing would open sessions for nothing.
            const text = error instanceof Error ? error.message : String(error)
            if (/closed|timed out|did not send a screen frame|restart/i.test(text)) invalidatePhysicalMirror()
            throw error
          }
        }
        case 'scroll': {
          const dy = Math.max(-1, Math.min(1, Number(event.dy) || 0))
          const x = Math.max(0.03, Math.min(0.97, Number(event.x) || 0.5))
          const y = Math.max(0.03, Math.min(0.97, Number(event.y) || 0.5))
          const toY = Math.max(0.02, Math.min(0.98, y - dy * 0.18))
          if (live === false) {
            try { await iosDeviceHidDrag(entry.device, x, y, x, toY) } finally { invalidatePhysicalMirror() }
            return
          }
          await mirror.scroll(dy, x, y).catch((error) => {
            const text = error instanceof Error ? error.message : String(error)
            if (/closed|timed out|did not send a screen frame|restart/i.test(text)) invalidatePhysicalMirror()
            throw error
          })
          return
        }
        case 'key': {
          // Hardware buttons go through the CoreDevice HID service, which is a
          // separate service from the mirror: the phone responds in about a
          // second and the panel's video is untouched.
          const names = { home: 'home', lock: 'lock', volume_up: 'volume-up', volume_down: 'volume-down' }
          const name = names[event.name]
          if (name !== undefined) { await iosDeviceButton(entry.device, name); return }
          return
        }
        case 'text':
          throw new Error('typing on a physical iPhone is not supported; tap the on-screen keys with sim_tap')
        case 'rotate':
          throw new Error('rotating a physical iPhone is not supported')
        default:
          return
      }
    }
    if (entry.platform === 'ios') {
      const control = entry.control
      switch (event.kind) {
        case 'touch':
          await control.send(3, { type: event.action, x: event.x, y: event.y })
          return
        case 'scroll': {
          // serve-sim has no wheel event; emulate it with a short vertical drag
          // so a trackpad/wheel scrolls the simulated screen too.
          const dy = Math.max(-1, Math.min(1, Number(event.dy) || 0))
          if (dy === 0) return
          const x = Math.max(0.05, Math.min(0.95, Number(event.x) || 0.5))
          const y = Math.max(0.05, Math.min(0.95, Number(event.y) || 0.5))
          const toY = Math.max(0.02, Math.min(0.98, y - dy * 0.22))
          return control.swipe(x, y, x, toY, 140)
        }
        case 'key': {
          const names = { home: 'home', lock: 'lock', volumeUp: 'volumeUp', volumeDown: 'volumeDown' }
          const name = names[event.name]
          if (name !== undefined) return control.button(name)
          return
        }
        case 'text':
          return control.text(String(event.text ?? ''))
        case 'rotate':
          return control.rotate(event.orientation ?? 'landscape_left')
        default:
          return
      }
    }
    const stream = entry.stream
    const width = event.width ?? stream.width ?? entry.width ?? 1080
    const height = event.height ?? stream.height ?? entry.height ?? 2400
    switch (event.kind) {
      case 'touch': {
        const action = event.action === 'begin' ? 0 : event.action === 'end' ? 1 : 2
        stream.touch(action, event.x * width, event.y * height, width, height)
        return
      }
      case 'key': {
        const keycodes = {
          back: 4, home: 3, recents: 187, power: 26, volume_up: 24, volume_down: 25,
          menu: 82, enter: 66, delete: 67,
        }
        const code = keycodes[event.name]
        if (code !== undefined) {
          stream.keycode(0, code)
          stream.keycode(1, code)
        }
        return
      }
      case 'text':
        stream.text(String(event.text ?? ''))
        return
      case 'scroll': {
        // Emulate a finger drag at the pointer position. scrcpy's inject-scroll
        // is dispatched to the focused scroll container on some devices, so a
        // wheel over an inner list scrolled the whole page instead. A touch
        // drag is hit-tested against the view under the pointer.
        const dy = Math.max(-1, Math.min(1, Number(event.dy) || 0))
        if (dy === 0) return
        const px = Math.round((event.x ?? 0.5) * width)
        const py = Math.round((event.y ?? 0.5) * height)
        const distance = Math.max(60, Math.round(Math.abs(dy) * height * 0.18))
        const step = Math.round(distance / 8)
        const sign = dy > 0 ? -1 : 1
        stream.touch(0, px, py, width, height)
        for (let i = 1; i <= 8; i += 1) {
          stream.touch(2, px, py + sign * step * i, width, height)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        stream.touch(1, px, py + sign * distance, width, height)
        return
      }
      case 'rotate':
        stream.rotate()
        return
      default:
        return
    }
  }

  async dispose() {
    clearInterval(this.timer)
    for (const entry of [...this.sessions.values()]) {
      await this.stop(entry.sessionId, entry.streamId)
    }
  }

  reap() {
    const now = Date.now()
    for (const entry of [...this.sessions.values()]) {
      if (now - entry.lastAccess > IDLE_MS) {
        this.stop(entry.sessionId, entry.streamId).catch(() => {})
      }
    }
  }
}
