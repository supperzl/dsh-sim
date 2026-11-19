/**
 * Device discovery for dsh-sim.
 *
 * iOS: `xcrun simctl list devices -j` (macOS + full Xcode only).
 * Android: `adb devices -l` plus `emulator -list-avds`.
 *
 * Every function returns plain objects the panel and the tools consume; a
 * missing SDK is a normal answer, never a thrown error, so the panel can show
 * a useful empty state.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
  })
})

export function androidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library/Android/sdk'),
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const dir of candidates) {
    const adb = join(dir, 'platform-tools', 'adb')
    if (existsSync(adb)) {
      return { dir, adb, emulator: join(dir, 'emulator', 'emulator') }
    }
  }
  return undefined
}

export function isMacos() {
  return process.platform === 'darwin'
}

/** All iOS simulators, newest runtime first. */
export async function listIosDevices() {
  if (!isMacos()) return { available: false, reason: 'iOS Simulator requires macOS', devices: [] }
  const result = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j'])
  if (!result.ok) {
    return { available: false, reason: result.stderr.trim() || 'xcrun simctl is unavailable', devices: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { available: false, reason: 'simctl returned invalid JSON', devices: [] }
  }
  const devices = []
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    if (!/SimRuntime\.iOS-/.test(runtime)) continue
    for (const device of list) {
      if (device.isAvailable === false) continue
      devices.push({
        platform: 'ios',
        id: device.udid,
        name: device.name,
        state: device.state,
        runtime: runtime.replace(/^.*SimRuntime\./, '').replace(/-/g, '.'),
        kind: 'simulator',
      })
    }
  }
  devices.sort((a, b) => (a.state === 'Booted' ? -1 : 0) - (b.state === 'Booted' ? -1 : 0)
    || a.name.localeCompare(b.name))
  return { available: true, devices }
}

/** Connected Android devices and locally defined AVDs. */
export async function listAndroidDevices() {
  const sdk = androidSdk()
  if (sdk === undefined) {
    return { available: false, reason: 'Android SDK not found (set ANDROID_HOME)', devices: [], avds: [] }
  }
  const [devicesResult, avdsResult] = await Promise.all([
    execFileAsync(sdk.adb, ['devices', '-l']),
    existsSync(sdk.emulator) ? execFileAsync(sdk.emulator, ['-list-avds']) : Promise.resolve({ ok: false, stdout: '' }),
  ])
  const devices = []
  if (devicesResult.ok) {
    const lines = devicesResult.stdout.split('\n').slice(1)
    for (const line of lines) {
      const match = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim())
      if (match === null) continue
      const [, serial, state, rest] = match
      const prop = (key) => {
        const found = new RegExp(`${key}:(\\S+)`).exec(rest)
        return found === null ? undefined : found[1]
      }
      const model = prop('model')
      devices.push({
        platform: 'android',
        id: serial,
        name: (model ?? serial).replace(/_/g, ' '),
        state,
        kind: serial.startsWith('emulator-') ? 'emulator' : 'physical',
        serial,
        model,
        product: prop('product'),
      })
    }
  }
  await Promise.all(devices.filter((device) => device.state === 'device').map(async (device) => {
    const props = await execFileAsync(sdk.adb, [
      '-s', device.serial, 'shell',
      'getprop ro.build.version.release; getprop ro.build.version.sdk',
    ], { timeout: 6_000 })
    if (!props.ok) return
    const lines = props.stdout.trim().split('\n')
    if (lines[0]) device.osVersion = lines[0].trim()
    const sdkVersion = Number(lines[1])
    if (Number.isFinite(sdkVersion) && sdkVersion > 0) device.sdk = sdkVersion
  }))
  const avds = avdsResult.ok
    ? avdsResult.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    : []
  return {
    available: true,
    reason: devicesResult.ok ? undefined : (devicesResult.stderr.trim() || 'adb is unavailable'),
    devices,
    avds,
  }
}

/** Everything the panel's dropdown needs, in one call. */
export async function listAllDevices() {
  const [ios, android] = await Promise.all([listIosDevices(), listAndroidDevices()])
  return {
    ios: ios.devices,
    android: android.devices,
    avds: android.avds,
    available: { ios: ios.available, android: android.available },
    reasons: { ios: ios.reason, android: android.reason },
  }
}
