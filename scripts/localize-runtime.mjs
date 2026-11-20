#!/usr/bin/env node
/**
 * Patch the vendored device runtime for the Chinese DSH build.
 *
 * Editing the prebuilt app's literals or injecting code into its startup path
 * changes runtime behavior and leaves the panel blank. The shell therefore
 * translates rendered nodes in small batches after startup has completed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaultDist = join(root, 'vendor', 'runtime', 'dist')
const mapping = JSON.parse(readFileSync(join(root, 'locale', 'runtime-zh.json'), 'utf8'))

const CITIES = '{value:"beijing",city:"北京",label:"北京",latitude:39.9042,longitude:116.4074},{value:"shanghai",city:"上海",label:"上海",latitude:31.2304,longitude:121.4737},{value:"guangzhou",city:"广州",label:"广州",latitude:23.1291,longitude:113.2644},{value:"shenzhen",city:"深圳",label:"深圳",latitude:22.5431,longitude:114.0579},{value:"hangzhou",city:"杭州",label:"杭州",latitude:30.2741,longitude:120.1551},{value:"chengdu",city:"成都",label:"成都",latitude:30.5728,longitude:104.0668},{value:"wuhan",city:"武汉",label:"武汉",latitude:30.5928,longitude:114.3055},{value:"xian",city:"西安",label:"西安",latitude:34.3416,longitude:108.9398}'
const I18N_START = '/* dsh-sim-i18n:start */'
const I18N_END = '/* dsh-sim-i18n:end */'
const LEGACY_I18N_START = '<script>(function(){var lang="zh";var dict='
const APP_I18N_START = '<!-- dsh-sim-i18n:start -->'
const APP_I18N_END = '<!-- dsh-sim-i18n:end -->'
const SHELL_INSERT = 'await a.sendToolResult(Dt)'

function translatorScript() {
  const translations = Object.fromEntries(Object.entries(mapping).map(([en, zh]) => [en, zh.replaceAll('Mobile Dev', '模拟器')]))
  translations['Mobile Dev'] = '模拟器'
  const json = JSON.stringify(translations).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return `${I18N_START}const doc=I.contentDocument,view=doc?.defaultView;if(doc&&view){const translations=${json},attributes=['title','aria-label','placeholder','alt'],queue=[],excluded='code, pre, textarea, [contenteditable="true"]';let scheduled=!1;const translate=value=>{const match=/^(\\s*)(.*?)(\\s*)$/s.exec(value),original=match[2],translated=translations[original]??original.replaceAll('Mobile Dev','模拟器');return translated===original?value:match[1]+translated+match[3]};const translateNode=node=>{if(node.nodeType===view.Node.TEXT_NODE){if(node.parentElement&&!node.parentElement.closest(excluded))node.nodeValue=translate(node.nodeValue);return}if(node.nodeType!==view.Node.ELEMENT_NODE||node.matches('script,style'))return;if(!node.closest(excluded))for(const name of attributes)if(node.hasAttribute(name))node.setAttribute(name,translate(node.getAttribute(name)))};const add=node=>{queue.push(node);if(node.nodeType===view.Node.ELEMENT_NODE)for(const child of node.childNodes)add(child)};const run=deadline=>{scheduled=!1;let count=0;while(queue.length&&count++<120&&(deadline?.timeRemaining?.()??8)>2)translateNode(queue.shift());if(queue.length)schedule()};const schedule=()=>{if(scheduled)return;scheduled=!0;(view.requestIdleCallback??(callback=>view.setTimeout(()=>callback({timeRemaining:()=>8}),16)))(run)};add(doc.body);new view.MutationObserver(records=>{for(const record of records){if(record.type==='characterData')queue.push(record.target);else if(record.type==='attributes')queue.push(record.target);else for(const node of record.addedNodes)add(node)}schedule()}).observe(doc.body,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:attributes});schedule()}${I18N_END}`
}
function stripAppLocalization(text) {
  const legacyStart = text.indexOf(LEGACY_I18N_START)
  if (legacyStart >= 0) {
    const legacyEnd = text.indexOf('</script>', legacyStart)
    if (legacyEnd < 0) throw new Error('legacy dsh-sim localization script is incomplete')
    text = text.slice(0, legacyStart) + text.slice(legacyEnd + '</script>'.length)
  }
  const start = text.indexOf(APP_I18N_START)
  if (start >= 0) {
    const end = text.indexOf(APP_I18N_END, start)
    if (end < 0) throw new Error('legacy app localization marker is incomplete')
    text = text.slice(0, start) + text.slice(end + APP_I18N_END.length)
  }
  return text
}

function stripShellLocalization(text) {
  const start = text.indexOf(I18N_START)
  if (start < 0) return text
  const end = text.indexOf(I18N_END, start)
  if (end < 0) throw new Error('dsh-sim localization marker is incomplete')
  return text.slice(0, start) + text.slice(end + I18N_END.length)
}

function patchApp(path) {
  let text = stripAppLocalization(readFileSync(path, 'utf8'))
  const start = text.indexOf('{value:"cupertino",city:')
  const end = start < 0 ? -1 : text.indexOf('],Tvt=', start)
  if (start >= 0 && end >= 0) text = text.slice(0, start) + CITIES + text.slice(end)
  else if (!text.includes('value:"beijing",city:"北京"')) throw new Error('runtime location preset shape changed')
  text = text.replace('<title>Mobile Dev</title>', '<title>模拟器</title>')
  writeFileSync(path, text)
}

function patchShell(path) {
  let text = stripShellLocalization(readFileSync(path, 'utf8'))
  if (!text.includes(SHELL_INSERT)) throw new Error('runtime panel startup shape changed')
  text = text.replace(SHELL_INSERT, `${SHELL_INSERT};setTimeout(()=>{${translatorScript()}},500)`)
  text = text.replace('locale:navigator.language', 'locale:"zh-CN"')
  text = text.replace('I.title="Mobile Dev"', 'I.title="模拟器"')
  text = text.replace('<title>Mobile Dev</title>', '<title>模拟器</title>')
  writeFileSync(path, text)
}

export function localizeRuntime(dist = defaultDist) {
  const app = join(dist, 'app.html')
  const shell = join(dist, 'browser-panel.html')
  if (!existsSync(app) || !existsSync(shell)) throw new Error(`runtime panel is incomplete in ${dist}`)
  patchApp(app)
  patchShell(shell)
  console.log('runtime panel: framing, title, Chinese locations and deferred translation patched')

  const server = join(dist, 'server.mjs')
  if (!existsSync(server)) throw new Error(`runtime server is missing ${server}`)
  let text = readFileSync(server, 'utf8')
  const guardFrom = 'const session = this.session(id3);\n    if (session.generation !== generation) throw new ExpectedOperationError("device_unavailable", "Wait for a fresh physical iOS screen before sending input.");'
  const guardTo = 'const session = this.session(id3);\n    if (session.generation !== generation) {\n      const deadline = Date.now() + 2000;\n      while (session.generation === generation && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));\n    }'
  if (text.includes(guardFrom)) text = text.replace(guardFrom, guardTo)
  if (text.includes("frame-ancestors 'none'")) text = text.replace("\"content-security-policy\": \"frame-ancestors 'none'; base-uri 'none'\"", "\"content-security-policy\": \"base-uri 'none'\"")
  writeFileSync(server, text)
  console.log('server.mjs: framing and physical iOS input patched')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) localizeRuntime()
