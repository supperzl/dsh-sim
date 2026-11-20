/**
 * Physical iPhone / iPad discovery and screenshots.
 *
 * The device's own HEVC mirror belongs to the embedded engine (see
 * `ios_mirror.js`): its panel is the video surface, and nothing here may open a
 * second display stream. `pymobiledevice3 developer core-device display
 * serve-web` used to live in this file; a single leftover of it takes the
 * display away from the engine and every later mirror then sees no frames, so
 * the stream is gone on purpose. Screenshots use the separate capture service
 * and leave a running mirror alone.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

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

/**
 * Press a hardware button over the CoreDevice HID service. This is how the
 * home button works on a physical iPhone: the engine's mirror only injects
 * touches, and the XCTest runner agent-device launches takes a minute to bring
 * up and puts its own window in front of the phone.
 */
export async function iosDeviceButton(udid, name, state = 'press') {
  await execFileAsync(pymobiledevice3Path(), [
    'developer', 'core-device', 'hid', 'button', name, state, '--udid', udid,
  ], { timeout: 20_000, maxBuffer: 4 << 20 })
}

const HID_SCALE = 65535

function hidCoordinate(value) {
  return Math.max(0, Math.min(HID_SCALE, Math.round((Number(value) || 0) * HID_SCALE)))
}

/**
 * A tap through pymobiledevice3's universal HID service. It auto-opens a media
 * stream of its own, which takes the display away from the engine's mirror, so
 * this is only used when no panel is watching the phone.
 */
export async function iosDeviceHidTap(udid, x, y) {
  await execFileAsync(pymobiledevice3Path(), [
    'developer', 'core-device', 'universal-hid-service', 'tap',
    String(hidCoordinate(x)), String(hidCoordinate(y)), '--udid', udid,
  ], { timeout: 30_000, maxBuffer: 8 << 20 })
}

/** A drag through the same service, from (fromX, fromY) to (toX, toY). */
export async function iosDeviceHidDrag(udid, fromX, fromY, toX, toY) {
  await execFileAsync(pymobiledevice3Path(), [
    'developer', 'core-device', 'universal-hid-service', 'drag',
    String(hidCoordinate(fromX)), String(hidCoordinate(fromY)),
    String(hidCoordinate(toX)), String(hidCoordinate(toY)), '--udid', udid,
  ], { timeout: 30_000, maxBuffer: 8 << 20 })
}

/** One PNG of the current screen; does not disturb the engine's mirror. */
export async function iosDeviceScreenshot(udid, path) {
  await execFileAsync(pymobiledevice3Path(), [
    'developer', 'core-device', 'screen-capture', 'screenshot', path, '--udid', udid,
  ], { timeout: 40_000, maxBuffer: 4 << 20 })
}
