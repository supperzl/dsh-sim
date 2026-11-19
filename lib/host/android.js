/**
 * Android plumbing: scrcpy-server v4.0 over adb.
 *
 * scrcpy is the only Android path that reaches Orca-level smoothness: the
 * device encodes H.264 at 60 fps on the GPU, the host forwards the raw video
 * packets and the browser decodes them with WebCodecs. Control messages go
 * over a second socket (touch/key/text/scroll), so input is a local write rather
 * than a fresh `adb shell input` process.
 *
 * Server protocol (scrcpy 4.0):
 *   video socket: u32 codec id ("h264"), then session packets (12 bytes, MSB set)
 *   with width/height, then media packets (12-byte header: flags+PTS, u32 size).
 *   control socket: binary messages; touch is type 2 (32 bytes).
 */
import { execFile, spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { androidSdk } from './devices.js'

const SCRCPY_VERSION = '4.0'
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`
const CACHE_DIR = join(homedir(), '.dsh', 'cache', 'dsh-sim')
const SERVER_PATH = '/data/local/tmp/dsh-sim-scrcpy.jar'

const execFileAsync = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
  })
})

function adbPath() {
  const sdk = androidSdk()
  if (sdk === undefined) throw new Error('Android SDK not found (set ANDROID_HOME)')
  return sdk.adb
}

export async function adb(serial, args, opts = {}) {
  const result = await execFileAsync(adbPath(), ['-s', serial, ...args], opts)
  if (!result.ok) throw new Error(result.stderr.trim() || `adb ${args.join(' ')} failed`)
  return result
}

export async function adbCapture(serial, args) {
  const result = await execFileAsync(adbPath(), ['-s', serial, ...args], { maxBuffer: 32 * 1024 * 1024 })
  if (!result.ok) throw new Error(result.stderr.trim() || `adb ${args.join(' ')} failed`)
  return result
}

export async function bootAvd(avdName) {
  const sdk = androidSdk()
  if (sdk === undefined) throw new Error('Android SDK not found (set ANDROID_HOME)')
  const running = await execFileAsync(sdk.adb, ['devices'])
  const serials = running.stdout.split('\n').filter((line) => /^emulator-\d+\tdevice/.test(line))
  if (serials.length > 0) return serials[0].split('\t')[0]
  const child = spawn(sdk.emulator, ['-avd', avdName, '-no-boot-anim', '-no-audio', '-gpu', 'auto'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const deadline = Date.now() + 180_000
  let serial
  while (Date.now() < deadline) {
    const list = await execFileAsync(sdk.adb, ['devices'])
    for (const line of list.stdout.split('\n')) {
      const match = /^(emulator-\d+)\tdevice/.exec(line)
      if (match !== null) serial = match[1]
    }
    if (serial !== undefined) {
      const boot = await execFileAsync(sdk.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])
      if (boot.stdout.trim() === '1') return serial
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`AVD ${avdName} did not finish booting`)
}

async function ensureServerJar(serial) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const cached = join(CACHE_DIR, `scrcpy-server-v${SCRCPY_VERSION}`)
  if (!existsSync(cached) || statSync(cached).size < 100_000) {
    const response = await fetch(SCRCPY_URL, { redirect: 'follow' })
    if (!response.ok) throw new Error(`could not download scrcpy-server: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 100_000) throw new Error('downloaded scrcpy-server is truncated')
    writeFileSync(cached, bytes, { mode: 0o644 })
  }
  const remoteSize = await execFileAsync(adbPath(), ['-s', serial, 'shell', 'stat', '-c', '%s', SERVER_PATH])
  const localSize = statSync(cached).size
  if (!remoteSize.ok || Number(remoteSize.stdout.trim()) !== localSize) {
    await adb(serial, ['push', cached, SERVER_PATH])
  }
  return cached
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/** One Android scrcpy session: video socket bytes out, control messages in. */
export class AndroidStream {
  constructor(serial) {
    this.serial = serial
    this.port = undefined
    this.videoSocket = undefined
    this.controlSocket = undefined
    this.serverProcess = undefined
    this.width = undefined
    this.height = undefined
    this.pending = []
    this.videoHandler = undefined
    this.ready = false
  }

  async start() {
    await ensureServerJar(this.serial)
    this.port = await freePort()
    await adb(this.serial, ['forward', `tcp:${this.port}`, 'localabstract:scrcpy'])
    this.serverProcess = spawn(adbPath(), [
      '-s', this.serial, 'shell',
      `CLASSPATH=${SERVER_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION}`,
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'cleanup=false',
      'send_device_meta=false',
      'send_dummy_byte=false',
      'max_size=1920',
      'video_bit_rate=8000000',
      'max_fps=60',
      'log_level=error',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.serverProcess.stdout.on('data', () => {})
    this.serverProcess.stderr.on('data', () => {})
    this.videoSocket = await this.connectVideo()
    this.controlSocket = await this.connect(10_000)
    this.controlSocket.setNoDelay?.(true)
    this.ready = true
    return this
  }

  /**
   * The forwarded port accepts connections before the on-device server has
   * created its abstract socket, and a connection made too early dies without
   * a byte. Accept a socket only once it actually delivers the codec id, and
   * replay those first bytes to the first viewer.
   */
  /**
   * The forwarded port accepts connections before the on-device server has
   * created its abstract socket; such a connection closes immediately. Probe
   * until a connection STAYS open — that one is the video socket. The server
   * only starts streaming after the control socket connects too, so the caller
   * connects control right after this returns.
   */
  async connectVideo() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const socket = await this.connect(2_000).catch(() => undefined)
      if (socket !== undefined) {
        const alive = await new Promise((resolve) => {
          let settled = false
          const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
          const timer = setTimeout(() => finish(true), 500)
          socket.once('close', () => finish(false))
          socket.once('error', () => finish(false))
        })
        if (alive) {
          socket.on('data', (chunk) => {
            if (this.videoHandler !== undefined) this.videoHandler(chunk)
            else {
              this.pending.push(chunk)
              if (this.pending.length > 64) this.pending.shift()
            }
          })
          return socket
        }
        socket.destroy()
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('scrcpy server did not start within the expected time')
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('scrcpy socket connection timed out'))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.setNoDelay?.(true)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Forward raw video bytes (codec id + session + media packets) to a sink. */
  attachVideo(onData) {
    this.videoHandler = onData
    const pending = this.pending ?? []
    this.pending = []
    for (const chunk of pending) onData(chunk)
    return () => {
      if (this.videoHandler === onData) this.videoHandler = undefined
    }
  }

  write(buffer) {
    if (this.controlSocket !== undefined && !this.controlSocket.destroyed) {
      this.controlSocket.write(buffer)
    }
  }

  touch(action, x, y, width, height, pointerId = 1) {
    const buffer = Buffer.allocUnsafe(32)
    buffer.writeUInt8(2, 0)
    buffer.writeUInt8(action, 1)
    buffer.writeBigUInt64BE(BigInt(pointerId), 2)
    buffer.writeInt32BE(Math.round(x), 10)
    buffer.writeInt32BE(Math.round(y), 14)
    buffer.writeUInt16BE(Math.round(width), 18)
    buffer.writeUInt16BE(Math.round(height), 20)
    buffer.writeUInt16BE(action === 1 ? 0 : 0xffff, 22)
    buffer.writeUInt32BE(1, 24)
    buffer.writeUInt32BE(action === 1 ? 0 : 1, 28)
    this.write(buffer)
  }

  keycode(action, keycode, metastate = 0) {
    const buffer = Buffer.allocUnsafe(14)
    buffer.writeUInt8(0, 0)
    buffer.writeUInt8(action, 1)
    buffer.writeUInt32BE(keycode, 2)
    buffer.writeUInt32BE(0, 6)
    buffer.writeUInt32BE(metastate, 10)
    this.write(buffer)
  }

  text(value) {
    const bytes = Buffer.from(value, 'utf8')
    const buffer = Buffer.allocUnsafe(5 + bytes.length)
    buffer.writeUInt8(1, 0)
    buffer.writeUInt32BE(bytes.length, 1)
    bytes.copy(buffer, 5)
    this.write(buffer)
  }

  scroll(x, y, width, height, vscroll) {
    const buffer = Buffer.allocUnsafe(21)
    buffer.writeUInt8(3, 0)
    buffer.writeInt32BE(Math.round(x), 1)
    buffer.writeInt32BE(Math.round(y), 5)
    buffer.writeUInt16BE(Math.round(width), 9)
    buffer.writeUInt16BE(Math.round(height), 11)
    buffer.writeInt16BE(0, 13)
    buffer.writeInt16BE(Math.max(-16, Math.min(16, Math.round(vscroll * 16))), 15)
    buffer.writeUInt32BE(0, 17)
    this.write(buffer)
  }

  rotate() {
    this.write(Buffer.from([11]))
  }

  power(on) {
    this.write(Buffer.from([10, on ? 1 : 0]))
  }

  async stop() {
    try { this.videoSocket?.destroy() } catch { /* ignore */ }
    try { this.controlSocket?.destroy() } catch { /* ignore */ }
    try { this.serverProcess?.kill('SIGTERM') } catch { /* ignore */ }
    await adb(this.serial, ['shell', 'pkill', '-f', 'com.genymobile.scrcpy']).catch(() => {})
    if (this.port !== undefined) {
      await execFileAsync(adbPath(), ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {})
    }
    this.ready = false
  }
}

export async function androidScreenshot(serial, path) {
  const result = await execFileAsync(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 })
  if (!result.ok) throw new Error(result.stderr.trim() || 'screencap failed')
  writeFileSync(path, result.stdout)
  return path
}

export function readPngSize(path) {
  const bytes = readFileSync(path)
  if (bytes.length < 24) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
