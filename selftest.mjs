#!/usr/bin/env node
// ============================================================================
// dshw-desktop-overlay —— 离线渲染自检
// ============================================================================
// 不需要重启 DSH：直接用**已部署到插件里**的 overlay.mjs + overlay-shell，
// 配一张 mock 路由表（真实资源文件 + 形状合理的 JSON），
// 拉起真实悬浮窗 → 渲染 8 秒 → capturePage 截图落盘 → 自动退出。
//
//   node selftest.mjs
//
// 产物：./_selftest/overlay-shot.png（截图）、./_selftest/run/overlay.log（壳日志）
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---- 定位已安装的插件 ----
function candidateHomes() {
  const out = []
  if (process.env.DSH_HOME) out.push(process.env.DSH_HOME)
  out.push(path.join(os.homedir(), '.dsh'))
  for (const d of ['C', 'D', 'E', 'F']) {
    out.push(`${d}:\\DeepSeek Harness Data\\home`)
    out.push(`${d}:\\AI\\DeepSeek Harness Data\\home`)
  }
  return [...new Set(out.filter(Boolean))]
}
function findPlugin() {
  for (const home of candidateHomes()) {
    for (const profile of ['desktop', 'web']) {
      const p = path.join(home, 'profiles', profile, 'node_modules', 'dsh-whale-widget')
      if (fs.existsSync(path.join(p, 'lib', 'index.js'))) return { pluginDir: p, dshHome: home }
    }
  }
  return null
}

const found = findPlugin()
if (!found) { console.error('✗ 找不到 dsh-whale-widget'); process.exit(1) }
const { pluginDir, dshHome } = found

const LIB = path.join(pluginDir, 'lib')
const OVERLAY_MJS = path.join(LIB, 'desktop-overlay.mjs')
if (!fs.existsSync(OVERLAY_MJS)) {
  console.error('✗ 还没安装：' + OVERLAY_MJS + '\n  先跑 node install.mjs')
  process.exit(1)
}
if (!fs.existsSync(path.join(LIB, 'overlay-shell', 'main.js'))) {
  console.error('✗ 还没安装：overlay-shell/main.js\n  先跑 node install.mjs')
  process.exit(1)
}

const ASSETS = path.join(pluginDir, 'assets')
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' } }
const pick = (...names) => {
  for (const n of names) { const p = path.join(ASSETS, n); if (fs.existsSync(p)) return p }
  return ''
}

// ---- 临时运行时目录 ----
// 放在 $DSH_HOME 下面（和 DSH 同一卷）→ 私有 Electron 运行时走硬链接，不占额外磁盘；
// 截图仍然落回工作区，方便直接看。
const TMP = path.join(dshHome, 'whale-desktop-overlay', '_selftest')
const SHOT_DIR = path.join(HERE, '_selftest')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'run'), { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  enabled: true,
  autoStart: true,
  port: 37917,
  bounds: 'screen',
  alwaysOnTop: true,
  clickThrough: true,
  inputMode: 'hot',         // 验证新的小热点窗输入通路
  hotPadding: 14,
  quitWhenHostExits: false, // 自检时别被心跳踢掉
  tray: false,              // 自检时别留托盘图标
  disableGpu: false,        // 故意从 false 起，顺便验证 GPU 崩溃→软件合成的自动回退
  electronExe: 'auto',
}, null, 2))

const SHOT = path.join(SHOT_DIR, 'overlay-shot.png')
// ⚠️ 必须先删掉上一轮的截图：否则下面的等待循环会立刻以为「已完成」，
//    在壳刚起来 1 秒时就把它关掉（截图、DOM 探针、输入自检全都来不及跑）。
try { fs.rmSync(SHOT, { force: true }) } catch (err) {}
const STARTED_AT = Date.now()
process.env.DSHW_OVERLAY_RUNTIME = TMP
process.env.DSHW_OVERLAY_CAPTURE = SHOT
process.env.DSHW_OVERLAY_CAPTURE_DELAY = '9000'
// 让壳在截图前先在热点窗里造一次「按下 → 拖动 → 抬起」，
// 用来验证 热点窗 → IPC → sendInputEvent → 主窗 这条合成输入链路真的通。
process.env.DSHW_HOT_SELFTEST = '1'

// ---- mock 路由表（真实资源 + 形状合理的 JSON）----
const widgetJs = readText(path.join(ASSETS, 'whale-widget.js'))
if (!widgetJs) { console.error('✗ 读不到 assets/whale-widget.js'); process.exit(1) }
const whalePng = pick('DSniang1.png', 'DSniang02.png', 'DSH2.png')
const gifPng = pick('rua.gif', 'bubble-petpet.gif')

function sendJs(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}
function sendFile(res, file, ct) {
  try {
    const b = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', 'Content-Length': String(b.length) })
    res.end(b)
  } catch (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('mock: no file') }
}
function sendJson(res, obj) {
  const b = JSON.stringify(obj)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(b)
}

const nowSec = Math.floor(Date.now() / 1000)
const mockBalance = {
  ok: true,
  currency: 'CNY',
  totalBalance: 123.4567,
  grantedBalance: 100,
  toppedUpBalance: 23.4567,
  isAvailable: true,
  accountTag: 'selftest',
  version: '0.3.18',
  isPeak: false,
  peakNextChangeAt: nowSec + 3600,
  peakHolidays: [],
  todayUsage: 1.2345,
  todayUsageCurrency: 'CNY',
  usageSource: 'ledger',
  usageLabel: '今日已用',
  usageMode: 'ledger',
  accounting: { today: { amount: 1.2345, currency: 'CNY' } },
}

const routes = [
  { kind: 'exact', path: '/dsh-whale/widget.js', handler: (req, res) => sendJs(res, widgetJs) },
  { kind: 'exact', path: '/dsh-whale/balance.json', handler: (req, res) => sendJson(res, mockBalance) },
  { kind: 'exact', path: '/dsh-whale/image.png', handler: (req, res) => whalePng ? sendFile(res, whalePng, 'image/png') : sendJson(res, {}) },
  { kind: 'exact', path: '/dsh-whale/role-image.png', handler: (req, res) => whalePng ? sendFile(res, whalePng, 'image/png') : sendJson(res, {}) },
  { kind: 'exact', path: '/dsh-whale/rua.gif', handler: (req, res) => gifPng ? sendFile(res, gifPng, 'image/gif') : sendJson(res, {}) },
  { kind: 'exact', path: '/dsh-whale/last-turn.json', handler: (req, res) => sendJson(res, { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }) },
  { kind: 'exact', path: '/dsh-whale/size.json', handler: (req, res) => sendJson(res, { ok: true, scale: 1 }) },
  { kind: 'exact', path: '/dsh-whale/roles.json', handler: (req, res) => sendJson(res, { ok: true, roles: [], pinned: null }) },
  { kind: 'exact', path: '/dsh-whale/bubble.json', handler: (req, res) => sendJson(res, { ok: true }) },
  { kind: 'exact', path: '/dsh-whale/audio.json', handler: (req, res) => sendJson(res, { ok: true }) },
  { kind: 'exact', path: '/dsh-whale/usage-settings.json', handler: (req, res) => sendJson(res, { ok: true }) },
  { kind: 'exact', path: '/dsh-whale/usage-records.json', handler: (req, res) => sendJson(res, { ok: true, records: [] }) },
  { kind: 'exact', path: '/dsh-whale/api-models.json', handler: (req, res) => sendJson(res, { ok: true, models: [] }) },
  { kind: 'exact', path: '/dsh-whale/balance-adjustments.json', handler: (req, res) => sendJson(res, { ok: true }) },
  { kind: 'exact', path: '/dsh-whale/bubble-imgs.json', handler: (req, res) => sendJson(res, { ok: true, images: [] }) },
  { kind: 'exact', path: '/dsh-whale/bubble-img.png', handler: (req, res) => gifPng ? sendFile(res, gifPng, 'image/gif') : sendJson(res, {}) },
  { kind: 'exact', path: '/dsh-whale/wait.json', handler: (req, res) => sendJson(res, { ok: true }) },
]

console.log('插件目录  :', pluginDir)
console.log('自检目录  :', TMP)
console.log('截图目标  :', SHOT)
console.log('路由条数  :', routes.length, '(mock)')
console.log('')

const mod = await import(pathToFileURL(OVERLAY_MJS).href)
const started = await mod.startWhaleDesktopOverlay({
  routes,
  packageRoot: pluginDir,
  dshHome,
  runtimeDir: TMP,
  logger: console,
})
console.log('启动结果  :', JSON.stringify(started))

// ---- 等截图落盘 ----
const deadline = Date.now() + 60000
const shotReady = () => {
  try {
    const st = fs.statSync(SHOT)
    return st.size > 0 && st.mtimeMs >= STARTED_AT
  } catch (err) { return false }
}
while (Date.now() < deadline) {
  if (shotReady()) break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 1200))

const logPath = path.join(TMP, 'run', 'overlay.log')
console.log('')
console.log('──── overlay.log ────')
try { console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-60).join('\n')) } catch (err) {}

console.log('')
console.log('──── shell.log ────')
try { console.log(fs.readFileSync(path.join(TMP, 'run', 'shell.log'), 'utf8').split('\n').slice(-50).join('\n')) } catch (err) { console.log('(无)') }

console.log('')
console.log('──── shell-status.json ────')
try { console.log(fs.readFileSync(path.join(TMP, 'run', 'shell-status.json'), 'utf8')) } catch (err) { console.log('(无)') }

if (shotReady()) {
  const st = fs.statSync(SHOT)
  console.log('')
  console.log(`✓ 截图已生成：${SHOT}  ${st.size} bytes`)
} else {
  console.log('')
  console.log('✗ 没有生成截图 —— 看上面的日志定位')
}

// ---- 输入通路体检 ----
console.log('')
console.log('──── 输入通路体检 ────')
let status = {}
try { status = JSON.parse(fs.readFileSync(path.join(TMP, 'run', 'shell-status.json'), 'utf8')) } catch (err) { status = {} }
const checks = [
  ['热点窗已定位到鲸鱼', !!status.hotBounds, JSON.stringify(status.hotBounds || null)],
  ['热点窗收到事件', Number(status.hotEvents || 0) > 0, 'hotEvents=' + (status.hotEvents || 0)],
  ['已合成进主窗', Number(status.injected || 0) > 0, 'injected=' + (status.injected || 0)],
  ['按下时主窗未被激活', status.hotFocusedAfterDown === false, 'focusedAfterDown=' + String(status.hotFocusedAfterDown)],
  ['拖动真的生效（看松开前的位置）', status.dragWorked === true,
    `${JSON.stringify(status.before || null)} → 拖动中 ${JSON.stringify(status.midDrag || null)} → 松开后 ${JSON.stringify(status.after || null)}`],
]
let bad = 0
for (const [name, ok, detail] of checks) {
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${name}  ${detail}`)
}
if (bad) {
  console.log('')
  console.log('✗ 有 ' + bad + ' 项未通过 —— 详见 run/shell.log 里的「转发 …」与「热点窗自检」两行')
}

mod.stopWhaleDesktopOverlay()
await new Promise((r) => setTimeout(r, 400))
process.exit(shotReady() && !bad ? 0 : 2)
