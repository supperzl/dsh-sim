/**
 * First-run setup for a machine that has never used the plugin.
 *
 * Everything the plugin needs is either bundled (`vendor/runtime/dist`) or
 * provisioned on demand: the physical-iPhone helpers come from `pymobiledevice3`
 * in a private venv under the DSH cache, and any bundled Mach-O helper whose
 * signature was lost is signed ad hoc again. Nothing here needs an Apple
 * developer account, and nothing is installed until a physical iPhone is in
 * play — simulators and Android devices work with what the package ships.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CACHE_DIR = join(homedir(), '.dsh', 'cache', 'dsh-sim')
export const VENV_DIR = join(CACHE_DIR, 'venv')
const VENV_PYTHON = join(VENV_DIR, 'bin', 'python3')
const VENV_PIP = join(VENV_DIR, 'bin', 'pip3')
export const PYMOBILEDEVICE3 = join(VENV_DIR, 'bin', 'pymobiledevice3')
const LOCK_FILE = join(CACHE_DIR, 'setup.lock')
const RUNTIME_DIST = fileURLToPath(new URL('../../vendor/runtime/dist', import.meta.url))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error) => (error instanceof Error ? error.message : String(error))

/* ---------------------------------------------------------- node runtime --- */

/**
 * The engine needs a Node >= 22.19. Prefer an explicit override, then Codex's
 * bundled runtime when the user has it, then a system node, and finally the DSH
 * app itself in `node` mode: the desktop app ships a Node that satisfies the
 * engine, so a machine without any Node installation still works.
 */
export async function runtimeNode() {
  const candidates = []
  if (typeof process.env.DSH_SIM_NODE === 'string' && process.env.DSH_SIM_NODE !== '') {
    candidates.push({ command: process.env.DSH_SIM_NODE, env: {}, source: 'DSH_SIM_NODE' })
  }
  const codex = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node')
  if (existsSync(codex)) candidates.push({ command: codex, env: {}, source: 'Codex runtime' })
  candidates.push({ command: 'node', env: {}, source: 'system node' })
  candidates.push({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'DSH app' })
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, ['-v'], { timeout: 15_000, env: { ...process.env, ...candidate.env } })
      const version = String(stdout).trim().replace(/^v/, '')
      const [major, minor] = version.split('.').map(Number)
      if (major > 22 || (major === 22 && minor >= 19)) return { ...candidate, version }
    } catch { /* try the next candidate */ }
  }
  return undefined
}

/* ------------------------------------------------------ bundled helpers ---- */

function machoFiles(root) {
  const found = []
  const walk = (directory) => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (entry.isSymbolicLink() || entry.isFile() === false) continue
      try {
        const header = Buffer.alloc(4)
        const handle = openSync(path, 'r')
        readSync(handle, header, 0, 4, 0)
        closeSync(handle)
        const magic = header.readUInt32BE(0)
        if (magic === 0xcffaedfe || magic === 0xcefaedfe || magic === 0xcafebabe) found.push(path)
      } catch { /* unreadable */ }
    }
  }
  walk(root)
  return found
}

/** Mach-O helpers must carry at least an ad-hoc signature to run on arm64. */
export async function signBundledHelpers(logger) {
  if (process.platform !== 'darwin') return { checked: 0, signed: [] }
  const files = machoFiles(RUNTIME_DIST)
  const signed = []
  for (const file of files) {
    try {
      await execFileAsync('codesign', ['--verify', '--strict', file], { timeout: 30_000 })
    } catch {
      try {
        await execFileAsync('codesign', ['--force', '--sign', '-', file], { timeout: 60_000 })
        signed.push(file.slice(RUNTIME_DIST.length + 1))
      } catch (error) {
        logger?.warn?.(`dsh-sim: could not sign ${file}: ${errorText(error)}`)
      }
    }
  }
  if (signed.length > 0) logger?.info?.(`dsh-sim: signed ${signed.length} bundled helper(s)`)
  return { checked: files.length, signed }
}

/* ------------------------------------------------------ pymobiledevice3 ---- */

export function hasPymobiledevice3() {
  return existsSync(PYMOBILEDEVICE3)
}

export async function pymobiledevice3Status() {
  if (existsSync(PYMOBILEDEVICE3) === false) return { installed: false }
  // The CLI has no --version; its own package metadata is the version.
  try {
    const { stdout } = await execFileAsync(VENV_PYTHON, ['-c', "import importlib.metadata as m; print(m.version('pymobiledevice3'))"], { timeout: 20_000 })
    return { installed: true, path: PYMOBILEDEVICE3, version: String(stdout).trim() }
  } catch (error) {
    return { installed: false, path: PYMOBILEDEVICE3, error: errorText(error) }
  }
}

async function findPython3() {
  for (const command of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3']) {
    try {
      const { stdout } = await execFileAsync(command, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 20_000 })
      const [major, minor] = String(stdout).trim().split('.').map(Number)
      if (major === 3 && minor >= 9) return { command, version: `${major}.${minor}` }
    } catch { /* try the next one */ }
  }
  return undefined
}

async function withLock(run, logger) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const started = Date.now()
  for (;;) {
    try { writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); break }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const age = existsSync(LOCK_FILE) ? Date.now() - statSync(LOCK_FILE).mtimeMs : 0
      if (age > 15 * 60_000) { rmSync(LOCK_FILE, { force: true }); continue }
      logger?.info?.('dsh-sim: waiting for another setup run to finish')
      await sleep(1000)
    }
  }
  try { return await run() } finally { rmSync(LOCK_FILE, { force: true }) }
}

/**
 * Install `pymobiledevice3` into the plugin's own venv once. Safe to call from
 * several places: the lock keeps one installer and the others wait for it.
 */
export async function ensurePymobiledevice3(logger) {
  const status = await pymobiledevice3Status()
  if (status.installed) return status
  return withLock(async () => {
    const again = await pymobiledevice3Status()
    if (again.installed) return again
    const python = await findPython3()
    if (python === undefined) {
      throw new Error('需要 python3 ≥ 3.9：先安装 Xcode Command Line Tools（xcode-select --install），再运行 sim_setup')
    }
    logger?.info?.(`dsh-sim: creating the physical-iPhone environment with python ${python.version}`)
    if (existsSync(VENV_PYTHON) === false) {
      await execFileAsync(python.command, ['-m', 'venv', VENV_DIR], { timeout: 180_000 })
    }
    await execFileAsync(VENV_PIP, ['install', '--upgrade', 'pip'], { timeout: 600_000, maxBuffer: 16 << 20 })
    await execFileAsync(VENV_PIP, ['install', 'pymobiledevice3'], { timeout: 900_000, maxBuffer: 32 << 20 })
    try {
      writeFileSync(join(CACHE_DIR, 'tools.json'), JSON.stringify({ python: python.version, installedAt: new Date().toISOString() }, null, 2))
    } catch { /* a missing marker only costs another version check */ }
    const done = await pymobiledevice3Status()
    if (done.installed === false) throw new Error(`pymobiledevice3 安装失败：${done.error ?? '未知错误'}`)
    logger?.info?.(`dsh-sim: pymobiledevice3 ${done.version} ready`)
    return done
  }, logger)
}

/** Anything the physical-iPhone path needs, provisioned in one call. */
export async function ensurePhysicalTools(logger) {
  const helpers = await signBundledHelpers(logger)
  const pymobiledevice3 = await ensurePymobiledevice3(logger)
  return { helpers, pymobiledevice3 }
}

/** A USB iPhone/iPad the system can see, without needing pymobiledevice3. */
export async function usbIosDevicePresent() {
  if (process.platform !== 'darwin') return false
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPUSBDataType'], { timeout: 20_000, maxBuffer: 8 << 20 })
    return /iPhone|iPad/i.test(stdout)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- doctor ----- */

async function xcodeVersion() {
  try {
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], { timeout: 30_000 })
    return String(stdout).split('\n')[0].replace(/^Xcode\s+/, '')
  } catch {
    return undefined
  }
}

/**
 * Everything a new machine needs, as a checklist. `probe` also asks the engine
 * to open the mirror once, which is the only way to know the phone's display
 * stream is reachable.
 */
export async function setupReport(logger, options = {}) {
  const checks = []
  const add = (id, label, ok, detail, fix) => checks.push({ id, label, ok, detail, ...(fix === undefined ? {} : { fix }) })

  const platformOk = process.platform === 'darwin' && process.arch === 'arm64'
  add('platform', '系统', platformOk, `${process.platform}/${process.arch}`,
    platformOk ? undefined : (process.platform === 'darwin' ? '物理 iPhone 镜像需要 Apple Silicon' : '仅支持 macOS'))

  const node = await runtimeNode()
  add('node', 'Node 运行时（引擎）', node !== undefined,
    node === undefined ? '找不到 ≥ 22.19 的 Node' : `${node.version}（${node.source}）`,
    node === undefined ? '安装 Node 22+，或让插件使用 DSH 自带运行时' : undefined)

  const engine = join(RUNTIME_DIST, 'server.mjs')
  const service = join(RUNTIME_DIST, 'ios-mirror-service.mjs')
  let engineDetail = '未安装内置引擎'
  let engineOk = false
  if (existsSync(engine) && existsSync(service)) {
    const patchedServer = readFileSync(engine, 'utf8').includes("content-security-policy\": \"base-uri 'none'")
    const patchedService = readFileSync(service, 'utf8').includes('device.reopening')
    engineOk = patchedServer && patchedService
    engineDetail = engineOk ? '内置引擎已安装并打好补丁' : '内置引擎补丁缺失（重新安装插件）'
  }
  add('engine', '内置引擎', engineOk, engineDetail, engineOk ? undefined : 'npm run build / 重新安装插件')

  const helpers = await signBundledHelpers(logger)
  add('helpers', '内置原生组件签名', true, `${helpers.checked} 个 Mach-O，本次重签 ${helpers.signed.length} 个`, undefined)

  const python = await findPython3()
  add('python3', 'python3 ≥ 3.9（真机需要）', python !== undefined,
    python === undefined ? '没有可用的 python3' : `${python.version}（${python.command}）`,
    python === undefined ? 'xcode-select --install' : undefined)

  const pymobiledevice3 = await pymobiledevice3Status()
  add('pymobiledevice3', 'pymobiledevice3（真机截图/按键）', pymobiledevice3.installed,
    pymobiledevice3.installed ? pymobiledevice3.version : '未安装（sim_setup 会装到 ~/.dsh/cache/dsh-sim/venv）',
    pymobiledevice3.installed ? undefined : 'sim_setup')

  const xcode = await xcodeVersion()
  add('xcode', 'Xcode（iOS 模拟器 / agent-device）', xcode !== undefined,
    xcode ?? '未安装（真机镜像不需要，模拟器需要）',
    xcode === undefined ? '从 App Store 安装 Xcode 26+' : undefined)

  const devices = pymobiledevice3.installed ? await physicalDeviceCount() : 0
  add('physical', '已连接的真机', devices > 0,
    devices > 0 ? `${devices} 台（USB/Wi-Fi）` : '没有连接的真机（不影响模拟器）',
    devices > 0 ? undefined : '开发者模式 + 信任这台 Mac')

  if (options.probe === true && devices > 0) {
    const { preparePhysicalMirror } = await import('./ios_mirror.js')
    const mirror = await preparePhysicalMirror(logger, { timeoutMs: 6000, retryTimeoutMs: 8000 })
    add('mirror', '真机镜像', mirror.ok === true, mirror.ok === true ? '面板取帧正常' : (mirror.error ?? '取不到画面帧'))
  }

  return { ok: checks.every((check) => check.ok || check.id === 'physical' || check.id === 'xcode'), checks }
}

async function physicalDeviceCount() {
  try {
    const { stdout } = await execFileAsync(PYMOBILEDEVICE3, ['usbmux', 'list'], { timeout: 20_000, maxBuffer: 8 << 20 })
    const records = JSON.parse(stdout)
    return Array.isArray(records) ? records.filter((record) => record && (record.DeviceClass === 'iPhone' || record.DeviceClass === 'iPad')).length : 0
  } catch {
    return 0
  }
}
