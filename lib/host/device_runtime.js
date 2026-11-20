/**
 * Pinned device runtime as the dsh-sim device backend.
 *
 * The Codex plugin ships a stdio MCP server plus a self-contained browser
 * panel. In `DSH_SIM_RUNTIME_PANEL=browser` mode `mobile_open_simulator` returns a
 * loopback URL for that panel. The panel refuses framing (CSP frame-ancestors
 * 'none'), so this module runs a small loopback reverse proxy that strips the
 * frame headers (HTTP and WebSocket) and hands the panel URL to the tab.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, get as httpGet, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'

const VENDORED = fileURLToPath(new URL('../../vendor/runtime', import.meta.url))
const CACHE_ROOT = join(homedir(), '.codex', 'plugins', 'cache', 'device-runtime', 'device-runtime')
const RUNTIME_NODE = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node')

export function findRuntimeDist() {
  // An unpacked runtime elsewhere (a download, or a scratch copy while testing
  // a patch) wins when it is named explicitly.
  const override = process.env.DSH_SIM_RUNTIME_DIST
  if (typeof override === 'string' && override !== '' && existsSync(join(override, 'dist', 'server.mjs'))) return override
  if (existsSync(join(VENDORED, 'dist', 'server.mjs'))) return VENDORED
  if (process.env.DSH_SIM_MOBILE_DEV_DIST !== undefined) {
    const explicit = join(process.env.DSH_SIM_MOBILE_DEV_DIST, 'dist', 'server.mjs')
    return existsSync(explicit) ? process.env.DSH_SIM_MOBILE_DEV_DIST : undefined
  }
  if (!existsSync(CACHE_ROOT)) return undefined
  const versions = readdirSync(CACHE_ROOT).filter((name) => existsSync(join(CACHE_ROOT, name, 'dist', 'server.mjs')))
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const latest = versions.at(-1)
  return latest === undefined ? undefined : join(CACHE_ROOT, latest)
}

function readRuntimeEnv() {
  const file = join(homedir(), '.dsh', 'dsh-sim', 'runtime.env')
  if (!existsSync(file)) return {}
  const env = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const index = text.indexOf('=')
    if (index <= 0) continue
    env[text.slice(0, index).trim()] = text.slice(index + 1).trim()
  }
  return env
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function killStaleEngines(dist) {
  // Plugin reloads can leave earlier engine servers behind; they fight over the
  // device and the panel. Only this runtime's own processes are stale: another
  // install (or a scratch copy) may legitimately be running beside us.
  const targets = [join(dist, 'dist', 'server.mjs'), join(dist, 'dist', 'baguette', 'Baguette')]
  for (const target of targets) {
    try {
      const out = execFileSync('pgrep', ['-f', escapePattern(target)], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const pid = Number(line.trim())
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
        }
      }
    } catch { /* pgrep returns 1 when nothing matches */ }
  }
  // A CoreDevice display stream left open by an earlier serve-web run starves
  // every mirror the engine opens afterwards, so it is not allowed to outlive
  // the engine that started it.
  try {
    execFileSync('pkill', ['-f', 'core-device display serve-web'])
  } catch { /* nothing to reap */ }
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

/** Strip headers that would stop the panel from being framed or proxied. */
function cleanHeaders(rawHeaders) {
  const out = []
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]
    const lower = name.toLowerCase()
    if (lower === 'content-security-policy' || lower === 'x-frame-options' || lower === 'content-length' || lower === 'connection' || lower === 'transfer-encoding') continue
    out.push(name, rawHeaders[i + 1])
  }
  return out
}

class MobileDevBridge {
  constructor(dist, logger) {
    this.dist = dist
    this.logger = logger
    this.child = null
    this.panelUrl = null
    this.proxyUrl = null
    this.proxyPort = 0
    this.upstreamPort = 0
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.started = null
    this.generation = 0
  }

  #alive(url) {
    return new Promise((resolve) => {
      const request = httpGet(url, (response) => { response.resume(); resolve(response.statusCode === 200) })
      request.setTimeout(2000, () => { request.destroy(); resolve(false) })
      request.on('error', () => resolve(false))
    })
  }

  async ensure() {
    if (this.started !== null) {
      try {
        const url = await this.started
        if (await this.#alive(url)) return url
      } catch { /* fall through to restart */ }
      this.dispose()
    }
    this.started = (async () => {
      await this.#startServer()
      await this.#openPanel()
      return this.panelUrl
    })()
    try {
      return await this.started
    } catch (error) {
      this.started = null
      throw error
    }
  }

  async #startServer() {
    killStaleEngines(this.dist)
    const node = process.env.DSH_SIM_NODE || (existsSync(RUNTIME_NODE) ? RUNTIME_NODE : 'node')
    const child = spawn(node, [join(this.dist, 'dist', 'server.mjs')], {
      env: {
        ...process.env,
        HOME: homedir(),
        MOBILE_DEV_PANEL: 'browser',
        ...readRuntimeEnv(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.generation += 1
    child.stderr.on('data', (chunk) => this.logger?.warn?.(`dsh-sim: device-runtime: ${String(chunk).trim().slice(0, 300)}`))
    child.on('exit', () => { this.child = null; this.started = null })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-sim', version: '1.0.0' },
    })
    this.#notify('notifications/initialized')
  }

  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(message.error.message || 'device-runtime error'))
        else resolve(message.result)
      }
    }
  }

  async callTool(name, args = {}, options = {}) {
    await this.ensure()
    return this.#request('tools/call', { name, arguments: args }, options.timeoutMs)
  }

  /** Read one MCP app resource (the physical iPhone video batches live here). */
  async readResource(uri) {
    await this.ensure()
    const result = await this.#request('resources/read', { uri }, 15_000)
    const contents = Array.isArray(result?.contents) ? result.contents : []
    const content = contents.find((item) => item !== null && typeof item === 'object' && typeof item.text === 'string')
    if (content === undefined) throw new Error(`device-runtime returned no content for ${uri}`)
    try { return JSON.parse(content.text) } catch (error) { throw new Error(`device-runtime returned invalid JSON for ${uri}: ${error instanceof Error ? error.message : String(error)}`) }
  }

  #request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      if (this.child === null) {
        this.pending.delete(id)
        reject(new Error(`device-runtime ${method} failed: the engine is not running`))
        return
      }
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`device-runtime ${method} timed out`))
      }, timeoutMs)
      void timer
    })
  }

  #notify(method) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }

  async #openPanel() {
    const result = await this.#request('tools/call', { name: 'mobile_open_simulator', arguments: {} })
    const text = JSON.stringify(result ?? {})
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/([A-Za-z0-9_-]+)\//)
    if (match === null) throw new Error('device-runtime did not return a panel URL')
    this.upstreamPort = Number(match[1])
    this.tokenPath = `/${match[2]}/`
    this.panelUrl = `http://127.0.0.1:${this.upstreamPort}${this.tokenPath}?tool=mobile_open_simulator`
  }

  async #startProxy() {
    const port = await freePort()
    this.proxyPort = port
    const server = createServer((req, res) => {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: this.upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${this.upstreamPort}` },
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, cleanHeaders(response.rawHeaders))
        response.pipe(res)
      })
      upstream.on('error', () => { if (!res.writableEnded) { res.writeHead(502); res.end('upstream error') } })
      req.pipe(upstream)
    })
    server.on('upgrade', (req, socket, head) => {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: this.upstreamPort,
        path: req.url,
        method: 'GET',
        headers: { ...req.headers, host: `127.0.0.1:${this.upstreamPort}` },
      })
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        const headers = cleanHeaders(response.rawHeaders)
        let head = 'HTTP/1.1 101 Switching Protocols\r\n'
        for (let i = 0; i + 1 < headers.length; i += 2) head += `${headers[i]}: ${headers[i + 1]}\r\n`
        head += '\r\n'
        socket.write(head)
        if (upstreamHead.length > 0) socket.write(upstreamHead)
        if (head.length > 0) { /* no-op */ }
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
      })
      upstream.on('error', () => socket.destroy())
      upstream.end()
      socket.on('error', () => upstream.destroy())
      void head
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    this.proxyUrl = `http://127.0.0.1:${port}${this.tokenPath}?tool=mobile_open_simulator`
  }

  dispose() {
    try { this.child?.kill('SIGTERM') } catch { /* ignore */ }
    this.child = null
    this.started = null
  }
}

let bridge
let panelServedAt = 0

/** Remember that a sidebar tab asked for the panel; it polls while it is open. */
export function notePanelServed() {
  panelServedAt = Date.now()
}

/** Whether a panel has been served recently, which means its mirror is live. */
export function panelServedRecently(windowMs = 12_000) {
  return panelServedAt !== 0 && Date.now() - panelServedAt <= windowMs
}

export async function deviceRuntimePanel(logger) {
  if (bridge !== undefined) return bridge.ensure()
  const dist = findRuntimeDist()
  if (dist === undefined) {
    throw new Error('device runtime is not installed in Codex (~/.codex/plugins/cache/device-runtime)')
  }
  bridge = new MobileDevBridge(dist, logger)
  return bridge.ensure()
}

export async function deviceRuntimeTool(name, args = {}, options = {}) {
  const url = await deviceRuntimePanel()
  if (url === undefined || url === null) throw new Error('device runtime unavailable')
  if (bridge === undefined) throw new Error('device runtime bridge missing')
  return bridge.callTool(name, args, options)
}

/** Read one MCP app resource from the engine (its physical iPhone video session). */
export async function deviceRuntimeResource(uri) {
  const url = await deviceRuntimePanel()
  if (url === undefined || url === null) throw new Error('device runtime unavailable')
  if (bridge === undefined) throw new Error('device runtime bridge missing')
  return bridge.readResource(uri)
}

/** Counts engine starts, so callers can tell a restarted engine from a live one. */
export function deviceRuntimeGeneration() {
  return bridge?.generation ?? 0
}

export function disposeDeviceRuntime() {
  bridge?.dispose()
  bridge = undefined
}
