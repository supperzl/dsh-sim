#!/usr/bin/env node
/**
 * Localize the bundled device runtime for the Chinese build.
 *
 * The panel ships as a prebuilt HTML bundle; this applies our translation map
 * (quoted UI literals only), swaps the location presets for Chinese cities and
 * relaxes the panel CSP so the sidebar can embed it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'vendor', 'runtime', 'dist')
const mapping = JSON.parse(readFileSync(join(root, 'locale', 'runtime-zh.json'), 'utf8'))

const CITIES = '[{value:"beijing",city:"北京",label:"北京",latitude:39.9042,longitude:116.4074},{value:"shanghai",city:"上海",label:"上海",latitude:31.2304,longitude:121.4737},{value:"guangzhou",city:"广州",label:"广州",latitude:23.1291,longitude:113.2644},{value:"shenzhen",city:"深圳",label:"深圳",latitude:22.5431,longitude:114.0579},{value:"hangzhou",city:"杭州",label:"杭州",latitude:30.2741,longitude:120.1551},{value:"chengdu",city:"成都",label:"成都",latitude:30.5728,longitude:104.0668},{value:"wuhan",city:"武汉",label:"武汉",latitude:30.5928,longitude:114.3055},{value:"xian",city:"西安",label:"西安",latitude:34.3416,longitude:108.9398}]'

let total = 0
for (const name of ['app.html', 'browser-panel.html']) {
  const path = join(dist, name)
  if (!existsSync(path)) continue
  let text = readFileSync(path, 'utf8')
  let replaced = 0
  for (const [en, zh] of Object.entries(mapping)) {
    if (typeof en !== 'string' || typeof zh !== 'string' || en === zh || en.length < 2 || en.includes('\n')) continue
    for (const quote of ['"', "'"]) {
      const token = quote + en + quote
      if (text.includes(token)) {
        replaced += text.split(token).length - 1
        text = text.split(token).join(quote + zh + quote)
      }
    }
  }
  if (name === 'app.html') {
    const start = text.indexOf('{value:"cupertino",city:')
    if (start >= 0) {
      const end = text.indexOf('],Tvt=', start)
      if (end > start) text = text.slice(0, start) + CITIES + text.slice(end + 1)
    }
  }
  writeFileSync(path, text)
  total += replaced
  console.log(`${name}: ${replaced} strings translated`)
}

const server = join(dist, 'server.mjs')
if (existsSync(server)) {
  const text = readFileSync(server, 'utf8')
  if (text.includes("frame-ancestors 'none'")) {
    writeFileSync(server, text.replace("\"content-security-policy\": \"frame-ancestors 'none'; base-uri 'none'\"", "\"content-security-policy\": \"base-uri 'none'\""))
    console.log('server.mjs: panel framing allowed')
  }
}
console.log(`done, ${total} replacements`)
