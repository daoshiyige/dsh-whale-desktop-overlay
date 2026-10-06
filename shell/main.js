// ============================================================================
// dshw-desktop-overlay —— Electron 薄壳
// ============================================================================
// 由 overlay.mjs 用宿主自带的 Electron 启动：
//     <DeepSeek Harness.exe> "<本目录>"
// 本目录没有 node_modules，也不需要：electron / node 内置模块全部由运行时提供。
//
// ── 窗口布局（Windows）────────────────────────────────────────────────────
//   ① 主窗（win）：全屏 + 透明 + 无边框 + 置顶 + 不占任务栏 + 不可缩放
//        · 只负责「画」：**永久整窗鼠标穿透，且运行期从不改动这个状态**
//        · focusable:false —— 永不抢前台
//   ② 热点窗（hot）：几百像素见方 + 透明 + 无边框 + 置顶 + 不占任务栏 + 不可激活
//        · 跟随鲸鱼的可交互包围盒（由主窗 preload 上报）
//        · 只负责「接真实鼠标」，转给主进程后用 sendInputEvent 合成进主窗
//
// ── 为什么要把输入拆成两个窗口（这不是过度设计）──────────────────────────
// 早先的版本只有一个全屏窗：指针压到鲸鱼时调 setIgnoreMouseEvents(false) 来接收点击。
// 那一步会摘掉窗口的 WS_EX_TRANSPARENT，于是浏览器（Chrome/Edge）的窗口遮挡检测
// 不再把它当透明窗口，判定自己「被完全遮挡」→ 停绘 + 丢硬件视频通路 → 正在播放的
// 视频直接黑屏，点一下浏览器才恢复。
// 现在全屏窗的穿透状态是常量、且永不被激活，浏览器最多看到一块小窗压在身上 →
// 永远不会判定完全遮挡 → 视频照常播。
//
// ⚠️ 三个 Windows 上的坑，本文件已处理：
//   ① GUI 子系统的 Electron 主进程 stdout 拿不到 → 日志直接写文件（run/shell.log）
//   ② 宿主调用方可能带着 ELECTRON_RUN_AS_NODE / NODE_OPTIONS → overlay.mjs 侧已摘除，
//      这里再用 TCP 端口做实例锁，避免与 DSH 本体抢 Chromium 的 userData 单例锁
//   ③ 拖动中必须**冻结**热点窗位置，否则热点窗跟着鲸鱼跑 → 相对坐标恒定 →
//      鲸鱼会「原地追自己」，拖动失效（拖动期间改窗口位置还可能丢鼠标捕获）
// ============================================================================

const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron')

const RUNTIME_DIR = process.env.DSHW_OVERLAY_DIR || __dirname
const OVERLAY_URL = process.env.DSHW_OVERLAY_URL || ''
const PORT = Number(process.env.DSHW_OVERLAY_PORT || 0)
const ICON_PATH = process.env.DSHW_OVERLAY_ICON || ''
const CAPTURE_PATH = process.env.DSHW_OVERLAY_CAPTURE || ''
const CAPTURE_DELAY = Number(process.env.DSHW_OVERLAY_CAPTURE_DELAY || 8000)
const CONFIG_PATH = path.join(RUNTIME_DIR, 'config.json')

let CFG = {}
try { CFG = JSON.parse(process.env.DSHW_OVERLAY_CONFIG || '{}') } catch (err) { CFG = {} }

// 交互模式：'hot' = 小热点窗转发（默认，低干扰）；'window' = 旧的全屏命中测试切换穿透
let inputMode = CFG.inputMode === 'window' ? 'window' : 'hot'

let win = null
let hot = null
let hotShown = false
let tray = null
let ignoreMouse = null
let hidden = false
let healthFails = 0

// 热点窗跟踪状态
const hotState = { rect: null, bounds: null, drag: false, dragAt: 0, updates: 0, events: 0, injected: 0, focusedAfterDown: null, lastPageRect: null, expanded: false, lastFullBleed: null }

// —— 文件日志：Windows 上这是唯一可靠的输出通道 ——
const RUN_DIR = path.join(RUNTIME_DIR, 'run')
const LOG_PATH = path.join(RUN_DIR, 'shell.log')
const STATUS_PATH = path.join(RUN_DIR, 'shell-status.json')
try { fs.mkdirSync(RUN_DIR, { recursive: true }) } catch (err) {}

function log(...args) {
  const line = `[${new Date().toISOString()}] [shell] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  try { fs.appendFileSync(LOG_PATH, line, 'utf8') } catch (err) {}
  try { process.stdout.write(line) } catch (err) {}
}
const STATUS = { startedAt: new Date().toISOString(), stage: 'boot', events: [] }
function mark(stage, extra) {
  STATUS.stage = stage
  STATUS.at = new Date().toISOString()
  if (extra) Object.assign(STATUS, extra)
  STATUS.inputMode = inputMode
  STATUS.hotRect = hotState.rect
  STATUS.hotBounds = hotState.bounds
  STATUS.hotDrag = hotState.drag
  STATUS.hotUpdates = hotState.updates
  STATUS.hotEvents = hotState.events
  STATUS.injected = hotState.injected
  STATUS.hotFocusedAfterDown = hotState.focusedAfterDown
  STATUS.mainFocused = !!(win && !win.isDestroyed() && win.isFocused())
  STATUS.events.push({ at: STATUS.at, stage })
  if (STATUS.events.length > 40) STATUS.events.shift()
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(STATUS, null, 2), 'utf8') } catch (err) {}
}

// Electron 常规开关 —— 必须在 ready 之前
// 诊断台可用 DSHW_USERDATA 指定独立数据目录，避免与正在运行的生产实例抢缓存
const USERDATA = process.env.DSHW_USERDATA || path.join(RUN_DIR, 'userdata')
try { app.setPath('userData', USERDATA) } catch (err) {}
try { fs.mkdirSync(USERDATA, { recursive: true }) } catch (err) {}
if (CFG.disableGpu) {
  // 某些机器/驱动组合下 GPU 进程会连续崩溃，最后 Chromium 直接 "GPU process isn't usable. Goodbye."
  // 全屏透明窗口走软件合成完全没问题，所以这里给它一条退路。
  try { app.disableHardwareAcceleration() } catch (err) {}
  try { app.commandLine.appendSwitch('disable-gpu') } catch (err) {}
  try { app.commandLine.appendSwitch('disable-gpu-compositing') } catch (err) {}
  try { app.commandLine.appendSwitch('disable-direct-composition') } catch (err) {}
  log('已启用软件合成（disableGpu=true）')
}
try { app.commandLine.appendSwitch('enable-transparent-visuals') } catch (err) {}
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') } catch (err) {}

// 实例锁：绑一个和悬浮层端口配对的回环端口，比 Chromium 的 userData 单例锁可靠得多
// （后者会和正在运行的 DSH 本体撞车）
const LOCK_PORT = (PORT || 37917) + 1000
let lockServer = null
function acquireLock() {
  return new Promise((resolve) => {
    try {
      lockServer = net.createServer()
      lockServer.once('error', (err) => {
        log('实例锁获取失败（' + String(err && err.code) + '）——已有悬浮窗在跑，本次退出')
        resolve(false)
      })
      lockServer.listen(LOCK_PORT, '127.0.0.1', () => resolve(true))
    } catch (err) { resolve(false) }
  })
}

function displayFor() {
  try {
    const idx = Number(CFG.displayIndex)
    if (Number.isInteger(idx) && idx >= 0) {
      const list = screen.getAllDisplays()
      if (list[idx]) return list[idx]
    }
  } catch (err) {}
  return screen.getPrimaryDisplay()
}

function boundsFor() {
  const d = displayFor()
  return String(CFG.bounds || 'screen') === 'workArea' ? d.workArea : d.bounds
}

// ---------------------------------------------------------------------------
// 写回配置（托盘改的设置要落盘，重启后还生效）
// ---------------------------------------------------------------------------
function persistConfig(patch) {
  try {
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (err) { cur = {} }
    Object.assign(cur, patch)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), 'utf8')
    log('配置已写入 ' + JSON.stringify(patch))
  } catch (err) { log('写配置失败：' + String((err && err.message) || err)) }
}

// ---------------------------------------------------------------------------
// 主窗
// ---------------------------------------------------------------------------
function createWindow() {
  const b = boundsFor()
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 永不抢前台：点了也不会让浏览器失去前台地位（黑屏的另一个触发因素）
    focusable: false,
    alwaysOnTop: CFG.alwaysOnTop !== false,
    show: false,
    title: 'DS Whale Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: true,
      spellcheck: false,
    },
  })

  if (CFG.alwaysOnTop !== false) {
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch (err) {}
  }
  try { win.setMenuBarVisibility(false) } catch (err) {}
  // 全屏窗恒穿透；hot 模式下这就是它的最终状态，运行期不再改
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch (err) {}
  try { win.setFocusable(false) } catch (err) {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (err) {}

  // 挂件里有外链（充值/账单/帮助之类）：不要让它在悬浮窗里开新窗口，
  // 交给系统默认浏览器，悬浮窗始终保持只有一个透明全屏窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url) } catch (err) {} }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== OVERLAY_URL && /^https?:/i.test(url)) {
      e.preventDefault()
      try { shell.openExternal(url) } catch (err) {}
    }
  })

  const relay = (tag) => (...a) => {
    try {
      const first = a[0]
      if (first && typeof first === 'object' && ('message' in first || 'level' in first)) {
        log(`[${tag}] ${first.level || ''} ${first.message || ''}`.trim())
      } else {
        log(`[${tag}]`, ...a)
      }
    } catch (err) {}
  }
  win.webContents.on('console-message', relay('renderer'))
  win.webContents.on('did-finish-load', () => {
    mark('loaded')
    sendInputMode()
  })
  win.webContents.on('did-fail-load', (e, code, desc, url) => { log(`did-fail-load ${code} ${desc} ${url}`); mark('load-failed', { loadError: `${code} ${desc}` }) })
  win.webContents.on('render-process-gone', (e, d) => { log('render-process-gone ' + JSON.stringify(d)); mark('render-gone', { detail: d }) })
  win.webContents.on('preload-error', (e, p, err) => log('preload-error ' + p + ' ' + String(err && err.message)))
  win.on('closed', () => { win = null })
  win.on('unresponsive', () => log('窗口无响应'))

  mark('creating', { bounds: b, lockPort: LOCK_PORT })
  win.loadURL(OVERLAY_URL).catch((err) => log('loadURL 失败：' + String(err && err.message)))

  win.once('ready-to-show', () => {
    try { win.showInactive() } catch (err) { try { win.show() } catch (e) {} }
    let d = null
    try { const p = screen.getPrimaryDisplay(); d = { bounds: p.bounds, workArea: p.workArea, scale: p.scaleFactor } } catch (err) {}
    mark('shown', { bounds: b, display: d, windowBounds: win.getBounds() })
    log(`主窗已显示 请求=${JSON.stringify(b)} 实际=${JSON.stringify(win.getBounds())} bounds=${CFG.bounds} 置顶=${CFG.alwaysOnTop !== false} 模式=${inputMode}`)
    try { log('显示器 ' + JSON.stringify(d)) } catch (err) {}
  })
}

function sendInputMode() {
  try { if (win && !win.isDestroyed()) win.webContents.send('dshw:input-mode', inputMode) } catch (err) {}
}

// ---------------------------------------------------------------------------
// 热点窗：只接鼠标，不画东西
// ---------------------------------------------------------------------------
function createHotWindow() {
  if (hot && !hot.isDestroyed()) return hot
  const b = displayFor().bounds
  const opts = {
    x: b.x + 8, y: b.y + 8, width: 200, height: 200,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,          // WS_EX_NOACTIVATE：点击不激活、不抢前台
    alwaysOnTop: true,
    show: false,
    type: 'toolbar',           // WS_EX_TOOLWINDOW：不进 Alt+Tab
    title: 'DS Whale Hot Zone',
    webPreferences: {
      preload: path.join(__dirname, 'hot-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      devTools: true,
      spellcheck: false,
    },
  }
  try {
    hot = new BrowserWindow(opts)
  } catch (err) {
    // 个别平台/版本对 type 校验严格 —— 去掉它再试一次，宁可少一个 Alt+Tab 优化也不能没有输入
    log('热点窗创建失败（' + String((err && err.message) || err) + '），去掉 type 重试')
    try {
      const o2 = { ...opts }
      delete o2.type
      hot = new BrowserWindow(o2)
    } catch (err2) {
      log('热点窗仍创建失败：' + String((err2 && err2.message) || err2))
      hot = null
      return null
    }
  }
  try { hot.setAlwaysOnTop(true, 'screen-saver') } catch (err) {}
  try { hot.setFocusable(false) } catch (err) {}
  try { hot.setIgnoreMouseEvents(false) } catch (err) {}
  try { hot.setMenuBarVisibility(false) } catch (err) {}
  try { hot.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (err) {}
  hot.webContents.on('did-finish-load', () => { log('热点窗就绪'); mark('hot-loaded') })
  hot.webContents.on('console-message', (e, lvl, msg) => log('[hot] ' + msg))
  hot.webContents.on('render-process-gone', (e, d) => { log('热点窗渲染进程退出 ' + JSON.stringify(d)); hot = null })
  hot.on('closed', () => { hot = null; hotShown = false })
  hot.loadFile(path.join(__dirname, 'hot.html')).catch((err) => log('热点窗加载失败：' + String(err && err.message)))
  return hot
}

function clipToDisplay(x, y, w, h) {
  let d = null
  try { d = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }) } catch (err) { d = null }
  const b = d ? d.bounds : displayFor().bounds
  let x1 = Math.max(x, b.x)
  let y1 = Math.max(y, b.y)
  let x2 = Math.min(x + w, b.x + b.width)
  let y2 = Math.min(y + h, b.y + b.height)
  if (x2 - x1 < 40) x2 = Math.min(b.x + b.width, x1 + 40)
  if (y2 - y1 < 40) y2 = Math.min(b.y + b.height, y1 + 40)
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) }
}

function applyHotRect(rect) {
  hotState.lastPageRect = rect
  if (inputMode !== 'hot') return
  if (!rect || rect.w < 1 || rect.h < 1) { hideHot(); return }
  if (!hot || hot.isDestroyed()) createHotWindow()
  if (!hot || hot.isDestroyed()) {
    // 热点窗起不来 → 退回旧模式，至少保证鲸鱼还能点（旧模式有黑屏风险，但总比不能用强）
    log('热点窗不可用，自动退回 window 模式')
    applyInputMode('window')
    return
  }
  // 拖动期间冻结：热点窗跟着鲸鱼跑会让相对坐标恒定（鲸鱼原地追自己），拖动会失效
  if (hotState.drag) return
  // 扩窗期间交给 applyHotExpand 全权处理，避免两边抢 setBounds 造成抖动。
  // ⚠️ 但**只有真的处于扩窗态才让路**：expanded 是本进程自己置的，如果这里为 true
  //    而窗口实际并没有铺满（例如被 drag 打断、或扩窗那次 setBounds 失败了），
  //    继续 return 就会让热点窗永久停在旧位置 —— 面板点不动、连鲸鱼也点不动。
  //    用「当前窗口是否≈全屏」复核一遍，不一致就按普通矩形贴合（自愈）。
  if (hotState.expanded) {
    let cb = null
    try { cb = hot ? hot.getBounds() : null } catch (err) { cb = null }
    let wb = null
    try { wb = win && !win.isDestroyed() ? win.getBounds() : null } catch (err) { wb = null }
    const reallyExpanded = !!(cb && wb && cb.width >= wb.width - 4 && cb.height >= wb.height - 4)
    if (reallyExpanded) return
    // 状态与事实不符 → 修正状态，走上面的贴合通路
    hotState.expanded = false
    log('扩窗态与窗口实况不符（窗口 ' + JSON.stringify(cb) + '），按常规矩形重新贴合')
  }
  let mb = null
  try { mb = win && !win.isDestroyed() ? win.getBounds() : null } catch (err) { mb = null }
  if (!mb) return
  // 面板/遮罩铺满全屏时，rect 已经≈整个视口 —— 此时再加 padding 没有意义，
  // 反而会被 clipToDisplay 裁回来造成 1~2px 的边缘抖动。只有「鲸鱼本体」才扩边。
  const fullBleed = rect.w >= mb.width - 4 && rect.h >= mb.height - 4
  const pad = fullBleed ? 0 : Math.max(0, Number(CFG.hotPadding ?? 14))
  const b = clipToDisplay(
    mb.x + rect.x - pad,
    mb.y + rect.y - pad,
    rect.w + pad * 2,
    rect.h + pad * 2,
  )
  const prev = hotState.bounds
  if (prev && prev.x === b.x && prev.y === b.y && prev.width === b.width && prev.height === b.height) {
    if (!hotShown) showHot()
    return
  }
  hotState.bounds = b
  hotState.updates++
  if (hotState.updates <= 12 || fullBleed !== hotState.lastFullBleed) {
    log('热点窗定位 ' + JSON.stringify(b) + ' ← 页面 ' + JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }) + (fullBleed ? ' [面板铺满]' : ''))
  }
  hotState.lastFullBleed = fullBleed
  try { hot.setBounds(b, false) } catch (err) { log('热点窗 setBounds 失败：' + String((err && err.message) || err)) }
  mark('hot-bounds')
  showHot()
}

// 抢先扩窗 / 收回。展开时热点窗铺满主窗，随后收到的真实鼠标一律落在窗内，
// 面板弹出的第一下点击就不会丢。窗口仍是 focusable:false，主窗也仍是恒穿透，
// 所以不会触发浏览器的遮挡检测（黑屏根因）——只是覆盖面积大了些。
function applyHotExpand(on) {
  if (inputMode !== 'hot') return
  if (hotState.drag) return
  if (!hot || hot.isDestroyed()) createHotWindow()
  if (!hot || hot.isDestroyed()) return
  let mb = null
  try { mb = win && !win.isDestroyed() ? win.getBounds() : null } catch (err) { mb = null }
  if (!mb) return

  if (on) {
    if (hotState.expanded) return
    const before = hotState.bounds
    hotState.expanded = true
    const b = clipToDisplay(mb.x, mb.y, mb.width, mb.height)
    hotState.bounds = b
    hotState.updates++
    log('热点窗扩为全屏（抢先接住面板点击） ' + JSON.stringify(b) + ' ← 原 ' + JSON.stringify(before))
    try { hot.setBounds(b, false) } catch (err) { log('热点窗扩窗失败：' + String((err && err.message) || err)) }
    mark('hot-expanded')
    showHot()
  } else {
    if (!hotState.expanded) return
    hotState.expanded = false
    log('热点窗收回鲸鱼范围')
    mark('hot-collapsed')
    // 立刻按最后一次已知矩形贴合（没有就等下一次 reportRect）
    applyHotRect(hotState.lastPageRect)
  }
}

function showHot() {
  if (!hot || hot.isDestroyed() || hotShown) return
  if (hidden) return
  try { hot.showInactive() } catch (err) { try { hot.show() } catch (e) {} }
  hotShown = true
  mark('hot-shown')
}

function hideHot() {
  if (!hot || hot.isDestroyed() || !hotShown) return
  try { hot.hide() } catch (err) {}
  hotShown = false
  // 通知主窗：指针不在鲸鱼上了，别留着 hover 态
  try { if (win && !win.isDestroyed()) win.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 }) } catch (err) {}
  mark('hot-hidden')
}

function destroyHot() {
  hideHot()
  try { if (hot && !hot.isDestroyed()) hot.destroy() } catch (err) {}
  hot = null
  // 刻意保留 hotState.bounds：那是「最后一次定位」的记录，退出时写进 shell-status.json
  // 供自检/排查使用（真实边界由 hot 窗口是否存在决定，不靠这个字段）。
  hotState.destroyed = true
}

// ---------------------------------------------------------------------------
// 把热点窗收到的真实鼠标，合成进主窗
// ---------------------------------------------------------------------------
function relayInput(ev) {
  if (!ev || !ev.type) return
  hotState.events++
  if (!win || win.isDestroyed()) return
  if (inputMode !== 'hot') return
  if (!hot || hot.isDestroyed()) return

  let hb = null
  let mb = null
  try { hb = hot.getBounds() } catch (err) { hb = null }
  try { mb = win.getBounds() } catch (err) { mb = null }
  if (!hb || !mb) return
  const x = Math.round((hb.x - mb.x) + Number(ev.x || 0))
  const y = Math.round((hb.y - mb.y) + Number(ev.y || 0))
  const modifiers = Array.isArray(ev.modifiers) ? ev.modifiers : []

  try {
    switch (ev.type) {
      case 'mouseDown':
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: ev.button || 'left', clickCount: Number(ev.clickCount) || 1, modifiers })
        // 拖动状态：冻结热点窗位置，直到 mouseup
        hotState.drag = true
        hotState.dragAt = Date.now()
        hotState.focusedAfterDown = win.isFocused()
        break
      case 'mouseUp':
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: ev.button || 'left', clickCount: Number(ev.clickCount) || 1, modifiers })
        if (hotState.drag) {
          hotState.drag = false
          // 拖动结束后按鲸鱼的新位置重新贴合
          setTimeout(() => { if (!hotState.drag) applyHotRect(hotState.lastPageRect) }, 30)
        }
        break
      case 'mouseMove':
        if (hotState.drag) hotState.dragAt = Date.now()
        // 注意：Electron 合成 mouseMove **无法**表达"左键仍按住"（buttons 恒为 0），
        // 透传 button/buttons 字段也会被忽略。所以按键位由页面壳里的小补丁补正，
        // 见 overlay.mjs 的 buildPageHtml。
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
        break
      case 'mouseEnter':
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
        break
      case 'mouseLeave':
        win.webContents.sendInputEvent({ type: 'mouseLeave', x, y })
        break
      case 'mouseWheel': {
        const dy = Number(ev.deltaY) || 0
        const dx = Number(ev.deltaX) || 0
        win.webContents.sendInputEvent({
          type: 'mouseWheel', x, y,
          deltaX: dx, deltaY: dy,
          wheelTicksX: dx === 0 ? 0 : dx > 0 ? -1 : 1,
          wheelTicksY: dy === 0 ? 0 : dy > 0 ? -1 : 1,
          canScroll: false,
          modifiers,
        })
        break
      }
      default:
        return
    }
  } catch (err) {
    log('合成输入失败：' + String((err && err.message) || err))
    return
  }

  hotState.injected++
  if (hotState.injected <= 30 || hotState.injected % 200 === 0) {
    log(`转发 ${ev.type} → 主窗 (${x},${y}) 已注入=${hotState.injected} 拖动=${hotState.drag}`)
  }
  if (hotState.injected <= 30 || hotState.injected % 50 === 0) mark('hot-input')
}

// 拖动卡死兜底：超过 6 秒没收到任何事件，替用户补一个 mouseup，
// 否则挂件会一直停在拖动态（热点窗丢了鼠标捕获时会发生）
setInterval(() => {
  if (!hotState.drag) return
  const last = hotState.dragAt || 0
  if (Date.now() - last < 6000) return
  log('拖动超时无事件，补一个 mouseUp 收尾')
  try {
    if (win && !win.isDestroyed() && hotState.bounds) {
      const mb = win.getBounds()
      const x = Math.round(hotState.bounds.x - mb.x + hotState.bounds.width / 2)
      const y = Math.round(hotState.bounds.y - mb.y + hotState.bounds.height / 2)
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
  } catch (err) {}
  hotState.drag = false
  applyHotRect(hotState.lastPageRect)
}, 2000)

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function readRuntimeConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (err) { return {} }
}

function toggleHidden() {
  if (!win) return
  hidden = !hidden
  try {
    if (hidden) { win.hide(); hideHot() }
    else {
      win.showInactive()
      try { win.setIgnoreMouseEvents(inputMode === 'window' ? (ignoreMouse !== false) : true, { forward: true }) } catch (err) {}
      applyHotRect(hotState.lastPageRect)
    }
  } catch (err) {}
}

function applyInputMode(next) {
  inputMode = next === 'window' ? 'window' : 'hot'
  CFG.inputMode = inputMode
  persistConfig({ inputMode })
  if (inputMode === 'hot') {
    try { if (win) win.setIgnoreMouseEvents(true, { forward: true }) } catch (err) {}
    ignoreMouse = true
    createHotWindow()
    sendInputMode()
    applyHotRect(hotState.lastPageRect)
    log('交互方式 → 小热点窗（低干扰）')
  } else {
    destroyHot()
    sendInputMode()   // 由 preload 接管穿透切换
    log('交互方式 → 全窗命中测试（旧行为：压住鲸鱼时可能让播放中的视频黑屏）')
  }
  try { if (tray) rebuildTray() } catch (err) {}
}

let rebuildTray = () => {}

function buildTray() {
  if (CFG.tray === false) return
  let img = null
  const cands = [ICON_PATH, path.join(path.dirname(process.execPath), 'resources', 'icon.png')]
  for (const p of cands) {
    try {
      if (!p || !fs.existsSync(p)) continue
      const i = nativeImage.createFromPath(p)
      if (!i.isEmpty()) { img = i.resize({ width: 16, height: 16 }); break }
    } catch (err) {}
  }
  if (!img) { log('未找到可用托盘图标，跳过托盘'); return }
  try {
    tray = new Tray(img)
    tray.setToolTip('小鲸鱼桌面悬浮窗')
    rebuildTray = () => {
      try {
        const cfg = readRuntimeConfig()
        const inAppHidden = cfg.hideInAppWidget === true
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: hidden ? '显示悬浮窗' : '隐藏悬浮窗', click: () => toggleHidden() },
          { label: '重新加载挂件', click: () => { try { if (win) win.webContents.reload() } catch (err) {} } },
          { type: 'separator' },
          {
            label: '始终置顶',
            type: 'checkbox',
            checked: CFG.alwaysOnTop !== false,
            click: (mi) => {
              CFG.alwaysOnTop = mi.checked
              persistConfig({ alwaysOnTop: mi.checked })
              try { if (win) win.setAlwaysOnTop(mi.checked, 'screen-saver') } catch (err) {}
            },
          },
          {
            label: '低干扰交互（小热点窗，推荐）',
            type: 'checkbox',
            checked: inputMode === 'hot',
            click: (mi) => applyInputMode(mi.checked ? 'hot' : 'window'),
          },
          { type: 'separator' },
          {
            label: 'DSH 页面里也显示小鲸鱼',
            type: 'checkbox',
            checked: !inAppHidden,
            click: (mi) => {
              const hide = !mi.checked
              persistConfig({ hideInAppWidget: hide })
              log(hide ? '已关闭 DSH 页内挂件（刷新 DSH 页面后生效）' : '已开启 DSH 页内挂件（刷新 DSH 页面后生效）')
              rebuildTray()
            },
          },
          { type: 'separator' },
          { label: '打开日志目录', click: () => { try { shell.openPath(RUN_DIR) } catch (err) {} } },
          { label: '退出悬浮窗', click: () => { try { app.quit() } catch (err) {} } },
        ]))
      } catch (err) {}
    }
    rebuildTray()
    tray.on('click', () => toggleHidden())
    tray.on('right-click', () => { rebuildTray(); try { tray.popUpContextMenu() } catch (err) {} })
    log('托盘已就绪')
  } catch (err) {
    log('托盘创建失败：' + String(err && err.message))
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('dshw:set-ignore', (e, ignore) => { if (inputMode === 'window') setIgnoreLegacy(ignore) })
ipcMain.on('dshw:hot-rect', (e, rect) => applyHotRect(rect))
// 「抢先扩窗」：鼠标一动就把热点窗铺满视口，好让面板弹出后的第一下点击能被接住
ipcMain.on('dshw:hot-expand', (e, on) => applyHotExpand(!!on))
ipcMain.on('dshw:hot-input', (e, ev) => relayInput(ev))
ipcMain.on('dshw:log', (e, msg) => log('[page] ' + String(msg).slice(0, 400)))
ipcMain.on('dshw:quit', () => app.quit())

// 诊断探针：把「当前几何真相」落盘（排查矩形归属用，不影响正常流程）
// 探针文件路径由环境变量给出，内容是页面里各候选盒子的实测值。
ipcMain.on('dshw:probe', (e, obj) => {
  const p = process.env.DSHW_PROBE_PATH
  if (!p) return
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n'
    fs.appendFileSync(p, line)
  } catch (err) {}
})
ipcMain.on('dshw:reload', () => { try { if (win) win.webContents.reload() } catch (err) {} })

// 仅 window 模式使用（旧行为）
function setIgnoreLegacy(next) {
  const v = !!next
  if (v === ignoreMouse) return
  ignoreMouse = v
  try { if (win) win.setIgnoreMouseEvents(v, { forward: true }) } catch (err) {}
}

// ---------------------------------------------------------------------------
// 心跳：宿主/插件没了就自己退出，绝不留孤儿窗口
// ---------------------------------------------------------------------------
function startHealth() {
  if (!PORT || CFG.quitWhenHostExits === false) return
  const url = `http://127.0.0.1:${PORT}/__health`
  setInterval(async () => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 2500)
      const r = await fetch(url, { signal: ctl.signal })
      clearTimeout(t)
      if (!r.ok) throw new Error('status ' + r.status)
      healthFails = 0
    } catch (err) {
      healthFails++
      mark('health-fail', { healthFails })
      if (healthFails >= 3) { log('宿主心跳连续失败，退出悬浮窗'); app.quit() }
    }
  }, 5000)
}

// ---------------------------------------------------------------------------
// 自检模式：截图 + DOM 探针落盘后退出
// ---------------------------------------------------------------------------
async function maybeCapture() {
  if (!CAPTURE_PATH) return
  await new Promise((r) => setTimeout(r, Math.max(1000, CAPTURE_DELAY)))
  try {
    const img = await win.webContents.capturePage()
    const buf = img.toPNG()
    fs.mkdirSync(path.dirname(CAPTURE_PATH), { recursive: true })
    fs.writeFileSync(CAPTURE_PATH, buf)
    log('已截图 ' + CAPTURE_PATH + ' (' + buf.length + ' bytes, ' + JSON.stringify(img.getSize()) + ')')
    const probe = await win.webContents.executeJavaScript(
      `JSON.stringify({ ct: document.contentType, rs: document.readyState, href: location.href,`
      + ` root: !!document.querySelector('.dshwv-root'),`
      + ` bodyKids: document.body ? document.body.childNodes.length : -1,`
      + ` rootRect: (function(){var r=document.querySelector('.dshwv-root');if(!r)return null;var b=r.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})()`
      + `, vw: innerWidth, vh: innerHeight })`
    ).catch((e) => 'probe failed: ' + String(e && e.message))
    log('DOM 探针 ' + probe)
    mark('captured', { shot: CAPTURE_PATH, probe: String(probe) })
  } catch (err) {
    log('截图失败：' + String((err && err.message) || err))
    mark('capture-failed', { error: String((err && err.message) || err) })
  }
  try { app.quit() } catch (err) {}
}

// 自检：在热点窗 DOM 里造事件，验证「热点窗 → IPC → 合成输入 → 主窗」后半段链路
// ⚠️ 落点必须取鲸鱼**不透明像素的质心**：挂件用逐像素 alpha 命中测试（isWhaleHit），
//    打在包围盒里透明的地方是不会有任何反应的 —— 这一点踩过一次坑。
async function hotRelaySelfTest() {
  if (process.env.DSHW_HOT_SELFTEST !== '1') return
  await new Promise((r) => setTimeout(r, Math.max(2000, CAPTURE_DELAY - 3000)))
  try {
    if (!hot || hot.isDestroyed() || !hotState.bounds) { log('热点窗自检跳过：热点窗未就绪'); mark('hot-selftest-skip'); return }
    const rectOf = `(function(){var r=document.querySelector('.dshwv-root');if(!r)return null;var b=r.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})()`
    const anchor = await win.webContents.executeJavaScript(`(function(){
      try{
        var img=document.querySelector('.dshwv-img'); if(!img) return null;
        var r=img.getBoundingClientRect(); if(!r||r.width<2||r.height<2) return null;
        var N=64; var c=document.createElement('canvas'); c.width=N; c.height=N;
        var ctx=c.getContext('2d'); ctx.drawImage(img,0,0,N,N);
        var d=ctx.getImageData(0,0,N,N).data; var sx=0,sy=0,n=0;
        for(var y=0;y<N;y++){ for(var x=0;x<N;x++){ if(d[(y*N+x)*4+3]>40){ sx+=x; sy+=y; n++ } } }
        if(!n) return null;
        return { x: r.left + (sx/n)/N*r.width, y: r.top + (sy/n)/N*r.height, opaque: n };
      }catch(e){ return null }
    })()`).catch(() => null)
    const before = await win.webContents.executeJavaScript(rectOf).catch(() => null)
    if (!anchor) { log('热点窗自检跳过：拿不到鲸鱼不透明像素质心'); mark('hot-selftest-skip'); return }

    const hb = hot.getBounds()
    const mb = win.getBounds()
    const local = { x: Math.round(anchor.x - hb.x + mb.x), y: Math.round(anchor.y - hb.y + mb.y) }
    log(`自检落点：页面(${Math.round(anchor.x)},${Math.round(anchor.y)}) → 热点窗内(${local.x},${local.y}) 窗口${hb.width}x${hb.height} 不透明样本=${anchor.opaque}`)
    if (local.x < 0 || local.y < 0 || local.x > hb.width || local.y > hb.height) {
      log('自检落点不在热点窗内，跳过'); mark('hot-selftest-skip'); return
    }

    const script = (t, x, y) => `window.__dshwHot && window.__dshwHot.inject(${JSON.stringify(t)},${x},${y},'left')`
    const snap = `(function(){
      var rs = document.querySelectorAll('.dshwv-root');
      return JSON.stringify(Array.prototype.map.call(rs, function(r){
        var b = r.getBoundingClientRect();
        return { n: rs.length, cls: String(r.className), styleLeft: r.style.left||'', styleTop: r.style.top||'', rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }
      }))
    })()`

    // —— 坐标回显探针：确认「热点窗内坐标 → 主窗页面坐标」的换算真的对得上 ——
    try {
      await win.webContents.executeJavaScript(`(function(){
        window.__dshwEcho = [];
        var rec = function(tag){ return function(e){
          var t = e.target || {};
          var cn = (t.className && typeof t.className === 'string') ? t.className : (t.tagName || '');
          window.__dshwEcho.push([tag, e.clientX, e.clientY, 'b=' + e.buttons, String(cn).slice(0,24)]);
        } };
        document.addEventListener('pointerdown', rec('pd'), true);
        document.addEventListener('pointermove', rec('pm'), true);
        document.addEventListener('mousemove', rec('mm'), true);
        document.addEventListener('pointerup', rec('pu'), true);
        document.addEventListener('pointercancel', rec('pc'), true);
        document.addEventListener('lostpointercapture', rec('lc'), true);
        return true
      })()`)
      await hot.webContents.executeJavaScript(script('mouseMove', 50, 50)).catch(() => {})
      await new Promise((r) => setTimeout(r, 200))
      await hot.webContents.executeJavaScript(script('mouseDown', 60, 60)).catch(() => {})
      await new Promise((r) => setTimeout(r, 200))
      await hot.webContents.executeJavaScript(script('mouseUp', 60, 60)).catch(() => {})
      await new Promise((r) => setTimeout(r, 200))
      const echo = await win.webContents.executeJavaScript(`JSON.stringify(window.__dshwEcho||[])`).catch(() => '[]')
      const rootCls = await win.webContents.executeJavaScript(`(function(){var r=document.querySelector('.dshwv-root');return r?String(r.className):'NO-ROOT'})()`).catch(() => '?')
      log(`坐标回显：期望页面(${hb.x - mb.x + 50},${hb.y - mb.y + 50}) 实际=${echo} 根类=${rootCls}`)
    } catch (err) { log('坐标回显探针失败：' + String((err && err.message) || err)) }

    await hot.webContents.executeJavaScript(script('mouseEnter', local.x, local.y)).catch(() => {})
    await hot.webContents.executeJavaScript(script('mouseMove', local.x, local.y)).catch(() => {})
    log('按下前样式：' + await win.webContents.executeJavaScript(snap).catch(() => '?'))
    await hot.webContents.executeJavaScript(script('mouseDown', local.x, local.y)).catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    log('按下后样式：' + await win.webContents.executeJavaScript(snap).catch(() => '?'))
    // 按下后挂件会给根加 dshwv-dragging —— 这是"拖动真的开始了"的直接证据
    const clsAfterDown = await win.webContents.executeJavaScript(`(function(){var r=document.querySelector('.dshwv-root');return r?String(r.className):'NO-ROOT'})()`).catch(() => '?')
    log('按下后根类：' + clsAfterDown)
    await hot.webContents.executeJavaScript(script('mouseMove', local.x - 20, local.y - 20)).catch(() => {})
    await new Promise((r) => setTimeout(r, 200))
    log('首次移动后样式：' + await win.webContents.executeJavaScript(snap).catch(() => '?'))
    // 拖一小段：热点窗此时被冻结，主窗里的鲸鱼应该跟着动
    for (let i = 1; i <= 6; i++) {
      await hot.webContents.executeJavaScript(script('mouseMove', local.x - i * 8, local.y - i * 8)).catch(() => {})
      await new Promise((r) => setTimeout(r, 60))
    }
    // 关键：在**松开之前**读一次鲸鱼位置 —— 松手后挂件会四边吸附，可能正好弹回原位
    const mid = await win.webContents.executeJavaScript(rectOf).catch(() => null)
    await hot.webContents.executeJavaScript(script('mouseUp', local.x - 48, local.y - 48)).catch(() => {})
    await new Promise((r) => setTimeout(r, 900))
    const after = await win.webContents.executeJavaScript(rectOf).catch(() => null)
    const focused = win.isFocused()
    const moved = !!(before && mid && (before.x !== mid.x || before.y !== mid.y))
    const echoAll = await win.webContents.executeJavaScript(`JSON.stringify((window.__dshwEcho||[]).map(function(a){return a[0]+'@'+a[1]+','+a[2]+' '+a[3]+' '+a[3]}).join(' | '))`).catch(() => '?')
    log('拖动期间页面收到：' + echoAll)
    log(`热点窗自检：注入=${hotState.injected} 落点=${JSON.stringify(local)} 拖动中 ${JSON.stringify(before)} → ${JSON.stringify(mid)} 松开后 ${JSON.stringify(after)} 拖动生效=${moved} 主窗被激活=${focused}`)
    mark('hot-selftest-done', { before, midDrag: mid, after, injected: hotState.injected, mainFocused: focused, dragWorked: moved, anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) } })
  } catch (err) {
    log('热点窗自检失败：' + String((err && err.message) || err))
    mark('hot-selftest-failed', { error: String((err && err.message) || err) })
  }
}

let gpuCrashes = 0
app.on('child-process-gone', (e, d) => {
  if (d && d.type === 'GPU') { gpuCrashes++; mark('gpu-gone', { gpuCrashes, detail: d }) }
  else log('child-process-gone ' + JSON.stringify(d))
})

// ---------------------------------------------------------------------------
// 诊断场景：脚本化地「点开设置面板」，把几何真相落盘
// ---------------------------------------------------------------------------
// 只验证一件事：**面板的矩形是否落在 root 落点盒之外**。
//   落点盒 = 我们用来摆热点窗的矩形；面板在盒外 ⇒ 那一片区域根本没有窗口接收鼠标
//   ⇒ 现象就是「面板点不动」。这是纯几何判定，与动画/时序无关，可离线复现。
async function menuProbeScenario() {
  if (process.env.DSHW_PROBE !== '1' || !process.env.DSHW_MENU_PROBE) return
  await new Promise((r) => setTimeout(r, 3500))
  try {
    const before = await win.webContents.executeJavaScript(`(function(){
      var root=document.querySelector('.dshwv-root'); if(!root) return {err:'no-root'};
      var r=root.getBoundingClientRect();
      var m=document.querySelector('.dshwv-menu');
      var mb=m?m.getBoundingClientRect():null;
      var btn=document.querySelector('.dshwv-menu-btn');
      var bb=btn?btn.getBoundingClientRect():null;
      return { root:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
               inline:{left:root.style.left,top:root.style.top},
               menu:mb?{x:Math.round(mb.left),y:Math.round(mb.top),w:Math.round(mb.width),h:Math.round(mb.height)}:null,
               menuCls:m?String(m.className):null,
               btn:bb?{x:Math.round(bb.left),y:Math.round(bb.top),w:Math.round(bb.width),h:Math.round(bb.height)}:null,
               btnCls:btn?String(btn.className):null } })()`).catch(() => null)
    log('MENU-PROBE 打开前 ' + JSON.stringify(before))
    // 用页面自己的方式开菜单：点菜单按钮（挂件监听的是 click）
    const opened = await win.webContents.executeJavaScript(`(function(){
      var btn=document.querySelector('.dshwv-menu-btn'); if(!btn) return 'no-btn';
      btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
      return 'clicked' })()`).catch((e) => 'err:' + String(e && e.message))
    log('MENU-PROBE 点击结果 ' + opened)
    await new Promise((r) => setTimeout(r, 1200))
    const after = await win.webContents.executeJavaScript(`(function(){
      var root=document.querySelector('.dshwv-root'); if(!root) return {err:'no-root'};
      var r=root.getBoundingClientRect();
      var m=document.querySelector('.dshwv-menu');
      var mb=m?m.getBoundingClientRect():null;
      var cs=m?getComputedStyle(m):null;
      return { root:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
               inlineLeft:root.style.left, inlineTop:root.style.top,
               menu:mb?{x:Math.round(mb.left),y:Math.round(mb.top),w:Math.round(mb.width),h:Math.round(mb.height)}:null,
               menuCls:m?String(m.className):null,
               menuDisp:cs?cs.display:null, menuOp:cs?cs.opacity:null, menuPE:cs?cs.pointerEvents:null } })()`).catch(() => null)
    log('MENU-PROBE 打开后 ' + JSON.stringify(after))
    // 判定：面板是否落在「落点盒」之外
    if (after && after.root && after.menu) {
      const outside = after.menu.x < after.root.x - 1
        || after.menu.y < after.root.y - 1
        || after.menu.x + after.menu.w > after.root.x + after.root.w + 1
        || after.menu.y + after.menu.h > after.root.y + after.root.h + 1
      const gapTop = after.root.y - (after.menu.y + after.menu.h)
      log(`MENU-PROBE 判定：面板在落点盒之外=${outside} 面板底边到鲸鱼顶部间距=${Math.round(gapTop)}px（>0 表示面板悬在盒外）`)
      mark('menu-probe', { outside, gapTop: Math.round(gapTop), root: after.root, menu: after.menu })
    }

    // ---- 关键验证：在**面板区域内**做一次真实点击，看挂件是否收到 ----
    // 面板 y=565~865，鲸鱼 y=770~1020 ⇒ 取 y=650（面板上、鲸鱼外）作落点。
    // 若热点窗没有覆盖到那里，这一下点击会掉进「没有窗口」的真空 → 挂件收不到任何事件。
    const pt = await win.webContents.executeJavaScript(`(function(){
      var m=document.querySelector('.dshwv-menu'); if(!m) return null;
      var b=m.getBoundingClientRect(); if(!b||b.height<10) return null;
      // 取面板里第一个真正可点的控件（按钮/输入/带 pointer-events:auto 的元素）
      var cands=m.querySelectorAll('button,input,select,[role=button],.dshwv-mi,.dshwv-menu-item,div,span');
      for (var i=0;i<cands.length;i++){
        var el=cands[i], r=el.getBoundingClientRect();
        if (r.width<8||r.height<8) continue;
        var cs=getComputedStyle(el);
        if (cs.pointerEvents!=='auto'&&cs.pointerEvents!=='all') continue;
        if (cs.display==='none'||cs.visibility==='hidden') continue;
        return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2),
                 tag:el.tagName, cls:String(el.className).slice(0,50) };
      }
      return { x:Math.round(b.left+b.width/2), y:Math.round(b.top+20), tag:'MENU', cls:'fallback' } })()`).catch(() => null)
    log('MENU-PROBE 面板落点 ' + JSON.stringify(pt))
    if (pt && hot && !hot.isDestroyed()) {
      const hb = hot.getBounds()
      const mb = win.getBounds()
      const lx = Math.round(pt.x - hb.x + mb.x)
      const ly = Math.round(pt.y - hb.y + mb.y)
      const inHot = lx >= 0 && ly >= 0 && lx <= hb.width && ly <= hb.height
      log(`MENU-PROBE 热点窗 ${JSON.stringify(hb)} 落点→窗内(${lx},${ly}) 在窗内=${inHot}`)
      if (inHot) {
        const before = await win.webContents.executeJavaScript(`(function(){window.__mprobe=[];var t=['mousedown','mouseup','click'];t.forEach(function(k){document.addEventListener(k,function(e){window.__mprobe.push(k+'@'+Math.round(e.clientX)+','+Math.round(e.clientY)+' '+(e.target.className||e.target.tagName))},true)})})()`).catch(() => {})
        await hot.webContents.executeJavaScript(`window.__dshwHot && window.__dshwHot.inject('mouseDown',${lx},${ly},'left')`).catch(() => {})
        await new Promise((r) => setTimeout(r, 60))
        await hot.webContents.executeJavaScript(`window.__dshwHot && window.__dshwHot.inject('mouseUp',${lx},${ly},'left')`).catch(() => {})
        await new Promise((r) => setTimeout(r, 400))
        const got = await win.webContents.executeJavaScript(`JSON.stringify(window.__mprobe||[])`).catch(() => '[]')
        log('MENU-PROBE 面板点击结果（挂件收到的事件）:' + got)
        mark('menu-click', { point: pt, local: { x: lx, y: ly }, inHot, got: String(got) })
      }
    }
  } catch (err) {
    log('MENU-PROBE 失败：' + String((err && err.message) || err))
  }
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`)
  log('目标页面 ' + OVERLAY_URL)
  log('交互模式 ' + inputMode)
  mark('ready')
  if (!OVERLAY_URL) { log('缺少 DSHW_OVERLAY_URL，退出'); app.quit(); return }
  const ok = await acquireLock()
  if (!ok) { app.quit(); return }
  mark('locked', { lockPort: LOCK_PORT })
  createWindow()
  if (inputMode === 'hot') createHotWindow()
  buildTray()
  startHealth()
  hotRelaySelfTest().finally(() => maybeCapture())
  menuProbeScenario()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  try { destroyHot() } catch (err) {}
  try { if (tray) tray.destroy() } catch (err) {}
  try { if (lockServer) lockServer.close() } catch (err) {}
  mark('quitting')
})
process.on('uncaughtException', (err) => log('uncaughtException ' + String((err && err.stack) || err)))
