// ============================================================================
// dshw-desktop-overlay —— 主窗 preload
// ============================================================================
// 有两种输入模式，由 config.json 的 inputMode 决定，可运行时切换（主进程发 'dshw:input-mode'）：
//
//   hot    （默认，推荐）—— 全屏主窗**永久穿透、永不改样式**，只负责「画」。
//                          本 preload 周期性上报鲸鱼的可交互包围盒，主进程据此摆放热点窗；
//                          真实鼠标由热点窗接收并转发（见 hot-preload.js）。
//                          这样浏览器永远不会把我们当成遮挡窗口 → 不会黑屏。
//
//   window （旧行为）    —— 全屏主窗自己做命中测试，压在鲸鱼上时临时关闭穿透。
//                          实现简单，但那一步会让浏览器判定自己被遮挡，
//                          压着鲸鱼时正在播放的视频会黑屏（所以才有了 hot 模式）。
//
// 两种模式下"点空白处穿透到下层窗口"都成立：
//   鲸鱼前端本身就是 .dshwv-root{pointer-events:none} + 鲸鱼/菜单{pointer-events:auto}，
//   所以 hot 模式直接用 getComputedStyle 挑出「可交互元素」的并集，
//   window 模式用 elementFromPoint 判命中，语义一致。
// ============================================================================

const { ipcRenderer, contextBridge } = require('electron')

let CFG = {}
try { CFG = JSON.parse(process.env.DSHW_OVERLAY_CONFIG || '{}') } catch (err) { CFG = {} }

let mode = CFG.inputMode === 'window' ? 'window' : 'hot'

// ---------------------------------------------------------------------------
// hot 模式：上报可交互区域
// ---------------------------------------------------------------------------
let lastKey = ''
let rectTimer = null

function elVisible(el) {
  // 先做便宜的空间判断，再读计算样式（挂件 DOM 不大，但别每帧都全量 getComputedStyle）
  let r
  try { r = el.getBoundingClientRect() } catch (err) { return null }
  if (!r || r.width < 1 || r.height < 1) return null
  // 完全在视口外的（占位/离屏元素）不算
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null
  let cs
  try { cs = getComputedStyle(el) } catch (err) { return null }
  if (!cs) return r
  if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return null
  if (Number(cs.opacity || 1) < 0.05) return null
  if (cs.pointerEvents !== 'auto' && cs.pointerEvents !== 'all') return null
  return r
}

// 「弹出层」选择器：挂件的设置面板/对话框/遮罩**不在 .dshwv-root 子树里**，
// 而是 position:fixed 挂在 body 上、铺满全屏（inset:0）。只扫 root 会完全漏掉它们，
// 表现就是「低干扰模式下点不动选项」。
// 取值来自挂件自己的 z-index 分层表：20000–22999 遮罩层、26000+ 小浮层/面板。
const OVERLAY_SEL = [
  '.dshwv-cropmask', '.dshwv-gifmask', '.dshwv-resmask', '.dshwv-audiomask',
  '.dshwv-bubmask', '.dshwv-snapmask', '.dshwv-confirmmask', '.dshwv-usage-mask',
  '.dshwv-usagepanel', '.dshwv-qedit', '.dshwv-custmenu', '.dshwv-colpop', '.dshwv-rgbmenu',
  '.dshwv-rolelist', '.dshwv-audiolist', '.dshwv-slotlist', '.dshwv-menu',
].join(',')

// 弹出层是否真的「开着」：挂件用 open 类 / display / 可见性 三套信号，都要认
function popupVisible(el) {
  let cs = null
  try { cs = getComputedStyle(el) } catch (err) { return false }
  if (!cs) return false
  if (cs.display === 'none' || cs.visibility === 'hidden') return false
  if (Number(cs.opacity || 1) < 0.05) return false
  const cls = el.className
  const clsStr = typeof cls === 'string' ? cls : (cls && cls.baseVal) || ''
  // 带 open 类的一定是开着（挂件用 .dshwv-xxx-open 控制显隐）
  if (/-open\b/.test(clsStr)) return true
  // 遮罩类：position:fixed + inset:0 且没被 display 关掉，就算开着
  if (cs.position === 'fixed' && cs.display !== 'none') {
    let r = null
    try { r = el.getBoundingClientRect() } catch (err) { return false }
    return !!r && r.width > 1 && r.height > 1
  }
  return false
}

function interactiveRect() {
  let root = null
  try { root = document.querySelector('.dshwv-root') } catch (err) { root = null }

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (r) => {
    if (!r) return
    if (r.left < x1) x1 = r.left
    if (r.top < y1) y1 = r.top
    if (r.right > x2) x2 = r.right
    if (r.bottom > y2) y2 = r.bottom
  }

  // ① 挂件本体（root 子树）：与原来一致
  if (root) {
    add(elVisible(root))
    let nodes = []
    try { nodes = root.querySelectorAll('*') } catch (err) { nodes = [] }
    const cap = Math.min(nodes.length, 600)
    for (let i = 0; i < cap; i++) add(elVisible(nodes[i]))
  }

  // ② 弹出层（body 下的 fixed 面板/遮罩）：这是「选项点不动」的根因所在
  let pops = []
  try { pops = document.querySelectorAll(OVERLAY_SEL) } catch (err) { pops = [] }
  for (let i = 0; i < pops.length; i++) {
    const el = pops[i]
    if (!popupVisible(el)) continue
    // 遮罩铺满全屏时，直接用它的矩形（就是整个视口）
    let r = null
    try { r = el.getBoundingClientRect() } catch (err) { continue }
    add(r)
    // 面板内部的可交互子元素也并进来（面板可能比遮罩小、且居中）
    let kids = []
    try { kids = el.querySelectorAll('*') } catch (err) { kids = [] }
    const kcap = Math.min(kids.length, 400)
    for (let k = 0; k < kcap; k++) add(elVisible(kids[k]))
  }

  if (!isFinite(x1) || x2 <= x1 || y2 <= y1) return null
  // 视口裁剪：全屏遮罩会让并集等于整屏，这是**预期行为**（面板开着时确实要整屏接事件）
  const nx1 = Math.max(0, x1)
  const ny1 = Math.max(0, y1)
  const nx2 = Math.min(innerWidth, x2)
  const ny2 = Math.min(innerHeight, y2)
  if (nx2 <= nx1 || ny2 <= ny1) return null
  return { x: nx1, y: ny1, w: nx2 - nx1, h: ny2 - ny1 }
}

function reportRect() {
  if (mode !== 'hot') return
  const r = interactiveRect()
  // 出屏部分不报（主进程会再裁一次）；这里只上报原始页面坐标
  const key = r
    ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    : 'none'
  if (key === lastKey) return
  lastKey = key
  try { ipcRenderer.send('dshw:hot-rect', r) } catch (err) {}
}

// ---------------------------------------------------------------------------
// 抢先扩窗
// ---------------------------------------------------------------------------
// 问题：面板弹出的那一瞬间，鼠标已经落在「鲸鱼包围盒之外」——热点窗只盖着包围盒，
// 那一下点击没有窗口接收，等 200ms 轮询报告新矩形来不及。
//
// 办法：**侦测到面板/遮罩打开**（MutationObserver 盯 body 的 class/style），
// 立刻把热点窗扩到整个视口；面板关闭后再收回鲸鱼范围。
//
// ⚠️ 千万不要用「鼠标一动就扩窗」——扩窗后热点窗铺满全屏，它自己会吃到 mousemove，
//    经主窗合成回来又触发本函数，形成毫秒级扩/收死循环（实测每秒几十次 setBounds）。
//    所以这里的唯一触发源是 DOM 变化，与鼠标无关。
let expanded = false
let collapseTimer = null

function hasOpenPopup() {
  let pops = []
  try { pops = document.querySelectorAll(OVERLAY_SEL) } catch (err) { return false }
  for (let i = 0; i < pops.length; i++) {
    if (popupVisible(pops[i])) return true
  }
  return false
}

// ⚠️ 第二个抖动源：热点窗接收真实鼠标 → 经主窗合成回页面 → 挂件的 :hover 态改 class
//   → mo2 又触发 syncExpand()。面板没开时它只是白跑计算（有缓存短路，无害），
//   但「面板正开着、鼠标悬停面板内元素」时会高频触发 → 高频查 popupVisible。
//   用 60ms 节流把这件事压掉：面板开/关本身是低频的，节流不影响体验。
let syncAt = 0
let syncPending = null
function syncExpandThrottled() {
  const now = Date.now()
  if (now - syncAt >= 60) { syncAt = now; syncExpand(); return }
  if (syncPending) return
  syncPending = setTimeout(() => { syncPending = null; syncAt = Date.now(); syncExpand() }, 60)
}

function setExpanded(on) {
  if (on === expanded) return
  expanded = on
  try { ipcRenderer.send('dshw:hot-expand', on) } catch (err) {}
}

// 由 DOM 变化 / 轮询驱动。面板开着就保持扩窗，关掉后延时收回（避免刚关又开的抖动）
function syncExpand() {
  if (mode !== 'hot') return
  const open = hasOpenPopup()
  if (open) {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
    setExpanded(true)
  } else if (expanded) {
    if (collapseTimer) return
    collapseTimer = setTimeout(() => {
      collapseTimer = null
      if (!hasOpenPopup()) setExpanded(false)
    }, 600)
  }
}

function startRectLoop() {
  if (rectTimer) return
  // 200ms 足够跟上拖动/四边吸附；挂件本身的位置变化不会比这更快
  rectTimer = setInterval(() => { reportRect(); syncExpand() }, 200)
  window.addEventListener('resize', reportRect)
  window.addEventListener('scroll', reportRect, true)
  // 挂件被 SPA 摘掉又重挂、或切换角色/尺寸时也能及时更新
  try {
    const mo = new MutationObserver(() => reportRect())
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    // 面板开/关要立刻反映（不能等 200ms 轮询）：面板本身在 body 下、靠 class 切换显隐
    const mo2 = new MutationObserver(() => { reportRect(); syncExpandThrottled() })
    mo2.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  } catch (err) {}
  setTimeout(reportRect, 120)
  setTimeout(reportRect, 800)
}

// ---------------------------------------------------------------------------
// window 模式：命中测试驱动的鼠标穿透（旧行为，保留作降级）
// ---------------------------------------------------------------------------
let ignoring = null
let pointerDown = false
let frameGate = false

function isInteractiveAt(x, y) {
  if (pointerDown) return true
  try {
    if (document.querySelector('.dshwv-root[class*="dshwv-dragging"]')) return true
  } catch (err) {}
  let el = null
  try { el = document.elementFromPoint(x, y) } catch (err) { el = null }
  if (!el) return false
  if (el === document.documentElement || el === document.body) return false
  try {
    const cs = getComputedStyle(el)
    if (cs && cs.pointerEvents === 'none') return false
    if (cs && cs.visibility === 'hidden') return false
  } catch (err) {}
  return true
}

function pushIgnore(ignore) {
  if (mode !== 'window') return
  if (ignore === ignoring) return
  ignoring = ignore
  try { ipcRenderer.send('dshw:set-ignore', ignore) } catch (err) {}
}

window.addEventListener('mousemove', (e) => {
  if (mode !== 'window') return
  if (frameGate) return
  frameGate = true
  const x = e.clientX
  const y = e.clientY
  requestAnimationFrame(() => { frameGate = false; pushIgnore(!isInteractiveAt(x, y)) })
}, true)

window.addEventListener('mousedown', () => { pointerDown = true; pushIgnore(false) }, true)
window.addEventListener('mouseup', () => { pointerDown = false }, true)
window.addEventListener('mouseout', (e) => { if (!e.relatedTarget && !pointerDown) pushIgnore(true) }, true)
document.addEventListener('mouseleave', () => { if (!pointerDown) pushIgnore(true) }, true)

// ---------------------------------------------------------------------------
// 模式切换（主进程 → 托盘里改交互方式，不用重启）
// ---------------------------------------------------------------------------
ipcRenderer.on('dshw:input-mode', (e, m) => {
  mode = m === 'window' ? 'window' : 'hot'
  lastKey = ''
  if (mode === 'hot') {
    startRectLoop()
    reportRect()
  } else {
    if (rectTimer) { clearInterval(rectTimer); rectTimer = null }
    try { ipcRenderer.send('dshw:hot-rect', null) } catch (err) {}
    ignoring = null
    pushIgnore(true)
  }
})

// 启动
if (mode === 'hot') {
  pushIgnore(true)          // 兜底：hot 模式下主窗永远穿透
  startRectLoop()
} else {
  pushIgnore(true)
}

// 页面报错转主进程日志（挂件 900KB，出问题不然没线索）
window.addEventListener('error', (e) => {
  try { ipcRenderer.send('dshw:log', 'page error: ' + (e.message || '') + ' @' + (e.filename || '')) } catch (err) {}
}, true)
window.addEventListener('unhandledrejection', (e) => {
  try { ipcRenderer.send('dshw:log', 'unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)) } catch (err) {}
})

contextBridge.exposeInMainWorld('__dshwOverlay', {
  version: 2,
  reload: () => { try { ipcRenderer.send('dshw:reload') } catch (err) {} },
  quit: () => { try { ipcRenderer.send('dshw:quit') } catch (err) {} },
  setIgnore: (v) => pushIgnore(!!v),
  hitTest: (x, y) => isInteractiveAt(x, y),
  rect: () => interactiveRect(),
  mode: () => mode,
  log: (m) => { try { ipcRenderer.send('dshw:log', String(m)) } catch (err) {} },
})
