/**
 * Pinned device runtime as the dsh-sim device backend.
 *
 * The Codex plugin ships a stdio MCP server plus a self-contained browser
 * panel. In `DSH_SIM_RUNTIME_PANEL=browser` mode `mobile_open_simulator` returns a
 * loopback URL for that panel. The panel refuses framing (CSP frame-ancestors
 * 'none'), so this module runs a small loopback reverse proxy that strips the
 * frame headers (HTTP and WebSocket) and hands the panel URL to the tab.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'

const VENDORED = fileURLToPath(new URL('../../vendor/runtime', import.meta.url))
const CACHE_ROOT = join(homedir(), '.codex', 'plugins', 'cache', 'device-runtime', 'device-runtime')
const RUNTIME_NODE = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node')

export function findRuntimeDist() {
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
  }

  async ensure() {
    if (this.started !== null) return this.started
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
    const node = process.env.DSH_SIM_NODE || (existsSync(RUNTIME_NODE) ? RUNTIME_NODE : 'node')
    const child = spawn(node, [join(this.dist, 'dist', 'server.mjs')], {
      env: {
        ...process.env,
        HOME: homedir(),
        MOBILE_DEV_PANEL: 'browser',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
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

  #request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`device-runtime ${method} timed out`))
      }, 30_000).unref?.()
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

export async function deviceRuntimePanel(logger) {
  if (bridge !== undefined) return bridge.ensure()
  const dist = findRuntimeDist()
  if (dist === undefined) {
    throw new Error('device runtime is not installed in Codex (~/.codex/plugins/cache/device-runtime)')
  }
  bridge = new MobileDevBridge(dist, logger)
  return bridge.ensure()
}

export function disposeDeviceRuntime() {
  bridge?.dispose()
  bridge = undefined
}
