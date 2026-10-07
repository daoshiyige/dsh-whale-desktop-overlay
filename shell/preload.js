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
// ── 设计说明（为什么是现在这个形状）─────────────────────────────────────────
// 历史上有两条互相拉扯的错误路线，都别再走了：
//
//  A) 「扫 .dshwv-root 的整棵子树」求并集
//     ⇒ 子树里全是会动的装饰（呼吸动画、hover 悬浮、menu-btn），
//       实测会把并集炸到 1607x919 ≈ 整个视口，而且每 200ms 都在变 ⇒ 窗口狂抖。
//
//  B) 「只扫 root 自身，面板靠另一条 expanded 通路兜」
//     ⇒ 抖动治好了，但面板是 position:fixed 挂在 body 上、鲸鱼贴右下角时
//       必然向上展开、整体落在鲸鱼盒之外 ⇒ 面板那一片根本没有窗口接收鼠标
//       ⇒ 面板点不动。且 expanded 是「本页先置位、主进程再扩窗」的两段式，
//       一旦主进程错过/拒绝扩窗，本页 reportRect 永久让路 ⇒ 热点窗永久停摆，
//       连鲸鱼都点不动（实测 hotUpdates 卡 1、hotEvents=0）。
//
// 现在这条：**几何即真相，单通路**。
//   · 鲸鱼本体：只用 root 自己的**落点盒**（内联 style.left/top + offsetWidth/Height），
//     不读过渡中的 getBoundingClientRect，从根上不抖。
//   · 弹出层：用**显式选择器清单**逐个量可见的（getBoundingClientRect 只用于
//     判断可见性/取面板几何 —— 面板没有 left/top 过渡，读 rect 是安全的）。
//     清单是穷举过的（见 OVERLAY_SEL 的实证说明），不会误纳常驻节点。
//   · 两者求并集，一次上报。**不再有 expanded 让路**，也就没有停摆失败态。
// ---------------------------------------------------------------------------
let lastKey = ''
let rectTimer = null
let stableRect = null          // 死区缓存：变化小于阈值时沿用上次上报的矩形

// ── 统一的可交互性判定 ──────────────────────────────────────────────────────
// opacity 必须**沿祖先链累乘**：CSS 的 opacity 不继承，子元素自身的
// computed opacity 恒为 1。挂件大量使用「父层 opacity:0 淡出、子元素仍 opacity:1」
// 的做法（.dshwv-menu 的过渡、.dshwv-menu-btn 的 hover 淡入），
// 只看自身 opacity 会把这些"实际上看不见"的层判成可见 ⇒ 并集虚胖 + 抖动。
function effectiveOpacity(el) {
  let op = 1
  let cur = el
  let depth = 0
  while (cur && depth < 40) {
    let cs = null
    try { cs = getComputedStyle(cur) } catch (err) { cs = null }
    if (cs) {
      const v = Number(cs.opacity)
      if (Number.isFinite(v)) {
        op *= v
        if (op < 0.05) return op
      }
      // 祖先被 display:none 时，后代 getComputedStyle 也会是 none，无需额外处理
      if (cs.display === 'none') return 0
      if (cs.visibility === 'hidden') return 0
    }
    cur = cur.parentElement
    depth++
  }
  return op
}

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
  if (cs.display === 'none' || cs.visibility === 'hidden') return null
  if (cs.pointerEvents !== 'auto' && cs.pointerEvents !== 'all') return null
  if (effectiveOpacity(el) < 0.05) return null
  return r
}

// ── 弹出层选择器清单 ────────────────────────────────────────────────────────
// 挂件的面板/遮罩**不在 .dshwv-root 子树里**，而是 position:fixed 挂在 body 上。
// 清单来自对挂件源码（whale-widget.js）的逐条核对，把所有
// `xxxMask.className='...'` 与 `style.display='none'/'flex'` 的对象都对了一遍：
//
//   遮罩：cropmask / gifmask / resmask / audiomask / bubmask / snapmask /
//         confirmmask / usage-mask
//         （多个变量复用同类名：audioCropMask·audioEditMask→audiomask、
//           bubbleItemMask·moduleMask→bubmask、moduleNamePromptMask→confirmmask、
//           usageMoreMask→usage-mask ⇒ 类名清单即全集）
//   面板：qedit / usage-sub
//   列表/菜单：menu / rolelist / audiolist / slotlist / colpop / rgbmenu
//
// ⚠️ 不要把 .dshwv-*-win 放进来：那是遮罩内部卡片，CSS 里没有 display:none，
//    常驻 DOM、显隐完全靠父遮罩 ⇒ 加进来会让热点窗**永久展开**。
const OVERLAY_SEL = [
  '.dshwv-cropmask', '.dshwv-gifmask', '.dshwv-resmask', '.dshwv-audiomask',
  '.dshwv-bubmask', '.dshwv-snapmask', '.dshwv-confirmmask', '.dshwv-usage-mask',
  '.dshwv-usage-sub', '.dshwv-qedit',
  '.dshwv-colpop', '.dshwv-rgbmenu',
  '.dshwv-rolelist', '.dshwv-audiolist', '.dshwv-slotlist',
  '.dshwv-menu',
].join(',')

// ── 弹出层可见性 ────────────────────────────────────────────────────────────
// 只认「computed display !== 'none'」这一条决定性信号 —— 它同时覆盖
// 内联 style、-open 类、CSS 规则三种来源，不用为每种机制各写一套启发式。
// 再叠加 opacity + rect 过滤掉"display 有但根本没显出来"的中间态。
//
// 为什么不能只靠 opacity 阈值：.dshwv-menu 是 opacity 过渡显隐（0.22s），
// 过渡中途 opacity≈0.4 会被任何低阈值判成"开着"，于是开→关→开地抖。
// 这里要求 opacity 达到 0.9（近乎完全不透明）才算真的开。
function popupRect(el) {
  if (!el || !el.isConnected) return null
  let cs = null
  try { cs = getComputedStyle(el) } catch (err) { return null }
  if (!cs) return null
  if (cs.display === 'none') return null
  if (cs.visibility === 'hidden') return null
  if (effectiveOpacity(el) < 0.9) return null
  let r = null
  try { r = el.getBoundingClientRect() } catch (err) { return null }
  if (!r || r.width < 1 || r.height < 1) return null
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null
  return r
}

// ── 鲸鱼本体的「落点盒」────────────────────────────────────────────────────
// 关键：**绝不读过渡中的 getBoundingClientRect**。
// .dshwv-root{transition:left .16s,top .16s,transform .3s}，过渡期间 rect 返回
// 的是插值位置，热点窗会追着一个 160~300ms 的移动目标跑 —— 这就是
// 「鼠标动就闪、停下就静」的根因（用户录屏已复现）。
// 内联 style.left/top 是**过渡目标值**（稳定），offsetWidth/Height 是布局值
// （不受 transition 影响），两者组合即落点盒。
function rootBox(root) {
  if (!root) return null
  let left = null
  try { left = parseFloat(root.style.left) } catch (err) { left = null }
  let top = null
  try { top = parseFloat(root.style.top) } catch (err) { top = null }
  const w = root.offsetWidth
  const h = root.offsetHeight
  if (!isFinite(left) || !isFinite(top) || !(w > 0) || !(h > 0)) {
    // 还没被摆过（首次）或读不到内联值 → 退回 rect，但这是罕见路径
    let r = null
    try { r = root.getBoundingClientRect() } catch (err) { return null }
    if (!r || r.width < 1 || r.height < 1) return null
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }
  return { left, top, right: left + w, bottom: top + h, width: w, height: h }
}

function interactiveRect() {
  let root = null
  try { root = document.querySelector('.dshwv-root') } catch (err) { root = null }
  const rb = rootBox(root)

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (r) => {
    if (!r) return
    if (r.left < x1) x1 = r.left
    if (r.top < y1) y1 = r.top
    if (r.right > x2) x2 = r.right
    if (r.bottom > y2) y2 = r.bottom
  }

  // ① 鲸鱼本体（落点盒）
  add(rb)

  // ② 显式并入「可见的弹出层」
  //    这一步是「面板点不动」的正解：面板几何必须直接进并集，
  //    不能指望别的通路抢先扩窗来覆盖它。
  let pops = []
  try { pops = document.querySelectorAll(OVERLAY_SEL) } catch (err) { pops = [] }
  for (let i = 0; i < pops.length; i++) add(popupRect(pops[i]))

  if (!isFinite(x1) || x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

// ── 死区（dead-band）───────────────────────────────────────────────────────
// 即便已改用落点盒，边缘吸附/面板开合之间的重排仍会有几像素噪声。
// 变化小于阈值时**沿用上次上报的矩形**，别让这点噪声走到主进程的 setBounds。
// 这与 main.js 的 HOT_POS_EPS/HOT_SIZE_EPS 是**两级过滤**：
//   这里挡掉页面侧的采样噪声，main.js 那边挡掉窗口侧的舍入/过渡噪声。
const DB_POS = 6      // 四边位移累计在 6px 内 → 沿用
const DB_SIZE = 24    // 尺寸变化在 24px 内 → 沿用
function stabilizeRect(r) {
  if (!r) { stableRect = null; return null }
  if (!stableRect) { stableRect = r; return r }
  const dp = Math.max(
    Math.abs(r.x - stableRect.x),
    Math.abs(r.y - stableRect.y),
  )
  const ds = Math.max(
    Math.abs(r.w - stableRect.w),
    Math.abs(r.h - stableRect.h),
  )
  if (dp <= DB_POS && ds <= DB_SIZE) return stableRect
  stableRect = r
  return r
}

function reportRect() {
  if (mode !== 'hot') return
  const r = stabilizeRect(interactiveRect())
  // 出屏部分不报（主进程会再裁一次）；这里只上报原始页面坐标
  const key = r
    ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    : 'none'
  if (key === lastKey) return
  lastKey = key
  try { ipcRenderer.send('dshw:hot-rect', r) } catch (err) {}
}

function startRectLoop() {
  if (rectTimer) return
  // 200ms 足够跟上拖动/四边吸附；挂件本身的位置变化不会比这更快
  rectTimer = setInterval(reportRect, 200)
  window.addEventListener('resize', reportRect)
  window.addEventListener('scroll', reportRect, true)
  // 挂件被 SPA 摘掉又重挂、或切换角色/尺寸时也能及时更新
  try {
    const mo = new MutationObserver(() => reportRect())
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
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
  stableRect = null          // 死区缓存随模式切换复位，避免带着旧基准回来
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
