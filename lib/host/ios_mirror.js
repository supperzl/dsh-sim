/**
 * Physical iPhone control through the embedded engine's mirror session.
 *
 * The engine's mirror (HEVC over the CoreDevice display service) is the only
 * consumer of that display stream the plugin is allowed to have: a second
 * consumer, such as `pymobiledevice3 developer core-device display serve-web`,
 * takes the stream away from the engine and the mirror stops producing frames
 * for good. So taps, drags and scrolling go through the mirror's own HID
 * service (`mobile_ios_mirror_input`) instead of the XCTest runner used by
 * agent-device: the runner is launched into the foreground, which both steals
 * the app the user is looking at and makes the panel show the runner window
 * rather than the phone.
 */
import { execFileSync } from 'node:child_process'
import {
  deviceRuntimeGeneration, deviceRuntimePanel, deviceRuntimeResource, deviceRuntimeTool, disposeDeviceRuntime,
} from './device_runtime.js'
import { listPhysicalIosDevices } from './ios_device.js'

/** Logical points of the classic 3x iPhone panel, used when the entry has no pixels. */
const FALLBACK_POINTS = { width: 402, height: 874 }
const MIRROR_SERVICE_SCRIPT = 'ios-mirror-service.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The display's HID surface, in the same 0..1 space the tools already use. */
function sampleFor(type, nx, ny, points) {
  const x = Math.max(0, Math.min(1, Number(nx) || 0)) * points.width
  const y = Math.max(0, Math.min(1, Number(ny) || 0)) * points.height
  const edge = y > points.height - 14 ? 'bottom' : y < 14 ? 'top' : undefined
  return { type, x, y, ...points, ...(edge === undefined ? {} : { edge }) }
}

/**
 * A leftover `serve-web` process holds the display stream open even after the
 * code that started it is gone, and every later mirror then sees no frames.
 */
export function reapStrayDisplayConsumers(logger) {
  try {
    execFileSync('pkill', ['-f', 'core-device display serve-web'])
    logger?.info?.('dsh-sim: stopped a leftover CoreDevice serve-web stream')
  } catch { /* nothing to reap */ }
}

/**
 * The mirror service keeps one capture per iPhone for its whole lifetime. A
 * capture whose stream was taken over never recovers, so the service has to be
 * replaced; the engine starts a fresh one on the next session.
 */
export function restartMirrorService(logger) {
  try {
    execFileSync('pkill', ['-9', '-f', MIRROR_SERVICE_SCRIPT])
    logger?.info?.('dsh-sim: restarted the physical iPhone mirror service')
  } catch { /* it was not running */ }
}

function sessionFrom(result) {
  const meta = result?._meta ?? {}
  if (result?.isError === true || typeof meta.sessionId !== 'string' || typeof meta.frameUri !== 'string') {
    const text = Array.isArray(result?.content)
      ? result.content.map((item) => item?.text).filter((item) => typeof item === 'string').join(' ')
      : ''
    throw new Error(text === '' ? 'the engine did not open a physical iPhone mirror' : text)
  }
  return { sessionId: meta.sessionId, frameUri: meta.frameUri }
}

const SESSION_TIMEOUT_MS = 8_000
const INPUT_ATTEMPTS = 10
const INPUT_DEADLINE_MS = 6_000

export async function openMirrorSession(udid, timeoutMs = SESSION_TIMEOUT_MS) {
  return sessionFrom(await deviceRuntimeTool('mobile_ios_mirror_session', { udid }, { timeoutMs }))
}

export async function closeMirrorSession(sessionId) {
  if (typeof sessionId !== 'string') return
  await deviceRuntimeTool('mobile_ios_mirror_close', { sessionId }, { timeoutMs: SESSION_TIMEOUT_MS }).catch(() => {})
}

/** One HEVC batch: `generation`, `frames`, and the codec `configuration`. */
export async function readMirrorBatch(frameUri) {
  const batch = await deviceRuntimeResource(frameUri)
  return {
    generation: batch?.generation,
    frames: Array.isArray(batch?.frames) ? batch.frames : [],
    configuration: batch?.configuration,
  }
}

/** Open a session and wait until the device delivers a decodable keyframe. */
export async function probeMirror(udid, timeoutMs = 4000, openTimeoutMs = 8000) {
  const started = Date.now()
  let session
  try {
    session = await openMirrorSession(udid, openTimeoutMs)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const batch = await readMirrorBatch(session.frameUri)
      if (batch.frames.some((frame) => frame.key === true)) {
        return { ok: true, ms: Date.now() - started, generation: batch.generation }
      }
    }
    return { ok: false, ms: Date.now() - started, error: 'the iPhone did not send a screen frame' }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await closeMirrorSession(session?.sessionId)
  }
}

let prepared = { generation: -1, at: 0, ok: false, epoch: 0, device: null, error: null }

/**
 * Replace the shared mirror service. Its one capture per iPhone never recovers
 * from a display stream that was taken over, and the panel that was watching it
 * cannot either, so the epoch changes: the panel URL the sidebar polls carries
 * it, which reloads the tab onto the fresh mirror.
 */
let lastRepairAt = 0
let mirrorBusy = false

export function repairMirror(logger) {
  // Restarting takes a second and every restart drops the panel's stream, so a
  // burst of failing checks (the sidebar polls every five seconds) must not
  // restart the mirror over and over.
  if (Date.now() - lastRepairAt < 20_000) return prepared.epoch
  lastRepairAt = Date.now()
  reapStrayDisplayConsumers(logger)
  restartMirrorService(logger)
  prepared = { ...prepared, at: 0, ok: false, epoch: prepared.epoch + 1 }
  return prepared.epoch
}

/**
 * Make sure the engine can mirror a connected iPhone before the panel is shown.
 * A mirror that cannot produce a frame is replaced once; the returned epoch
 * changes with every repair so the sidebar can reload a panel that was left on
 * the broken stream.
 */
let preparing = null

/**
 * One probe at a time: the sidebar asks for the panel URL every few seconds, and
 * overlapping probes would fight over the mirror's single capture.
 */
export async function preparePhysicalMirror(logger, options = {}) {
  if (preparing !== null) return preparing
  preparing = probeAndPrepare(logger, options)
  try { return await preparing } finally { preparing = null }
}

async function probeAndPrepare(logger, options) {
  const generation = deviceRuntimeGeneration()
  if (prepared.generation !== generation) prepared = { generation, at: 0, ok: false, epoch: prepared.epoch, device: null }
  // Probing means opening a session and asking for a keyframe, which moves the
  // generation under any gesture in flight and costs the mirror a lock hold. So
  // it happens only when the answer cannot be trusted: a new engine, or a
  // failure that called invalidatePhysicalMirror(). The sidebar polls every few
  // seconds and must be answered from the cache in between.
  if (mirrorBusy === true) return prepared
  if (prepared.at !== 0) return prepared
  const devices = await listPhysicalIosDevices().catch(() => [])
  if (devices.length === 0) {
    prepared = { ...prepared, at: Date.now(), ok: true, device: null }
    return prepared
  }
  const device = devices[0].id
  let result = await probeMirror(device, options.timeoutMs ?? 4000, options.openTimeoutMs ?? 8000)
  if (result.ok !== true) {
    logger?.warn?.(`dsh-sim: physical iPhone mirror is not delivering frames (${result.error}); restarting it`)
    repairMirror(logger)
    await sleep(800)
    result = await probeMirror(device, options.retryTimeoutMs ?? 6000, options.openTimeoutMs ?? 8000)
  }
  if (result.ok !== true) {
    // The mirror service can be healthy while the engine's own client is stuck
    // (it keeps its sockets to a service that was replaced). A fresh engine
    // costs one panel reload and is the only thing left to try.
    logger?.warn?.('dsh-sim: restarting the device engine to recover the physical iPhone mirror')
    disposeDeviceRuntime()
    await sleep(700)
    await deviceRuntimePanel().catch(() => {})
    prepared = { ...prepared, generation: deviceRuntimeGeneration(), epoch: prepared.epoch + 1 }
    result = await probeMirror(device, options.retryTimeoutMs ?? 6000, options.openTimeoutMs ?? 8000)
  }
  prepared = { ...prepared, generation: deviceRuntimeGeneration(), at: Date.now(), ok: result.ok === true, device, error: result.error }
  if (result.ok !== true) logger?.warn?.(`dsh-sim: physical iPhone mirror still has no frames: ${result.error}`)
  return prepared
}

/** Forget the cached health so the next panel request probes again. */
export function invalidatePhysicalMirror() {
  prepared = { ...prepared, at: 0, ok: false }
}

export function physicalMirrorEpoch() {
  return prepared.epoch
}

/**
 * One gesture per mirror subscription.
 *
 * The engine ties a physical-iPhone subscription to the request that opened it:
 * over the plugin's stdio transport that request completes about a second later
 * and the subscription goes with it. So every gesture opens its own session,
 * waits for a screen the device will accept input on, sends the gesture, and
 * closes again.
 *
 * Input is gated on a decoder generation, and that generation moves whenever
 * the phone re-sends parameter sets (any keyframe request, any discontinuity,
 * any queue overflow). The panel asks for keyframes on its own, so the number
 * we read a moment ago is routinely stale by the time a press or a release is
 * delivered: the engine then answers "Wait for a fresh physical iOS screen
 * before sending input." Every step of a gesture therefore retries itself
 * against a freshly read screen instead of failing the tool call, and a finger
 * the device dropped mid-gesture (the addon lifts it on a configuration change)
 * is treated as already released.
 */
export class PhysicalMirror {
  constructor(udid, options = {}) {
    this.udid = udid
    this.points = options.points ?? FALLBACK_POINTS
    this.logger = options.logger
    this.stopped = false
  }

  #points() {
    const width = Number(this.points?.width)
    const height = Number(this.points?.height)
    return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? { width, height }
      : FALLBACK_POINTS
  }

  #sample(type, nx, ny, points) {
    return sampleFor(type, nx, ny, points)
  }

  /**
   * The newest generation the device has shown us. The short settle window
   * skips the burst of parameter-set revisions a fresh join produces.
   */
  async #screen(session, timeoutMs = 4000, settleMs = 120) {
    const deadline = Date.now() + timeoutMs
    let generation
    while (Date.now() < deadline) {
      const batch = await readMirrorBatch(session.frameUri)
      if (batch.generation !== undefined) generation = batch.generation
      if (batch.frames.some((frame) => frame.key === true)) break
    }
    if (generation === undefined) throw new Error('the iPhone did not send a screen frame; reopen the panel to restart its mirror')
    const settleUntil = Date.now() + settleMs
    while (Date.now() < settleUntil) {
      const batch = await readMirrorBatch(session.frameUri)
      if (batch.frames.some((frame) => frame.key === true) && batch.generation !== undefined) generation = batch.generation
    }
    return generation
  }

  #classify(text) {
    if (/fresh physical iOS screen|device_unavailable|generation/i.test(text)) return 'stale'
    if (/another panel is currently touching|input is already pending|resource_limit/i.test(text)) return 'busy'
    if (/already down/i.test(text)) return 'down'
    if (/must be down first|touch is not down/i.test(text)) return 'up'
    if (/expired or closed|stream closed/i.test(text)) return 'closed'
    return 'other'
  }

  /** One input call, retried until the device accepts it on a current screen. */
  async #call(session, messages, state, phase) {
    const deadline = Date.now() + INPUT_DEADLINE_MS
    let lastError = 'physical iPhone input failed'
    for (let attempt = 0; attempt < INPUT_ATTEMPTS && Date.now() < deadline; attempt += 1) {
      if (state.generation === undefined) state.generation = await this.#screen(session)
      let result
      try {
        result = await deviceRuntimeTool('mobile_ios_mirror_input', { sessionId: session.sessionId, generation: state.generation, messages }, { timeoutMs: SESSION_TIMEOUT_MS })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (/timed out/i.test(lastError) === false) throw error
        await sleep(120)
        continue
      }
      if (result?.isError !== true) return
      const text = Array.isArray(result?.content)
        ? result.content.map((item) => item?.text).filter((item) => typeof item === 'string').join(' ')
        : ''
      lastError = text === '' ? 'physical iPhone input failed' : text
      switch (this.#classify(lastError)) {
        case 'stale':
          // The screen moved on under us: read the new one and send again.
          state.generation = await this.#screen(session, 2500)
          break
        case 'busy':
          await sleep(120)
          break
        case 'down':
          // The device still has our finger down; a press is already in place.
          if (phase === 'down') return
          state.generation = await this.#screen(session, 2500)
          break
        case 'up':
          // The addon lifts the finger whenever the configuration changes, so a
          // release that arrives afterwards has nothing left to do.
          if (phase === 'up') return
          // A drag lost its finger: put it back down where the gesture is now.
          state.generation = await this.#screen(session, 2500)
          break
        case 'closed':
          throw new Error('the iPhone mirror closed during the gesture; reopen the panel and try again')
        default:
          throw new Error(lastError)
      }
    }
    throw new Error(`the iPhone screen kept changing; the gesture was not sent (${lastError.slice(0, 120)})`)
  }

  async #attempt(groups, holdMs) {
    const phases = groups.map((group, index) => {
      if (index === 0) return 'down'
      return index === groups.length - 1 ? 'up' : 'move'
    })
    const session = await openMirrorSession(this.udid)
    const state = { generation: undefined }
    let pressed = false
    try {
      state.generation = await this.#screen(session)
      for (const [index, messages] of groups.entries()) {
        if (index > 0 && holdMs > 0) await sleep(holdMs)
        await this.#call(session, messages, state, phases[index])
        if (phases[index] === 'down') pressed = true
        if (phases[index] === 'up') pressed = false
      }
    } catch (error) {
      // Never leave a finger down when the gesture could not finish.
      if (pressed === true) {
        const points = this.#points()
        const last = groups.at(-1)?.at(-1)
        if (last !== undefined) {
          await this.#call(session, [this.#sample('touch1-up', last.x / points.width, last.y / points.height, points)], state, 'up').catch(() => {})
        }
      }
      throw error
    } finally {
      // The engine ends the subscription when the opening request finishes, and
      // releasing the capture takes seconds when it was the last subscriber.
      // Nothing here waits for that: the next gesture opens its own session.
      void closeMirrorSession(session.sessionId)
    }
  }

  /** Sends one gesture, reopening the subscription once if it expired first. */
  async #gesture(groups, holdMs = 0) {
    if (this.stopped === true) throw new Error('this physical iPhone mirror is closed')
    mirrorBusy = true
    try { return await this.#sendGesture(groups, holdMs) } finally { mirrorBusy = false }
  }

  async #sendGesture(groups, holdMs) {
    let firstError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#attempt(groups, holdMs)
        return
      } catch (error) {
        firstError ??= error
        const text = error instanceof Error ? error.message : String(error)
        // A mirror that cannot even open a session is wedged, not busy: replace
        // the service once and try the same gesture again.
        if (attempt === 0 && /expired or closed|did not send a screen frame|timed out|closed during/i.test(text)) {
          this.logger?.warn?.(`dsh-sim: physical iPhone mirror failed (${text.slice(0, 120)}); restarting it`)
          repairMirror(this.logger)
          await sleep(900)
          continue
        }
        throw error
      }
    }
    throw firstError
  }

  async tap(nx, ny) {
    const points = this.#points()
    await this.#gesture([
      [this.#sample('touch1-down', nx, ny, points)],
      [this.#sample('touch1-up', nx, ny, points)],
    ], 80)
  }

  /**
   * A drag from an ordered list of normalized points, as `sim_swipe` reports it.
   * The samples travel in a few groups with a short pause between them: iOS
   * reads a whole report series delivered at once as a fling with no motion, so
   * the gesture has to take a little real time to scroll the app.
   */
  async swipe(pointsList) {
    const points = this.#points()
    if (pointsList.length === 0) return
    if (pointsList.length === 1) { await this.tap(pointsList[0][0], pointsList[0][1]); return }
    const samples = pointsList.map(([x, y], index) => this.#sample(
      index === 0 ? 'touch1-down' : index === pointsList.length - 1 ? 'touch1-up' : 'touch1-move',
      x, y, points,
    ))
    const groups = []
    const groupCount = Math.min(4, Math.max(1, Math.round(samples.length / 3)))
    const size = Math.ceil(samples.length / groupCount)
    for (let start = 0; start < samples.length; start += size) groups.push(samples.slice(start, start + size))
    await this.#gesture(groups, 25)
  }

  /** Wheel/trackpad scrolling becomes a vertical drag under the pointer. */
  async scroll(dy, x = 0.5, y = 0.5) {
    const amount = Math.max(-1, Math.min(1, Number(dy) || 0))
    if (amount === 0) return
    const px = Math.max(0.03, Math.min(0.97, Number(x) || 0.5))
    const py = Math.max(0.03, Math.min(0.97, Number(y) || 0.5))
    const toY = Math.max(0.02, Math.min(0.98, py - amount * 0.18))
    const pointsList = []
    for (let step = 0; step <= 8; step += 1) pointsList.push([px, py + (toY - py) * (step / 8)])
    await this.swipe(pointsList)
  }

  async close() {
    this.stopped = true
  }
}
