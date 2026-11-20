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
  IosControl, iosInstall, iosLaunch, iosOpenUrl, iosPermission, iosScreenshot, iosShutdown,
  iosUninstall, startIosStream, stopIosStream,
} from './ios.js'
import {
  AndroidStream, androidInstall, androidLaunch, androidLogcat, androidOpenUrl, androidPermission,
  androidScreenshot, androidShell, androidShutdown, androidUi, androidUninstall, bootAvd, readPngSize,
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
    return listAllDevices()
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
    const streamId = typeof request.streamId === 'string' && request.streamId !== '' ? request.streamId : 'default'
    if (typeof platform !== 'string' || typeof device !== 'string') {
      throw new Error('start requires platform and device')
    }
    await this.stop(sessionId, streamId)
    if (platform === 'ios') {
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
      if (entry.platform === 'ios') {
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
    if (entry.platform === 'ios') {
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

  /** Stop the stream and power the device down. */
  async shutdown(sessionId) {
    const entry = this.#entry(sessionId)
    if (entry === undefined) return { running: false, shutdown: false, reason: 'no simulator is running' }
    await this.stop(sessionId)
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
