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
//
// 取值来自挂件源码实证（把所有 `xxxMask.className = '...'` 与 `style.display='flex'` 的对象都对了一遍）：
//   · 遮罩：cropmask / gifmask / resmask / audiomask / bubmask / snapmask / confirmmask / usage-mask
//     —— 多个变量复用同一类名（audioCropMask→audiomask、audioEditMask→audiomask、
//     bubbleItemMask·moduleMask→bubmask、moduleNamePromptMask→confirmmask、usageMoreMask→usage-mask），
//     所以类名清单就是全集，不用再枚举变量。
//   · 小浮层：qedit(26000) / usage-sub（usage 面板里展开的明细层）
//   · 列表/菜单：menu(10000) rolelist·audiolist(10001) slotlist(20600) colpop(30) rgbmenu(60)
//
// ⚠️ **不要**把 .dshwv-*-win 加进来：那些是遮罩内部的卡片，CSS 里没有 display:none，
//    显隐完全靠父遮罩。它们常驻 DOM，加进来会让热点窗**永久展开**。
//
// ⚠️ 每种元素的显隐机制并不统一，所以判定必须靠 display，不能靠 rect/opacity 猜：
//   · 遮罩类：**常驻 DOM**，`style.display='none'/'flex'` 直接切（源码里 73 处 none、36 处 flex）
//   · 列表类（rolelist/audiolist/slotlist/rgbmenu）：CSS 里 `display:none`，靠 `-open` 类切 `display:block`
//   · 菜单 .dshwv-menu：常驻、`opacity:0` + `pointer-events:none`，靠 opacity 过渡显示
//   · qedit / usage-sub：`style.display` 直控，动态增删
// 统一收敛到「computed display !== 'none'」这一条：它同时覆盖内联 style、类、CSS 三种来源。
const OVERLAY_SEL = [
  '.dshwv-cropmask', '.dshwv-gifmask', '.dshwv-resmask', '.dshwv-audiomask',
  '.dshwv-bubmask', '.dshwv-snapmask', '.dshwv-confirmmask', '.dshwv-usage-mask',
  '.dshwv-usage-sub', '.dshwv-qedit', '.dshwv-colpop', '.dshwv-rgbmenu',
  '.dshwv-rolelist', '.dshwv-audiolist', '.dshwv-slotlist', '.dshwv-menu',
].join(',')

// 纯类名版本（去掉点号），给 transitionend 兜底做 classList.contains 用
const OVERLAY_CLASSES = OVERLAY_SEL.split(',').map((s) => s.trim().slice(1))

// 只认「自己」的 display，不看祖先 —— 否则面板套在 root 里时会被 root 的状态干扰。
// 祖先链上有 display:none 的话 getComputedStyle 自己也会是 none，无需额外判断。
//
// ⚠️ opacity 的判定必须**滞后（latch）**，不能每次读数直接比较阈值。
//    .dshwv-menu 是 `opacity:0 + transition:opacity .22s` 显隐的，面板刚点开时
//    opacity 会从 0 一路爬到 1，中途必然穿过任何阈值。若直接拿阈值比较：
//      · 阈值 0.9 → 面板已"看起来开着"的前 0.2s 被误判为关 → 上报小矩形 → 缩窗
//      · 阈值 0.05 → 关闭动画期间又误判为开 → 上报大矩形 → 扩窗
//    两个方向都会造成「扩/缩来回切」。所以维护一张 WeakMap：
//      关→开：opacity 一旦 >= OP_ON(0.5) 就立刻记成开（宁可早，点击不丢）
//      开→关：必须连续 latchStrikes 次读到 opacity <= OP_OFF(0.1) 才记成关
//    （配合外层 syncExpand 的三重收窗防抖，双保险。）
const OP_ON = 0.5
const OP_OFF = 0.1
const LATCH_STRIKES_NEEDED = 3
const opLatch = new WeakMap()   // el -> { on:boolean, low:number }

function opacityAllows(el, cs) {
  if (!cs || cs.opacity === '' || cs.opacity === undefined) return true
  const op = Number(cs.opacity)
  if (!Number.isFinite(op)) return true
  const st = opLatch.get(el) || { on: false, low: 0 }
  if (op <= OP_OFF) {
    st.low++
    // 连续多次都低才是真的关了；只有一次低（过渡首帧/父级动画）不算
    if (st.on && st.low < LATCH_STRIKES_NEEDED) { opLatch.set(el, st); return st.on }
    st.on = false
    opLatch.set(el, st)
    return false
  }
  if (op >= OP_ON) {
    st.on = true
    st.low = 0
    opLatch.set(el, st)
    return true
  }
  // 中间地带（0.1 ~ 0.5）：维持上一次判定，不翻转 —— 这是消抖的关键
  opLatch.set(el, st)
  return st.on
}

function popupVisible(el) {
  if (!el || !el.isConnected) return false
  let cs = null
  try { cs = getComputedStyle(el) } catch (err) { return false }
  if (!cs) return false
  // ① 决定性信号：display
  if (cs.display === 'none') return false
  // ② visibility:hidden 明确不可交互
  if (cs.visibility === 'hidden') return false
  // ③ opacity 过渡元素：滞后判定（见上方说明）
  if (!opacityAllows(el, cs)) return false
  // ④ 有实际面积（排除 0 尺寸的占位节点）
  let r = null
  try { r = el.getBoundingClientRect() } catch (err) { return false }
  if (!r || r.width < 1 || r.height < 1) return false
  // ⑤ 完全在视口外的不算（离屏占位）
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false
  return true
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
//
// 状态声明放在 reportRect 之前 —— reportRect 要读 expanded 来让路（见其内部注释）。
let expanded = false
let collapseTimer = null
// 收窗防抖：单次「读到关」不算数，必须连续 N 次都关才收。
// 面板关闭往往伴随一小段 DOM 抖动（面板节点被移除 / 遮罩 display 切换），
// 单次读数很容易瞬时为 false —— 这就是「鼠标在按钮上移动时模式来回切」的成因。
let collapseStrikes = 0
const COLLAPSE_STRIKES_NEEDED = 3
const COLLAPSE_DELAY = 900

function reportRect() {
  if (mode !== 'hot') return
  // ⚠️ 关键竞态修复：面板刚打开时（.dshwv-menu 的 opacity 还在 0.22s 过渡中途），
  //    interactiveRect() 会暂时只算到鲸鱼本体 → 上报小矩形 → 主进程 applyHotRect 缩窗；
  //    等过渡结束才又上报大矩形 → syncExpand 扩窗。一来一回就是用户看到的「抖」。
  //
  //    所以：**只要已判定为「扩窗态」，就不再上报小矩形**，由 applyHotExpand 全权掌尺寸；
  //    等面板真的关掉（syncExpand 收窗）之后，reportRect 才会重新接管。
  //    这跟 main.js 里 `if (hotState.expanded) return` 是一对镜像，两边互斥、方向一致。
  if (expanded) return
  const r = interactiveRect()
  // 出屏部分不报（主进程会再裁一次）；这里只上报原始页面坐标
  const key = r
    ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    : 'none'
  if (key === lastKey) return
  lastKey = key
  try { ipcRenderer.send('dshw:hot-rect', r) } catch (err) {}
}

function hasOpenPopup() {
  let pops = []
  try { pops = document.querySelectorAll(OVERLAY_SEL) } catch (err) { return false }
  for (let i = 0; i < pops.length; i++) {
    if (popupVisible(pops[i])) return true
  }
  return false
}

// ⚠️ 第二个抖动源：热点窗接收真实鼠标 → 经主窗合成回页面 → 挂件的 :hover 态改 class
//   → mo2 又触发 sync()。面板没开时它只是白跑计算（有缓存短路，无害），
//   但「面板正开着、鼠标悬停面板内元素」时会高频触发 → 高频查 popupVisible。
//   用 60ms 节流把这件事压掉：面板开/关本身是低频的，节流不影响体验。
let syncAt = 0
let syncPending = null
function syncThrottled() {
  const now = Date.now()
  if (now - syncAt >= 60) { syncAt = now; sync(); return }
  if (syncPending) return
  syncPending = setTimeout(() => { syncPending = null; syncAt = Date.now(); sync() }, 60)
}

function setExpanded(on) {
  if (on === expanded) return
  expanded = on
  try { ipcRenderer.send('dshw:hot-expand', on) } catch (err) {}
}

// 由 DOM 变化 / 轮询驱动。
//   开：任何一次读到「有面板」→ 立刻扩（宁可早，晚了第一下点击就丢）
//   关：连续 COLLAPSE_STRIKES_NEEDED 次都读到「无面板」，且距上次「有面板」超过
//       COLLAPSE_DELAY，才真的收（防抖动 / 防面板切换之间的瞬时空档）
function syncExpand() {
  if (mode !== 'hot') return
  const open = hasOpenPopup()
  if (open) {
    collapseStrikes = 0
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
    setExpanded(true)
    return
  }
  if (!expanded) return
  collapseStrikes++
  if (collapseStrikes < COLLAPSE_STRIKES_NEEDED) return
  if (collapseTimer) return
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    // 定时器到点时再复核一次：期间又开了就作废
    if (!hasOpenPopup() && collapseStrikes >= COLLAPSE_STRIKES_NEEDED) {
      collapseStrikes = 0
      setExpanded(false)
      // 收窗后 lastKey 必须失效，否则 reportRect 会以为「矩形没变」而不补报
      lastKey = ''
      reportRect()
    }
  }, COLLAPSE_DELAY)
}

// 统一入口：**先裁决扩/收窗，再报矩形**。
//   顺序至关重要：reportRect 内部会 `if (expanded) return` 让路，
//   所以必须让 syncExpand 先跑，才能在「面板刚开」的同一拍就把它挡掉。
function sync() {
  syncExpand()
  reportRect()
}

function startRectLoop() {
  if (rectTimer) return
  // 200ms 足够跟上拖动/四边吸附；挂件本身的位置变化不会比这更快
  rectTimer = setInterval(sync, 200)
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)
  // 挂件被 SPA 摘掉又重挂、或切换角色/尺寸时也能及时更新
  try {
    const mo = new MutationObserver(() => sync())
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    // 面板开/关要立刻反映（不能等 200ms 轮询）：面板本身在 body 下、靠 class 切换显隐
    const mo2 = new MutationObserver(() => syncThrottled())
    mo2.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  } catch (err) {}
  // opacity 过渡（.dshwv-menu 的 .22s）结束时**不会有 MutationObserver 回调**，
  // 所以再挂一个 transitionend 兜底：过渡一结束立刻重裁一次。
  try {
    document.addEventListener('transitionend', (e) => {
      let t = e && e.target
      if (!t || !t.classList) return
      // 只关心我们选择器里的那几类
      for (let i = 0; i < OVERLAY_CLASSES.length; i++) {
        if (t.classList.contains(OVERLAY_CLASSES[i])) { syncThrottled(); return }
      }
    }, true)
  } catch (err) {}
  setTimeout(sync, 120)
  setTimeout(sync, 800)
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
    sync()
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
