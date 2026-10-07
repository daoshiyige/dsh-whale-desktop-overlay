// ============================================================================
// dshw-desktop-overlay —— 让已安装的 dsh-whale-widget 悬浮在 Windows 桌面
// ============================================================================
// 运行位置：由 dsh-whale-widget 被补丁后的 lib/index.js 动态 import（见 patch-C）。
//
// 它做三件事：
//   ① 在本机回环地址上另起一个小 HTTP 服务，把插件**已经注册好**的 /dsh-whale/*
//      原始处理器原样再挂一遍（补丁 B 收集到的 inner，未经信任栅栏包装）；
//   ② 返回一个极小的透明 HTML 页，里面只引 /dsh-whale/widget.js —— 前端一行不改；
//   ③ 用宿主自带的 Electron（process.execPath，即 DeepSeek Harness.exe）拉起一个
//      全屏 / 透明 / 无边框 / 置顶 / 不占任务栏 的窗口去加载 ② 的页面。
//
// 为什么不直接复用宿主那个端口（3791/3792）：
//   宿主 webserver 的 401 来自 connection.requestRejection（浏览器会话栅栏，要 bearer）。
//   那层栅栏与插件逻辑无关，且明确写着「本服务的路由由 route owner 自行实施请求策略」。
//   我们直接调用**原始 handler**，自己实施一套更严的策略：
//     · 只绑 127.0.0.1，永不监听 0.0.0.0
//     · 每个进程一份随机令牌，页面用 ?t= 换取 HttpOnly 同站 Cookie
//     · Host 必须是回环字面量；Origin 必须同回环；Sec-Fetch-Site: cross-site 一律拒
//   也就是说：能访问它的只有本机、且拿到令牌的那个窗口。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SHELL_DIR = path.join(MODULE_DIR, 'overlay-shell')
// 壳应用 = 主窗 + 主窗 preload + 热点窗 + 热点窗 preload
const SHELL_APP_FILES = ['main.js', 'preload.js', 'hot.html', 'hot-preload.js', 'package.json']

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: true,
  // 插件加载时自动拉起悬浮窗
  autoStart: true,
  // 本体服务端口（占用时自动 +1 重试）
  port: 37917,
  portScan: 12,
  // 'workArea' = 只铺工作区（避开任务栏，推荐：Windows 对无边框窗口本来就会裁到工作区）；
  // 'screen'   = 请求整块屏幕（多数情况下会被 Windows 裁回工作区，能压住任务栏）
  bounds: 'workArea',
  alwaysOnTop: true,
  clickThrough: true,
  // 鼠标怎么交给悬浮窗 —— 直接决定「点鲸鱼会不会把正在播放的视频点黑」：
  //   'hot'    （默认）全屏窗永久穿透、永不改样式、永不激活；另起一个几百像素的
  //            透明「热点窗」贴合鲸鱼、只接鼠标，再合成进主窗。
  //            浏览器不会被判为「被完全遮挡」→ 视频不受影响。
  //   'window' 旧行为：全屏窗自己做命中测试，压到鲸鱼时临时关掉穿透。
  //            实现简单，但那一下会让浏览器判自己完全被遮 → 压着鲸鱼时视频黑屏。
  inputMode: 'hot',
  // 热点窗相对鲸鱼包围盒外扩多少（px）；留点余量给气泡/菜单
  hotPadding: 14,
  // 启动后自动「重新加载挂件」一次。
  // 实测：**首次**加载时并集会出现一次瞬时误判（全视口），手动重载一次即恢复。
  // 这是挂件首启初始化的一串 DOM 中间态与 preload 200ms 采样撞车所致，
  // 重载后 DOM 生命周期更紧凑就复现不了。与其追时序，不如把「用户手动重载」
  // 这个已验证有效的操作自动化。置 false 可关掉。
  autoReloadOnStart: true,
  // 自动重载的延时（ms）。
  // 1500ms 实测太长 —— 用户能看出挂件「闪一下」，所以压到 300ms。
  // 重载时机由 did-finish-load 保证（页面已 load 完），300ms 时仍在跑的
  // 初始化会被直接中断重建，比等它跑完再重载更干净。
  autoReloadDelayMs: 300,
  // 是否关掉 DSH 页面里的那只鲸鱼（注入通道由补丁 D/E 短路）。
  // 悬浮窗已经在桌面独立显示时，页内那只就成了重复的第二只 → 默认关掉。
  hideInAppWidget: true,
  // 宿主退出后悬浮窗是否自动关闭（靠 /__health 心跳实现）
  quitWhenHostExits: true,
  // 悬浮层内是否显示托盘图标（用于退出/重载/隐藏）
  tray: true,
  // 某些显卡驱动下全屏透明窗口会闪，置 true 可退到软件合成
  disableGpu: false,
  // 'auto' 或 Electron 可执行文件的绝对路径
  electronExe: 'auto',
  // 打开时预置的角色 id（空 = 沿用该 origin 自己记住的）
  role: '',
  // 透传给渲染进程的额外查询串
  extraQuery: '',
}

function runtimeDir(dshHome) {
  return process.env.DSHW_OVERLAY_RUNTIME
    || path.join(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'whale-desktop-overlay')
}
function runDir(base) { return path.join(base, 'run') }
function logFile(base) { return path.join(runDir(base), 'overlay.log') }

function ensureDirs(base) {
  for (const d of [base, runDir(base)]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (err) {}
  }
}
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (err) { return dflt }
}
function writeJson(p, value) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value, null, 2), 'utf8') } catch (err) {}
}

let logStream = null
function makeLogger(base, tag) {
  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] [dshw-overlay] ${msg}\n`
    try {
      if (!logStream) {
        fs.mkdirSync(runDir(base), { recursive: true })
        logStream = fs.createWriteStream(logFile(base), { flags: 'a' })
      }
      logStream.write(line)
    } catch (err) {}
    try { (level === 'ERROR' ? console.warn : console.log)(String(line).trimEnd()) } catch (err) {}
  }
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    tag,
  }
}

// ---------------------------------------------------------------------------
// 单例状态
// ---------------------------------------------------------------------------
let state = null

// ---------------------------------------------------------------------------
// 请求校验（自实施策略，不委托宿主栅栏）
// ---------------------------------------------------------------------------
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function cookieToken(header) {
  try {
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      if (part.slice(0, i).trim() === 'dshw_overlay') return decodeURIComponent(part.slice(i + 1).trim())
    }
  } catch (err) {}
  return ''
}

// 通过 → null；否则返回应拒绝的状态码
function guard(req, url, token) {
  const h = (req && req.headers) || {}
  let host
  try { host = new URL('http://' + String(h.host || '')) } catch (err) { return 403 }
  if (!isLoopbackHostname(host.hostname)) return 403
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = h.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let ou
    try { ou = new URL(origin) } catch (err) { return 403 }
    if (!isLoopbackHostname(ou.hostname)) return 403
    if (ou.port !== String(host.port || '')) return 403
  }
  const presented = url.searchParams.get('t') || h['x-dshw-overlay-token'] || cookieToken(h.cookie)
  if (!presented || presented !== token) return 401
  return null
}

// ---------------------------------------------------------------------------
// 页面：只做透明化 + 最小宿主 shim + 引挂件本体
// ---------------------------------------------------------------------------
// 前端 whale-widget.js 开头有一段「页面自检」：只有在**主聊天界面**才挂载，
// 判据是 document.getElementById('root') 里能找到 composer 标记，
// 其中 [data-composer-input] 是最精确的那个（2026-09 版 DSH 前端实测只出现在对话组件里）。
// 自动挂载会插到插件市场等 SPA 页面上搞坏 React 树，所以这个闸门不能删。
//
// 于是这里给一个**不可见的 composer shim** —— 就这三层 div，
// 让那 738KB 前端认为自己在主聊天界面里。除此之外它对宿主零依赖：
// 没有 window.parent / window.top / __DSH 引用，所有数据都走同源 /dsh-whale/*。
function buildPageHtml(cfg) {
  const seedRole = cfg.role ? String(cfg.role).replace(/[^A-Za-z0-9._:-]/g, '') : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DS Whale Desktop Overlay</title>
<style>
  html,body{margin:0!important;padding:0!important;background:transparent!important;
    overflow:hidden!important;width:100%;height:100%;}
  html{scrollbar-width:none;}
  ::-webkit-scrollbar{width:0!important;height:0!important;display:none;}
  /* 兜底：万一有别的样式给 body 上色，压成透明 */
  body{background-color:transparent!important;}
  /* 宿主 shim：必须在 DOM 里、但绝不能画出任何像素、也绝不能接指针事件 */
  #dshw-overlay-host{position:fixed!important;left:-100000px!important;top:-100000px!important;
    width:1px!important;height:1px!important;overflow:hidden!important;
    opacity:0!important;pointer-events:none!important;visibility:hidden!important;}
</style>
</head>
<body>
<script>
/* 悬浮层是独立 origin，localStorage 与 DSH 页面不共享。
   这里只在配置显式指定 role 时预置一次，其余设置仍走 /dsh-whale/* 服务端配置。 */
try{var __q=new URLSearchParams(location.search);var __r=${JSON.stringify(seedRole)};
if(__r){localStorage.setItem('dshw-role',__r);}}catch(e){}
</script>
<script>
/* ── 合成输入补丁（桌面悬浮层专用，必须在挂件脚本之前注册）────────────────────
   Electron 的 webContents.sendInputEvent 合成 mouseMove 时**带不上"左键仍按住"的位**：
   页面收到的 pointermove / mousemove 里 e.buttons 恒为 0（试过给事件塞 button/buttons
   字段，Electron 会忽略）。而 dsh-whale-widget 的移动处理里有这么一句：

       // 鼠标/触摸/笔拖动期间 e.buttons 都是 1，buttons===0 只可能意味着真的松手了
       if (!e.buttons) { endDrag(e, true); return }

   于是桌面上的拖动会变成：按下 → 开始拖（根元素挂上 dshwv-dragging）→ 第一个 move 到达
   → 被判定"已松手" → endDrag → 鲸鱼一动不动。也就是"按住鲸鱼拖不动"。

   这里在捕获阶段（注册时机早于挂件）把这一个字段补正：
   指针按下期间，凡是没有按键位的移动事件，就地覆写 buttons=1。
   挂件那 900KB 一行不用改，也不依赖它的任何内部实现。 */
(function () {
  var held = false
  function fixButtons(e) {
    if (!held || e.buttons) return
    try { Object.defineProperty(e, 'buttons', { value: 1, configurable: true }) } catch (err) {}
  }
  function onDown(e) { if (e.button === 0) held = true }
  function onUp() { held = false }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('mouseup', onUp, true)
  document.addEventListener('pointercancel', onUp, true)
  document.addEventListener('pointermove', fixButtons, true)
  document.addEventListener('mousemove', fixButtons, true)
})()
</script>
<div id="root" data-dshw-composer-shim="1" style="position:fixed;left:-100000px;top:-100000px;width:1px;height:1px;opacity:0;pointer-events:none">
  <div data-composer-seat style="all:inherit">
    <div data-composer-card style="all:inherit">
      <div data-composer-input role="textbox" aria-multiline="true" contenteditable="false" style="all:inherit"></div>
    </div>
  </div>
</div>
<script src="/dsh-whale/widget.js"></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 准备一个可用的 Electron 运行时
// ---------------------------------------------------------------------------
// ⚠️ 关键事实（实测）：**打包后的 Electron 会忽略 app 路径参数**。
//    `DeepSeek Harness.exe <某目录>` 在 app 模式下启动的永远是它自己内嵌的 resources/app.asar，
//    argv 里的目录根本不被采用（只有 ELECTRON_RUN_AS_NODE=1 时它才退化成 `node <脚本>`，
//    那正是它看起来"能跑我们的 main.js"的假象）。
//
// 所以要么用户自己指定一个**未打包**的 Electron（npm 的 electron 包），
// 要么我们**用硬链接拼一份私有分发**：把安装目录顶层那 20 个运行时文件 + locales/ 链过来
// （同一卷上硬链接不占空间、瞬时完成），再把 resources/ 换成我们自己的 app 目录。
// 这样完全离线，也不碰 DSH 安装目录里任何一个字节。
function linkOrCopy(src, dst) {
  try { fs.linkSync(src, dst); return 'link' } catch (err) {}
  fs.copyFileSync(src, dst)
  return 'copy'
}

function classifyElectron(exePath) {
  const dir = path.dirname(exePath)
  const res = path.join(dir, 'resources')
  let packaged = false
  let stock = false
  try { packaged = fs.existsSync(path.join(res, 'app.asar')) } catch (err) {}
  try { stock = !packaged && fs.existsSync(path.join(res, 'default_app.asar')) } catch (err) {}
  return { dir, res, packaged, stock }
}

function candidateElectronPaths(cfg, dshHome) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSHW_ELECTRON_EXE)
  if (cfg.electronExe && cfg.electronExe !== 'auto') push(cfg.electronExe)
  if (process.versions && process.versions.electron && process.execPath) push(process.execPath)

  const roots = []
  if (dshHome) {
    let cur = path.resolve(dshHome)
    for (let i = 0; i < 3; i++) { roots.push(path.dirname(cur)); cur = path.dirname(cur) }
  }
  const names = ['DeepSeek Harness', 'DeepSeekHarness', 'deepseek-harness', 'dsh-desktop']
  for (const r of roots) for (const n of names) push(path.join(r, n, 'DeepSeek Harness.exe'))
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    for (const n of names) {
      push(`${d}:\\AI\\${n}\\DeepSeek Harness.exe`)
      push(`${d}:\\Program Files\\${n}\\DeepSeek Harness.exe`)
      push(`${d}:\\Program Files (x86)\\${n}\\DeepSeek Harness.exe`)
    }
  }
  for (const n of names) push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', n, 'DeepSeek Harness.exe'))
  // 顺手看一眼有没有人装过 npm 版 electron（那个是未打包的，最好用）
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    push(`${d}:\\electron\\electron.exe`)
    push(`${d}:\\nodejs\\electron.exe`)
  }
  return out
}

function pickShellExe(dir) {
  // 安装目录里最大的那个非卸载类 exe 就是 Electron 主程序
  try {
    let best = ''
    let bestSize = 0
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.exe$/i.test(e.name)) continue
      if (/^uninstall/i.test(e.name) || /^elevate/i.test(e.name)) continue
      const size = fs.statSync(path.join(dir, e.name)).size
      if (size > bestSize) { bestSize = size; best = e.name }
    }
    return best
  } catch (err) { return '' }
}

// ⚠️ 只排除**名为 resources 的目录**，不能按前缀排 —— 顶层还有一个 resources.pak，
//    那是 Chromium 自己的资源包（HTML/CSS/JS 引擎资源都在里面），删了会让页面退化成纯文本、脚本不执行。
function skipRuntimeEntry(name, isDir) {
  if (/^Uninstall/i.test(name)) return true
  if (/^7zip-installer/i.test(name)) return true
  if (isDir && name.toLowerCase() === 'resources') return true
  return false
}

function buildPrivateRuntime(srcDir, runtimeDir, log) {
  const dst = path.join(runtimeDir, 'electron')
  const exeName = pickShellExe(srcDir)
  if (!exeName) { log.error('源目录里找不到 Electron 主程序：' + srcDir); return '' }

  // 已经建好且源没变 → 直接用（还要抽查几个必需文件，避免上次建残了被沿用）
  const REQUIRED = ['resources.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'chrome_100_percent.pak', 'locales']
  const marker = path.join(dst, '.dshw-runtime.json')
  const info = readJson(marker, null)
  const complete = REQUIRED.every((n) => { try { return fs.existsSync(path.join(dst, n)) } catch (err) { return false } })
  if (info && info.layout === 2 && info.srcDir === srcDir && info.exeName === exeName && complete && fs.existsSync(path.join(dst, exeName))) {
    if (ensureShellApp(dst, log)) return path.join(dst, exeName)
  }

  log.info('开始拼装私有 Electron 运行时（硬链接，不占额外空间）：' + dst)
  fs.mkdirSync(dst, { recursive: true })
  let linked = 0
  let copied = 0
  let failed = 0
  const walk = (rel) => {
    const from = rel ? path.join(srcDir, rel) : srcDir
    let entries
    try { entries = fs.readdirSync(from, { withFileTypes: true }) } catch (err) { return }
    for (const e of entries) {
      const relPath = rel ? path.join(rel, e.name) : e.name
      if (skipRuntimeEntry(e.name, e.isDirectory())) continue
      const to = path.join(dst, relPath)
      if (e.isDirectory()) {
        try { fs.mkdirSync(to, { recursive: true }) } catch (err) {}
        walk(relPath)
      } else if (e.isFile()) {
        if (fs.existsSync(to)) { linked++; continue }
        try {
          const how = linkOrCopy(path.join(from, e.name), to)
          if (how === 'link') linked++; else copied++
        } catch (err) { failed++; log.warn('链接失败 ' + relPath + '：' + String(err && err.code || err)) }
      }
    }
  }
  walk('')
  log.info(`运行时文件就绪：硬链接 ${linked}，复制 ${copied}，失败 ${failed}`)

  // 我们自己那几样（不链接原 resources）
  const resDir = path.join(dst, 'resources')
  fs.mkdirSync(resDir, { recursive: true })
  // 原 icon.png / tray.ico 拿来做托盘兜底
  for (const n of ['icon.png', 'tray.ico']) {
    const from = path.join(srcDir, 'resources', n)
    try { if (fs.existsSync(from)) linkOrCopy(from, path.join(resDir, n)) } catch (err) {}
  }
  writeJson(marker, { layout: 2, srcDir, exeName, electron: process.versions && process.versions.electron, at: new Date().toISOString() })
  if (!ensureShellApp(dst, log)) {
    try { fs.rmSync(marker, { force: true }) } catch (err) {}   // 别让残缺的运行时被下次沿用
    return ''
  }
  return path.join(dst, exeName)
}

// 把我们的壳放成 resources/app（内容变了才重写）。返回是否可用。
function ensureShellApp(dst, log) {
  const appDir = path.join(dst, 'resources', 'app')
  try { fs.mkdirSync(appDir, { recursive: true }) } catch (err) {}
  let ok = true
  for (const n of SHELL_APP_FILES) {
    const src = path.join(SHELL_DIR, n)
    const to = path.join(appDir, n)
    try {
      const a = fs.statSync(src)
      let same = false
      try { const b = fs.statSync(to); same = a.size === b.size && b.mtimeMs >= a.mtimeMs } catch (err) {}
      if (!same) { fs.copyFileSync(src, to); log.info('更新 resources/app/' + n) }
    } catch (err) {
      ok = false
      log.error('放不进 ' + n + '（源 ' + src + '）：' + String((err && err.message) || err))
    }
  }
  if (!ok) log.error('壳文件缺失，资源目录不完整 —— overlay.mjs 与 overlay-shell/ 必须在同一个目录里')
  return ok
}

function resolveElectron(cfg, dshHome, runtimeDir, log) {
  const cands = candidateElectronPaths(cfg, dshHome)
  let firstExisting = ''
  let fallbackDir = ''

  for (const c of cands) {
    try {
      if (!c || !fs.statSync(c).isFile()) continue
      if (!firstExisting) firstExisting = c
      const info = classifyElectron(c)
      if (info.stock) { log.info('使用未打包的 Electron：' + c); return c }
      if (info.packaged && !fallbackDir) fallbackDir = info.dir
    } catch (err) {}
  }

  if (fallbackDir) {
    log.info('只找到打包版 Electron（' + fallbackDir + '），按硬链接方式拼一份私有分发')
    const built = buildPrivateRuntime(fallbackDir, runtimeDir, log)
    if (built) { log.info('私有运行时就绪：' + built); return built }
    log.error('私有运行时拼装失败')
  }
  if (firstExisting) { log.warn('按候选顺序直接采用：' + firstExisting); return firstExisting }
  log.error('找不到可用的 Electron 运行时。可用环境变量 DSHW_ELECTRON_EXE 指定一个未打包的 electron.exe。\n已试过：\n  ' + cands.slice(0, 12).join('\n  '))
  return ''
}

// ---------------------------------------------------------------------------
// 起服务
// ---------------------------------------------------------------------------
function listen(server, port, tries) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryOnce = () => {
      const p = port + attempt
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE' && attempt < tries) { attempt++; setImmediate(tryOnce); return }
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => { server.removeListener('error', onError); resolve(p) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, '127.0.0.1')
    }
    tryOnce()
  })
}

function respondJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)) })
    res.end(body)
  } catch (err) {}
}

// ---------------------------------------------------------------------------
// 拉起 / 关闭薄壳
// ---------------------------------------------------------------------------
function spawnShell(st, log, override) {
  const { base, port, token } = st
  const cfg = { ...st.cfg, ...(override || {}) }
  if (st.child && !st.child.killed && st.child.exitCode === null) return st.child
  const exe = st.exe
  if (!exe) return null

  const url = `http://127.0.0.1:${port}/?t=${token}${cfg.extraQuery ? '&' + String(cfg.extraQuery).replace(/^[?&]/, '') : ''}`
  const env = { ...process.env }
  // 宿主是在 Electron 的 node 语义下跑的：这两个变量会让子进程也退化成 node，必须摘掉
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.ELECTRON_ENABLE_LOGGING
  Object.assign(env, {
    DSHW_OVERLAY_PORT: String(port),
    DSHW_OVERLAY_TOKEN: token,
    DSHW_OVERLAY_URL: url,
    DSHW_OVERLAY_DIR: base,
    DSHW_OVERLAY_RUNTIME: base,
    DSHW_OVERLAY_CONFIG: JSON.stringify(cfg),
    DSHW_OVERLAY_ICON: (() => {
      try {
        const p = path.join(st.packageRoot || '', 'assets', 'DSniang1.png')
        return fs.existsSync(p) ? p : ''
      } catch (err) { return '' }
    })(),
  })

  log.info(`拉起悬浮窗壳进程：${exe}（端口 ${port}${cfg.disableGpu ? '，软件合成' : ''}）`)
  let child
  try {
    child = spawn(exe, [SHELL_DIR], {
      cwd: SHELL_DIR,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    log.error('拉起失败：' + String((err && err.message) || err))
    return null
  }
  const pipe = (stream, level) => {
    if (!stream) return
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line && !/GPU process exited unexpectedly/.test(line)) log.info(`[shell/${level}] ${line}`)
      }
      if (buf.length > 8192) buf = ''
    })
    stream.on('error', () => {})
  }
  pipe(child.stdout, 'out')
  pipe(child.stderr, 'err')

  child.on('error', (err) => { log.error('壳进程错误：' + String((err && err.message) || err)) })
  child.on('exit', (code, signal) => {
    log.info(`悬浮窗壳进程退出 code=${code} signal=${signal}`)
    if (st.child === child) st.child = null
    if (!state) return // 已经主动停掉了，别复活

    const status = readJson(path.join(runDir(base), 'shell-status.json'), null) || {}
    const gpuCrashes = Number(status.gpuCrashes || 0)
    const gpuFatal = gpuCrashes >= 3
    const SOFTWARE = { disableGpu: true }
    const quitBySelf = status.stage === 'quitting'   // 托盘退出 / 心跳失联，是主动退出

    // ① GPU 进程反复崩溃 → 换软件合成重试一次
    if (gpuFatal && !cfg.disableGpu && !st.gpuRetried) {
      st.gpuRetried = true
      log.warn(`GPU 进程崩溃 ${gpuCrashes} 次（驱动/环境问题，与插件无关）。改用软件合成重试一次。`)
      setTimeout(() => { if (state === st) spawnShell(st, log, SOFTWARE) }, 800)
      return
    }
    if (gpuFatal && cfg.disableGpu) log.error('软件合成模式下 GPU 仍在崩溃，放弃拉起悬浮窗')

    // ② 非主动退出（崩溃）→ 有限次自愈，桌宠要能自己站起来
    if (!quitBySelf && code !== 0 && (st.crashRestarts || 0) < 3) {
      st.crashRestarts = (st.crashRestarts || 0) + 1
      log.warn(`悬浮窗异常退出（code=${code}），第 ${st.crashRestarts}/3 次自动重启`)
      setTimeout(() => { if (state === st) spawnShell(st, log, cfg.disableGpu ? SOFTWARE : undefined) }, 3000)
      return
    }

    // ③ 软件合成跑稳了 → 把这台机器的结论记进 config.json，下次直接用
    if (cfg.disableGpu && !gpuFatal && Date.now() - st.spawnedAt > 20000) {
      st.cfg.disableGpu = true
      writeJson(path.join(base, 'config.json'), st.cfg)
      log.info('软件合成模式稳定，已把 disableGpu=true 写入 config.json')
    }
  })

  st.child = child
  st.spawnedAt = Date.now()
  writeJson(path.join(runDir(base), 'shell.json'), { pid: child.pid, port, disableGpu: !!cfg.disableGpu, startedAt: new Date().toISOString() })
  return child
}

// 延迟关闭：DSH 热重载插件时是「先 dispose 旧的、再 apply 新的」，
// 若这里同步关掉，紧接着的重启会白闪一下；而如果顺序相反，同步关掉就会把刚起来的窗口杀掉。
// 所以统一延迟，并在 start 时撤销 —— 两种顺序都安全。
let stopTimer = null

function doStop() {
  if (!state) return { ok: true, alreadyStopped: true }
  const st = state
  state = null
  try {
    if (st.child && st.child.exitCode === null) {
      st.log.info('关闭悬浮窗壳进程')
      try { st.child.kill() } catch (err) {}
    }
  } catch (err) {}
  try { if (st.server) st.server.close() } catch (err) {}
  try { if (logStream) { logStream.end(); logStream = null } } catch (err) {}
  return { ok: true }
}

export function stopWhaleDesktopOverlay() {
  if (stopTimer) clearTimeout(stopTimer)
  stopTimer = setTimeout(() => { stopTimer = null; doStop() }, 1500)
  // 宿主进程若此刻就死了，定时器不会跑 —— 但壳那边有心跳（/__health）兜底，不会留孤儿窗口
  try { if (stopTimer.unref) stopTimer.unref() } catch (err) {}
  return { ok: true, deferred: true }
}

// ---------------------------------------------------------------------------
// 主入口：由补丁后的 index.js 调用
// ---------------------------------------------------------------------------
export async function startWhaleDesktopOverlay(opts) {
  const { routes = [], packageRoot, dshHome, logger } = opts || {}

  // 撤销可能还挂着的延迟关闭
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }

  if (state) {
    // 热重载：只换路由表，不再起第二个进程
    state.routes = routes
    const m = new Map()
    for (const r of routes) if (r && typeof r.path === 'string' && typeof r.handler === 'function') m.set(r.path, r)
    state.routeMap = m
    return getOverlayStatus()
  }

  const base = (opts && opts.runtimeDir) || runtimeDir(dshHome)
  ensureDirs(base)
  const log = makeLogger(base, 'overlay')

  const cfg = { ...DEFAULT_CONFIG, ...readJson(path.join(base, 'config.json'), {}) }
  if (!fs.existsSync(path.join(base, 'config.json'))) writeJson(path.join(base, 'config.json'), cfg)

  if (!cfg.enabled) {
    log.info('config.json 里 enabled=false，不启动悬浮层')
    return { ok: true, disabled: true }
  }

  const token = crypto.randomBytes(16).toString('hex')
  const routeMap = new Map()
  for (const r of routes) {
    if (r && typeof r.path === 'string' && typeof r.handler === 'function') routeMap.set(r.path, r)
  }

  const st = {
    cfg, base, token, log, routes: [], child: null, server: null, exe: '', port: 0,
    packageRoot, startedAt: Date.now(), lastHit: Date.now(),
  }
  st.routes = routes
  st.routeMap = routeMap
  state = st

  // ---- HTTP 服务 ----
  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch (err) { try { res.writeHead(400); res.end() } catch (e) {} ; return }
    const pathname = url.pathname
    st.lastHit = Date.now()

    // 存活探测（不要求令牌，只回 200/JSON，不含任何数据）
    if (pathname === '/__health') { respondJson(res, 200, { ok: true, port: st.port, routes: routeMap.size }); return }

    const denied = guard(req, url, token)
    if (denied !== null) {
      if (pathname === '/' || pathname === '/index.html') {
        try {
          res.writeHead(denied, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(denied === 401 ? 'dshw overlay: missing or invalid token' : 'dshw overlay: forbidden')
        } catch (err) {}
      } else {
        respondJson(res, denied, { ok: false, error: denied === 401 ? 'unauthorized' : 'forbidden' })
      }
      return
    }

    // 入口页
    if (pathname === '/' || pathname === '/index.html') {
      let body
      try { body = buildPageHtml(st.cfg) } catch (err) { body = '<!doctype html><meta charset="utf-8">' }
      try {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `dshw_overlay=${token}; Path=/; HttpOnly; SameSite=Strict`,
          'Content-Length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      } catch (err) {}
      return
    }

    // 复用插件已注册的原始路由处理器（走 st.routeMap，热重载时自动换新表）
    const table = st.routeMap || routeMap
    const route = table.get(pathname)
    if (route) {
      // 让 handler 看到的 Host 是我们自己（回环），url 保持原样（含 query）
      try {
        const out = route.handler(req, res)
        if (out && typeof out.then === 'function') out.catch((err) => {
          st.log.warn(`${pathname} 处理异常：${String((err && err.message) || err)}`)
          try { if (!res.headersSent) respondJson(res, 500, { ok: false, error: 'handler error' }) } catch (e) {}
        })
      } catch (err) {
        st.log.warn(`${pathname} 处理抛错：${String((err && err.message) || err)}`)
        try { if (!res.headersSent) respondJson(res, 500, { ok: false, error: 'handler error' }) } catch (e) {}
      }
      return
    }

    respondJson(res, 404, { ok: false, error: 'not found', path: pathname })
  })

  st.server = server
  try {
    st.port = await listen(server, Number(st.cfg.port) || 37917, Number(st.cfg.portScan) || 12)
  } catch (err) {
    st.log.error('监听失败：' + String((err && err.message) || err))
    state = null
    return { ok: false, error: 'listen failed: ' + String((err && err.message) || err) }
  }
  st.log.info(`悬浮层服务已就绪：http://127.0.0.1:${st.port}/  已接管路由 ${routeMap.size} 条`)

  // ---- 薄壳 ----
  st.exe = resolveElectron(cfg, dshHome, base, st.log)
  if (cfg.autoStart && st.exe) {
    spawnShell(st, st.log)
  } else if (!cfg.autoStart) {
    st.log.info('autoStart=false，等待手动执行 overlay-shell 启动')
  }

  writeJson(path.join(runDir(base), 'overlay.json'), {
    port: st.port, token: st.token, pid: process.pid, startedAt: new Date().toISOString(), routes: routeMap.size,
  })

  // ---- 宿主/插件被卸载时自动收尾 ----
  try {
    if (logger && typeof logger.info === 'function') logger.info(`[dshw-overlay] 悬浮层已启动，端口 ${st.port}`)
  } catch (err) {}

  return getOverlayStatus()
}

export function getOverlayStatus() {
  if (!state) return { ok: true, running: false }
  const st = state
  return {
    ok: true,
    running: true,
    port: st.port,
    url: `http://127.0.0.1:${st.port}/`,
    exe: st.exe,
    shellPid: st.child ? st.child.pid : null,
    routes: (() => { try { return st.routes.filter((r) => r && r.path).length } catch (err) { return 0 } })(),
    runtimeDir: st.base,
    startedAt: new Date(st.startedAt).toISOString(),
  }
}
