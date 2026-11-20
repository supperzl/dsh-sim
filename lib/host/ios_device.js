/**
 * Physical iPhone / iPad streaming over the CoreDevice display service.
 *
 * Apple's own mirroring path (Xcode "View Device Screen") is a CoreDevice
 * media stream: the device sends HEVC over RTP, and macOS decodes it in
 * hardware. `pymobiledevice3 developer core-device display serve-web` wraps
 * that service into a small local HTTP server:
 *
 *   GET  /codec                 { codec, description (base64 hvcC), display }
 *   GET  /stream.bin            4-byte length-prefixed HEVC NALUs
 *   POST /touch                 { type: contact|release|tap, x, y } (0..65535)
 *   POST /button                { name, state }
 *   POST /key                   { usages: [HID usage, ...] }
 *   POST /rotate                { direction: left|right }
 *   GET  /accessibility         accessibility settings
 *
 * The panel never talks to the device directly: it fetches the codec JSON and
 * the NALU stream through our routes and posts control frames, and this module
 * owns the serve-web child process.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { get as httpGet, request as httpRequest } from 'node:http'

const execFileAsync = promisify(execFile)

/** The venv the plugin provisions for pymobiledevice3. */
export function pymobiledevice3Path() {
  return join(homedir(), '.dsh', 'cache', 'dsh-sim', 'venv', 'bin', 'pymobiledevice3')
}

export function hasPymobiledevice3() {
  return existsSync(pymobiledevice3Path())
}

/**
 * Physical devices are enumerated over usbmux (the UDID serve-web accepts);
 * the CoreDevice service and `devicectl` use a different identifier.
 */
export async function listPhysicalIosDevices() {
  const bin = pymobiledevice3Path()
  if (!existsSync(bin)) return []
  try {
    const { stdout } = await execFileAsync(bin, ['usbmux', 'list'], { timeout: 10_000, maxBuffer: 8 << 20 })
    const records = JSON.parse(stdout)
    if (!Array.isArray(records)) return []
    return records
      .filter((record) => record && (record.DeviceClass === 'iPhone' || record.DeviceClass === 'iPad'))
      .map((record) => ({
        id: String(record.Identifier),
        name: String(record.DeviceName || record.Identifier),
        model: String(record.ProductType || ''),
        runtime: `iOS ${record.ProductVersion || ''}`.trim(),
        state: 'Connected',
        platform: 'ios',
        physical: true,
      }))
  } catch {
    return []
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(timeoutMs, () => { request.destroy(new Error('timeout')) })
    request.on('error', reject)
  })
}

function postJson(port, path, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.setTimeout(timeoutMs, () => { request.destroy(new Error('timeout')) })
    request.on('error', reject)
    request.end(payload)
  })
}

export class IosDeviceStream {
  constructor(udid, port, child, logger) {
    this.udid = udid
    this.port = port
    this.child = child
    this.logger = logger
    this.codecInfo = null
    this.rotateDirection = 'left'
    this.stopped = false
    this.codecUrl = `http://127.0.0.1:${port}/codec`
    this.videoUrl = `http://127.0.0.1:${port}/stream.bin`
    this.logs = []
    const remember = (line) => {
      const text = String(line).trim()
      if (text === '') return
      this.logs.push(text)
      if (this.logs.length > 30) this.logs.shift()
    }
    child.stderr?.on('data', (chunk) => remember(chunk))
    child.stdout?.on('data', (chunk) => remember(chunk))
    child.on('exit', () => { this.stopped = true })
  }

  /** Wait for serve-web to publish the codec (tunnel + DDI can take ~15 s). */
  async ready(timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error(`serve-web exited: ${this.logs.slice(-3).join(' | ')}`)
      try {
        const info = await fetchJson(this.codecUrl, 3000)
        if (info && typeof info.codec === 'string') {
          this.codecInfo = info
          return info
        }
      } catch (error) { lastError = error }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`device stream did not start: ${lastError?.message ?? 'timeout'}`)
  }

  async touch(type, x, y) {
    const px = Math.max(0, Math.min(1, Number(x) || 0))
    const py = Math.max(0, Math.min(1, Number(y) || 0))
    await postJson(this.port, '/touch', {
      type,
      x: Math.round(px * 65535),
      y: Math.round(py * 65535),
    })
  }

  async button(name) {
    await postJson(this.port, '/button', { name, state: 'press' })
    await postJson(this.port, '/button', { name, state: 'release' })
  }

  async key(usages) {
    await postJson(this.port, '/key', { usages })
  }

  async rotate() {
    const direction = this.rotateDirection
    this.rotateDirection = direction === 'left' ? 'right' : 'left'
    await postJson(this.port, '/rotate', { direction })
  }

  async screenshot(path) {
    await execFileAsync(pymobiledevice3Path(), [
      'developer', 'core-device', 'screen-capture', 'screenshot', path, '--udid', this.udid,
    ], { timeout: 40_000, maxBuffer: 4 << 20 })
  }

  stop() {
    this.stopped = true
    try { this.child.kill('SIGTERM') } catch { /* ignore */ }
    const timer = setTimeout(() => { try { this.child.kill('SIGKILL') } catch { /* ignore */ } }, 3000)
    timer.unref?.()
  }
}

export async function startIosDeviceStream(udid, logger) {
  const bin = pymobiledevice3Path()
  if (!existsSync(bin)) throw new Error('pymobiledevice3 is not installed for dsh-sim')
  const port = await freePort()
  const child = spawn(bin, [
    'developer', 'core-device', 'display', 'serve-web',
    '--udid', udid,
    '--http-port', String(port),
    '--no-audio',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', (error) => logger?.warn?.(`dsh-sim: serve-web failed: ${error.message}`))
  const stream = new IosDeviceStream(udid, port, child, logger)
  await stream.ready()
  return stream
}
