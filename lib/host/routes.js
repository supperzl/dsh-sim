/**
 * HTTP routes for the panel, mounted on the DSH webserver.
 *
 * The desktop GUI may be served from a custom scheme rather than an http
 * origin, where `ws://` is not available. Everything therefore travels over
 * plain same-origin HTTP:
 *
 *   GET  /_dsh/dsh-sim/devices     device inventory (iOS + Android + AVDs)
 *   POST /_dsh/dsh-sim/status      { sessionId } -> running state
 *   POST /_dsh/dsh-sim/start       { sessionId, platform, device }
 *   POST /_dsh/dsh-sim/stop        { sessionId }
 *   POST /_dsh/dsh-sim/screenshot  { sessionId } -> PNG bytes
 *   GET  /_dsh/dsh-sim/stream?sessionId=…  streaming video bytes
 *   POST /_dsh/dsh-sim/control     { sessionId, event } -> device input
 *
 * Every route is loopback-only and rejects cross-origin callers. The browser
 * never talks to serve-sim or adb directly.
 */
import { get as httpGet } from 'node:http'

export const ROUTE_PREFIX = '/_dsh/dsh-sim'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) reject(new Error('body too large')) })
    req.on('end', () => {
      if (body === '') return resolve({})
      try { resolve(JSON.parse(body)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function loopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host ?? ''))
}

function trustedRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  if (!loopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== '' && origin !== `http://${req.headers.host}`) return false
  return true
}

function sessionIdOf(req, body) {
  if (typeof body?.sessionId === 'string') return body.sessionId
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') ?? ''
  } catch {
    return ''
  }
}

function listDevices(manager) {
  return async (req, res) => {
    if (!trustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
    try {
      sendJson(res, 200, { ok: true, ...(await manager.devices()) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function postRoute(manager, kind) {
  return async (req, res) => {
    if (!trustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
    let body
    try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { ok: false, error: String(error.message) }) }
    const sessionId = sessionIdOf(req, body)
    if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId is required' })
    try {
      if (kind === 'status') return sendJson(res, 200, { ok: true, ...manager.status(sessionId) })
      if (kind === 'start') return sendJson(res, 200, { ok: true, ...(await manager.start(sessionId, body)) })
      if (kind === 'stop') return sendJson(res, 200, { ok: true, ...(await manager.stop(sessionId)) })
      if (kind === 'diag') {
        manager.setClientInfo(sessionId, body.diag ?? {})
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'control') {
        await manager.control(sessionId, body.event ?? {})
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'screenshot') {
        const shot = await manager.screenshot(sessionId)
        const bytes = await import('node:fs').then(({ readFileSync }) => readFileSync(shot.path))
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
        res.end(bytes)
        return
      }
      return sendJson(res, 404, { ok: false, error: 'unknown route' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Streaming video: iOS AVCC envelopes or Android scrcpy packets, raw. */
function streamRoute(manager, logger) {
  return async (req, res) => {
    if (!trustedRequest(req)) { res.writeHead(403); res.end('forbidden'); return }
    const sessionId = sessionIdOf(req)
    const entry = manager.get(sessionId)
    if (entry === undefined) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no simulator is running in this conversation' }))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })
    if (req.socket) req.socket.setNoDelay?.(true)

    if (entry.platform === 'ios') {
      const upstream = httpGet(entry.stream.avccUrl, (response) => {
        if (response.statusCode !== 200) {
          res.end()
          response.resume()
          return
        }
        response.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk) })
        response.on('end', () => { if (!res.writableEnded) res.end() })
        response.on('error', () => { if (!res.writableEnded) res.end() })
      })
      upstream.on('error', (error) => {
        logger?.warn?.(`dsh-sim: avcc stream failed: ${error.message}`)
        if (!res.writableEnded) res.end()
      })
      res.on('close', () => upstream.destroy())
      return
    }

    const detach = entry.stream.attachVideo((chunk) => { if (!res.writableEnded) res.write(chunk) })
    res.on('close', () => detach())
  }
}

export function mountRoutes(webServer, manager, logger) {
  const disposers = []
  disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/devices`, handler: listDevices(manager) }))

  for (const kind of ['status', 'start', 'stop', 'control', 'screenshot', 'diag']) {
    disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/${kind}`, handler: postRoute(manager, kind) }))
  }
  disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/stream`, handler: streamRoute(manager, logger) }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
