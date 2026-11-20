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
import { deviceRuntimePanel, notePanelServed } from './device_runtime.js'
import { preparePhysicalMirror } from './ios_mirror.js'

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

function streamIdOf(req, body) {
  if (typeof body?.streamId === 'string' && body.streamId !== '') return body.streamId
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('streamId') ?? ''
  } catch {
    return ''
  }
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
    const streamId = streamIdOf(req, body)
    if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId is required' })
    try {
      if (kind === 'status') return sendJson(res, 200, { ok: true, ...manager.status(sessionId, streamId) })
      if (kind === 'start') return sendJson(res, 200, { ok: true, ...(await manager.start(sessionId, { ...body, streamId })) })
      if (kind === 'stop') return sendJson(res, 200, { ok: true, ...(await manager.stop(sessionId, streamId)) })
      if (kind === 'diag') {
        manager.setClientInfo(sessionId, body.diag ?? {}, streamId)
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'control') {
        await manager.control(sessionId, body.event ?? {}, streamId)
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'logs') {
        return sendJson(res, 200, { ok: true, ...(await manager.logs(sessionId, streamId, body)) })
      }
      if (kind === 'shutdown') {
        return sendJson(res, 200, { ok: true, ...(await manager.shutdown(sessionId, streamId)) })
      }
      if (kind === 'screenshot') {
        const shot = await manager.screenshot(sessionId, streamId)
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
    const streamId = streamIdOf(req)
    const entry = manager.get(sessionId, streamId)
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

    if (entry.physical === true) {
      const upstream = httpGet(entry.stream.videoUrl, (response) => {
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
        logger?.warn?.(`dsh-sim: device stream failed: ${error.message}`)
        if (!res.writableEnded) res.end()
      })
      res.on('close', () => upstream.destroy())
      return
    }

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


/** A same-origin harness for the HEVC player (debug aid, loopback only). */
const HEVC_TEST_PAGE = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-sim HEVC test</title>
<style>body{margin:0;background:#111;color:#ddd;font:12px/1.5 -apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px}
canvas{max-width:100%;max-height:80vh;background:#000;border-radius:12px}</style></head>
<body><div id="status">starting…</div><canvas id="c"></canvas>
<script>
const params = new URLSearchParams(location.search);
const q = '?sessionId=' + encodeURIComponent(params.get('sessionId') || '') + '&streamId=' + encodeURIComponent(params.get('streamId') || '');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let decoder = null, frames = 0, failed = 0, buffer = new Uint8Array(0), queue = [], configured = false, ts = 0, bytes = 0;
function setStatus(text) { document.getElementById('status').textContent = text; }
function paint(frame) {
  frames += 1;
  if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
  ctx.drawImage(frame, 0, 0); frame.close();
  if (frames % 10 === 0) setStatus('frames ' + frames + ' · ' + canvas.width + 'x' + canvas.height + ' · failed ' + failed + ' · ' + (bytes/1024/1024).toFixed(1) + ' MB');
}
function decodeNal(nal) {
  const type = (nal[0] >> 1) & 0x3f;
  if (type === 32 || type === 33 || type === 34) return;
  if (!configured) { queue.push(nal); return; }
  try { decoder.decode(new EncodedVideoChunk({ type: (type >= 16 && type <= 21) ? 'key' : 'delta', timestamp: ts += 1, data: nal })); }
  catch (e) { failed += 1; }
}
function push(bytes) {
  bytes = bytes; // shadowed
  const merged = new Uint8Array(buffer.length + bytes.length);
  merged.set(buffer); merged.set(bytes, buffer.length); buffer = merged;
  while (buffer.length >= 4) {
    const length = ((buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3]) >>> 0;
    if (length === 0 || length > 16*1024*1024) { failed += 1; buffer = new Uint8Array(0); return; }
    if (buffer.length < 4 + length) break;
    const nal = buffer.slice(4, 4 + length); buffer = buffer.slice(4 + length); decodeNal(nal);
  }
}
async function main() {
  const info = await (await fetch('/_dsh/dsh-sim/codec' + q, { cache: 'no-store' })).json();
  setStatus('codec ' + info.codec);
  const bin = atob(info.description); const desc = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) desc[i] = bin.charCodeAt(i);
  decoder = new VideoDecoder({ output: paint, error: (e) => { failed += 1; setStatus('decoder error ' + e.message); } });
  decoder.configure({ codec: info.codec, description: desc, optimizeForLatency: true });
  configured = true;
  for (const nal of queue) decodeNal(nal);
  queue = [];
  const resp = await fetch('/_dsh/dsh-sim/stream' + q, { cache: 'no-store' });
  if (!resp.ok || !resp.body) { setStatus('stream HTTP ' + resp.status); return; }
  const reader = resp.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) { bytes += value.length; push(value); } }
  setStatus('stream ended');
}
main().catch((e) => setStatus('error ' + e.message));
</script></body></html>`;

/** The engine panel runs on its own loopback port; only the context route accepts it. */
function panelRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback || !loopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

function panelCors(req, res) {
  const origin = req.headers.origin
  if (origin !== undefined && origin !== '') {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function mountRoutes(webServer, manager, logger) {
  const disposers = []
  disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/devices`, handler: listDevices(manager) }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/mobile-panel`,
    handler: (req, res) => {
      if (!trustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
      notePanelServed()
      // The panel is the engine's own page, and its physical-iPhone mirror is
      // the only video path that can recover from a display stream that was
      // taken over. Check it before handing the URL to the tab: a mirror that
      // cannot produce a frame is replaced, and the epoch in the URL reloads a
      // panel that was left on the broken stream.
      deviceRuntimePanel(logger)
        .then(async (url) => {
          const mirror = await preparePhysicalMirror(logger).catch((error) => {
            logger?.warn?.(`dsh-sim: physical iPhone mirror check failed: ${error instanceof Error ? error.message : String(error)}`)
            return { epoch: 0, ok: false }
          })
          const separator = url.includes('?') ? '&' : '?'
          return { url: `${url}${separator}mirror=${mirror.epoch}`, mirror }
        })
        .then((result) => sendJson(res, 200, { ok: true, url: result.url, mirror: { ok: result.mirror.ok === true, epoch: result.mirror.epoch ?? 0 } }))
        .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/key`,
    handler: async (req, res) => {
      panelCors(req, res)
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      if (!panelRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
      try {
        const body = await readBody(req)
        const udid = typeof body?.udid === 'string' ? body.udid : ''
        const names = { home: 'home', lock: 'lock', volume_up: 'volume-up', volume_down: 'volume-down' }
        const name = names[body?.name]
        if (udid === '' || name === undefined) return sendJson(res, 400, { ok: false, error: 'udid and a known key name are required' })
        const { iosDeviceButton } = await import('./ios_device.js')
        await iosDeviceButton(udid, name)
        sendJson(res, 200, { ok: true, pressed: body.name })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/panel-context`,
    handler: async (req, res) => {
      panelCors(req, res)
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      if (!panelRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
      try {
        const body = await readBody(req)
        const saved = await manager.savePanelContext(body)
        sendJson(res, 200, { ok: true, ...saved })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/codec`,
    handler: (req, res) => {
      if (!trustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
      const sessionId = sessionIdOf(req)
      const streamId = streamIdOf(req)
      const entry = manager.get(sessionId, streamId)
      const info = entry?.physical === true ? entry.stream?.codecInfo : undefined
      if (info === undefined) return sendJson(res, 404, { ok: false, error: 'no codec for this stream' })
      sendJson(res, 200, { ok: true, ...info })
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/debug`,
    handler: (req, res) => {
      if (!trustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
      sendJson(res, 200, {
        ok: true,
        sessions: [...manager.sessions.keys()],
        client: Object.fromEntries(manager.clientInfo),
      })
    },
  }))

  for (const kind of ['status', 'start', 'stop', 'control', 'screenshot', 'diag', 'shutdown', 'logs']) {
    disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/${kind}`, handler: postRoute(manager, kind) }))
  }
  disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/stream`, handler: streamRoute(manager, logger) }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
