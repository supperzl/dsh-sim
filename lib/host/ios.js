/**
 * iOS Simulator plumbing: serve-sim lifecycle, H.264 (AVCC) stream URLs and
 * the serve-sim WebSocket control protocol.
 *
 * serve-sim is the same engine Orca uses for its iOS pane. The H.264 endpoint
 * (`stream.avcc`) is what makes the panel smooth: length-prefixed envelopes
 * carrying an avcC config record (tag 1), key frames (tag 2), delta frames
 * (tag 3) and a JPEG seed (tag 4) — the browser decodes with WebCodecs, never
 * with per-frame JPEG.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPackage, resolvePackageDir } from './resolve.js'

const packages = { ws: loadPackage('ws') }

const execFileAsync = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
  })
})

/** Locate `serve-sim/dist/serve-sim.js` next to this package, then up the tree. */
export function resolveServeSim() {
  const dir = resolvePackageDir('serve-sim')
  if (dir === undefined) return undefined
  const binary = join(dir, 'dist', 'serve-sim.js')
  return existsSync(binary) ? binary : undefined
}

export async function bootSimulator(udid) {
  const list = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j'])
  if (!list.ok) throw new Error(`simctl unavailable: ${list.stderr.trim()}`)
  let booted = false
  try {
    const parsed = JSON.parse(list.stdout)
    for (const devices of Object.values(parsed.devices ?? {})) {
      for (const device of devices) {
        if (device.udid === udid) booted = device.state === 'Booted'
      }
    }
  } catch { /* fall through to boot */ }
  if (!booted) {
    const boot = await execFileAsync('xcrun', ['simctl', 'boot', udid])
    // "current state: Booted" is not a failure for us.
    if (!boot.ok && !/current state:\s*Booted/i.test(boot.stderr)) {
      throw new Error(`could not boot ${udid}: ${boot.stderr.trim()}`)
    }
  }
  return true
}

/** Start (or adopt) a detached serve-sim helper and read its handshake. */
export async function startIosStream(udid) {
  const binary = resolveServeSim()
  if (binary === undefined) throw new Error('serve-sim is not installed next to dsh-sim')
  await bootSimulator(udid)
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, '--detach', '-q', udid], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`serve-sim did not report a stream for ${udid}`))
    }, 45_000)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', () => {
      clearTimeout(timer)
      if (out.trim() === '') reject(new Error(err.trim() || `serve-sim exited for ${udid}`))
      else resolve(out)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  const line = stdout.split('\n').map((value) => value.trim()).filter((value) => value.startsWith('{')).pop()
  if (line === undefined) throw new Error('serve-sim returned no handshake')
  const handshake = JSON.parse(line)
  if (typeof handshake.streamUrl !== 'string' || typeof handshake.wsUrl !== 'string') {
    throw new Error('serve-sim handshake is missing stream endpoints')
  }
  const avccUrl = handshake.streamUrl.replace('stream.mjpeg', 'stream.avcc')
  return {
    platform: 'ios',
    device: udid,
    port: handshake.port,
    streamUrl: handshake.streamUrl,
    avccUrl,
    wsUrl: handshake.wsUrl,
    configUrl: `${handshake.url}/helper/${udid}/config`,
  }
}

export async function stopIosStream(udid) {
  const binary = resolveServeSim()
  if (binary !== undefined) {
    await execFileAsync(process.execPath, [binary, '--kill', udid], { timeout: 10_000 }).catch(() => {})
  }
}

export async function iosScreenshot(udid, path) {
  const result = await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', path])
  if (!result.ok) throw new Error(result.stderr.trim() || 'simctl screenshot failed')
  return path
}

/** One serve-sim control frame: `[tag][utf-8 JSON]`. */
export function controlFrame(tag, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(1 + json.length)
  frame[0] = tag
  json.copy(frame, 1)
  return frame
}

/**
 * A persistent control socket to serve-sim for tool-driven input. The panel
 * has its own relay; this one exists so tools can tap even when no browser
 * stream is attached.
 */
export class IosControl {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.socket = undefined
    this.queue = []
    this.connecting = undefined
  }

  async connect() {
    if (this.socket !== undefined && this.socket.readyState === 1) return this.socket
    if (this.connecting !== undefined) return this.connecting
    const WebSocket = packages.ws
    if (WebSocket === undefined) throw new Error('the ws package is missing')
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, { perMessageDeflate: false })
      const timer = setTimeout(() => {
        try { socket.terminate() } catch { /* ignore */ }
        reject(new Error('serve-sim control connection timed out'))
      }, 8_000)
      socket.on('open', () => {
        clearTimeout(timer)
        this.socket = socket
        for (const frame of this.queue.splice(0)) socket.send(frame)
        resolve(socket)
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
      })
    }).finally(() => { this.connecting = undefined })
    return this.connecting
  }

  send(tag, payload) {
    const frame = controlFrame(tag, payload)
    if (this.socket !== undefined && this.socket.readyState === 1) {
      this.socket.send(frame)
      return Promise.resolve()
    }
    this.queue.push(frame)
    return this.connect().then(() => undefined).catch(() => { this.queue.length = 0 })
  }

  async tap(x, y) {
    await this.send(3, { type: 'begin', x, y })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await this.send(3, { type: 'end', x, y })
  }

  async swipe(fromX, fromY, toX, toY, durationMs = 300) {
    const steps = 12
    await this.send(3, { type: 'begin', x: fromX, y: fromY })
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps
      await this.send(3, {
        type: 'move',
        x: fromX + (toX - fromX) * ratio,
        y: fromY + (toY - fromY) * ratio,
      })
      await new Promise((resolve) => setTimeout(resolve, Math.max(8, durationMs / steps)))
    }
    await this.send(3, { type: 'end', x: toX, y: toY })
  }

  async button(name) {
    await this.send(4, { button: name })
  }

  /** Keyboard: US HID usage codes; a-z, 0-9 and a few named keys. */
  async text(text) {
    for (const char of text) {
      const usage = KEY_USAGES[char.toLowerCase()]
      if (usage === undefined) continue
      const shifted = /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(char)
      if (shifted) await this.send(6, { type: 'down', usage: 225 })
      await this.send(6, { type: 'down', usage })
      await this.send(6, { type: 'up', usage })
      if (shifted) await this.send(6, { type: 'up', usage: 225 })
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
  }

  async rotate(orientation) {
    await this.send(7, { orientation })
  }

  dispose() {
    try { this.socket?.close() } catch { /* ignore */ }
    this.socket = undefined
  }
}

const KEY_USAGES = {
  a: 4, b: 5, c: 6, d: 7, e: 8, f: 9, g: 10, h: 11, i: 12, j: 13, k: 14, l: 15, m: 16,
  n: 17, o: 18, p: 19, q: 20, r: 21, s: 22, t: 23, u: 24, v: 25, w: 26, x: 27, y: 28, z: 29,
  '1': 30, '2': 31, '3': 32, '4': 33, '5': 34, '6': 35, '7': 36, '8': 37, '9': 38, '0': 39,
  '\n': 40, ' ': 44, '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51, "'": 52, '`': 53,
  ',': 54, '.': 55, '/': 56, '\t': 43,
}

export { KEY_USAGES }
export { readdirSync }
