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

// 诊断探针开关（排查用；主进程通过 DSHW_PROBE=1 打开）
const PROBE = process.env.DSHW_PROBE === '1'

// ---------------------------------------------------------------------------
// hot 模式：上报可交互区域
// ---------------------------------------------------------------------------
let lastKey = ''
let rectTimer = null
let probeTimer = null

// ---------------------------------------------------------------------------
// 统一的 opacity 滞后判定（elVisible 与 popupVisible 共用，绝不能各写一套）
// ---------------------------------------------------------------------------
// ⚠️ opacity 的判定必须**滞后（latch）**，不能每次读数直接比较阈值。
//    .dshwv-menu 是 `opacity:0 + transition:opacity .22s` 显隐的，面板刚点开时
//    opacity 会从 0 一路爬到 1，中途必然穿过任何阈值。若直接拿阈值比较：
//      · 阈值 0.9 → 面板已"看起来开着"的前 0.2s 被误判为关 → 上报小矩形
//      · 阈值 0.05 → 关闭动画期间又误判为开 → 上报大矩形
//    两个方向都会让「上报的矩形」抖动 → 鼠标移动时高频触发 → 肉眼看到的闪动。
//    所以维护一张 WeakMap：
//      关→开：opacity 一旦 >= OP_ON(0.5) 就立刻记成开（宁可早，点击不丢）
//      开→关：必须连续 LATCH_STRIKES_NEEDED 次读到 opacity <= OP_OFF(0.1) 才记成关
//    中间地带维持上次判定、不翻转 —— 这是消抖的关键。
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

// ⚠️ elVisible 与 popupVisible 必须**共用同一套可见性判据**，否则会出现这种撕裂：
//   interactiveRect() 认为「菜单可见」把它算进并集 → 上报菜单大小的矩形；
//   而 hasOpenPopup() 认为「菜单不可见」→ expanded 保持 false → reportRect 不让路。
//   结果就是「上报的矩形自己在 菜单大小 ↔ 鲸鱼大小 之间来回跳」——
//   鼠标移动时高频触发，就是用户看到的「移动时快速闪动、静止后不动」。
//
//   所以本函数只做**几何 + 硬性不可见**判断（display / visibility / pointer-events），
//   **不再自己判 opacity 阈值**；opacity 交给统一的 opacityAllows() 处理。
//   （历史上这里是 opacity<0.05，而 popupVisible 是 latch 的 0.5 —— 两边不一致就是 bug 源头。）
//
// ⚠️⚠️ 还有一类**鼠标驱动的抖源**必须挡掉：`.dshwv-menu-btn`。
//   它的 CSS 是 `opacity:0; transition:opacity .15s` + `.dshwv-menu-btn-visible{opacity:1}`，
//   而挂件里有一行 `menuBtn.classList.toggle('dshwv-menu-btn-visible', over || menuOpen || ...)`
//   —— `over` 就是「鼠标是否悬停在鲸鱼上」。于是：
//     鼠标一动 → over 翻转 → menuBtn 的 opacity 在 0↔1 之间反复 → 它进出可见集合
//     → 上报的矩形宽高跟着跳 → 热点窗 setBounds 抖动 → 肉眼看到快速闪动。
//     鼠标停住 → over 稳定 → 不跳了。**这与你描述的「移动时闪动、静止后不动」完全吻合。**
//   这个按钮的位置在鲸鱼包围盒**内部**，把它算进并集对可用性毫无增益（包围盒已经覆盖它），
//   所以直接把「hover 驱动显隐的小装饰件」整类排除，而不是去猜它的 opacity。
const HOVER_DECOR_SEL = '.dshwv-menu-btn'

function isHoverDecor(el) {
  try { return !!el.closest(HOVER_DECOR_SEL) } catch (err) { return false }
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
  if (cs.pointerEvents === 'none') return null
  return r
}

// 统一入口：元素是否为「鲸鱼本体」上可交互的部件（用于 root 子树扫描）。
// 保留 pointer-events 严格要求（只有 auto/all 才接事件），并复用同一套 opacity 判据。
function elInteractive(el) {
  if (isHoverDecor(el)) return null
  const r = elVisible(el)
  if (!r) return null
  let cs = null
  try { cs = getComputedStyle(el) } catch (err) { return r }
  if (!cs) return r
  if (cs.pointerEvents !== 'auto' && cs.pointerEvents !== 'all') return null
  if (!opacityAllows(el, cs)) return null
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

// ⚠️⚠️⚠️ 最关键的抖源（实测日志抓到）：`.dshwv-root` 自身带 CSS 过渡
//     .dshwv-root{ ... transition:left .16s ease,top .16s ease,transform .3s ease }
//   而挂件在 hover / 重排 / 吸附时会改 `root.style.left/top`。
//   **`getBoundingClientRect()` 在过渡进行中返回的是「正在移动的插值位置」**，
//   所以只要拿 root 的 rect 去算并集，热点窗就会跟着一个 160~300ms 的移动目标跑。
//   实测日志（鼠标在鲸鱼上移动时）：
//     176,154 → 177,144 → 178,138 → 176,154   ← y 866→876→882→866，height 154→144→138→154
//   三点一个来回、鼠标停住就停 —— 与用户描述完全一致。
//
//   解法：root 的落点盒 = **内联 style.left/top（过渡目标值，稳定）+ offsetWidth/Height（布局值）**。
//   ⚠️ 绝不能叠加 transform / 不能读 rendered rect —— 那正是动画中间态。
//
//   ⚠️ 也**不要**去扫 root 子树：子树元素全是会动的装饰（呼吸、悬浮、菜单按钮），
//      而且它们的 offsetLeft/offsetTop 是相对 offsetParent 的，混进视口坐标系会算歪
//      （实测扫子树会把并集炸到 1607×919 ≈ 整个视口）。
//      root 本身就是一个覆盖鲸鱼全体的方形，它的落点盒已经足够。
function rootBox(root) {
  if (!root) return null
  const w = root.offsetWidth || root.clientWidth
  const h = root.offsetHeight || root.clientHeight
  if (!w || !h) return null
  // 位置：内联 style 优先（挂件就是用它定位的，且这是过渡的目标值，不抖）
  let left = NaN
  let top = NaN
  try {
    const sl = root.style && root.style.left
    const st = root.style && root.style.top
    if (sl && sl !== 'auto') left = parseFloat(sl)
    if (st && st !== 'auto') top = parseFloat(st)
  } catch (err) {}
  // 退化：直接读渲染矩形（会含动画中间态，但只在拿不到 inline style 时发生）
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    try {
      const b = root.getBoundingClientRect()
      left = b.left
      top = b.top
    } catch (err) { return null }
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  const r = { left, top, right: left + w, bottom: top + h, width: w, height: h }
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null
  return r
}

// ---------------------------------------------------------------------------
// ⭐ 面板几何：必须让热点窗**盖住面板**，否则面板点不动
// ---------------------------------------------------------------------------
// 实测（本机 1707×1019 工作区，鲸鱼贴右下角）：
//     落点盒 y=770~1020        （鲸鱼本体，250×250）
//     设置面板 y=565~865       （242×300 —— position:fixed 挂在 body 上）
//     热点窗   y=756~1034      （= 落点盒 + padding 14）
//   ⇒ 面板顶边 565 到 756 这 **191px 完全没有任何窗口**接收鼠标，
//     面板只有底部的 109px（36%）能点 —— 用户看到的「无法点击」。
//
//  根本原因：面板是 `position:fixed` 挂在 **body** 上（源码 positionMenu() 里
//  `menuBox.style.bottom = vp.h - assetTop + 6`），它的定位基准是视口，
//  而挂件贴在屏幕右下角时面板必然**向上展开**、整个落在鲸鱼包围盒之外。
//
//  历史包袱：曾经靠「扫 root 子树」意外把面板并进了并集（子树里的节点 rect
//  恰好覆盖了面板），但那个做法会把并集炸到整个视口（见下方说明），
//  所以上一轮把它删掉了 —— 面板随之变得点不动。这是本次修复要补回来的东西。
//
//  正确做法：**显式把可见弹出层的矩形并进来**（interactiveRect 第 ② 步已经在做），
//  并且**不要**依赖 expanded 抢先扩窗独自承担（它只覆盖"面板弹出的那一瞬"，
//  且会被 6s 阈值 / 收起防抖影响）。让「上报矩形」这条常规通路自己就包含面板。
// ---------------------------------------------------------------------------

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

  // ① 挂件本体：只取 root 的**落点盒**（稳定、不抖），不扫子树（见上方说明）
  add(rootBox(root))

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
    for (let k = 0; k < kcap; k++) add(elInteractive(kids[k]))
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
  //
  // ⚠️⚠️ 但这个让路有一个致命前提：**expanded 必须真的代表「主进程那边也扩了」**。
  //    expanded 是从本页发出的（setExpanded → ipc），主进程收到才扩窗。如果主进程那边
  //    因为 drag / 热点窗不可用等原因**拒绝了扩窗**，本页却已经把 expanded 置 true，
  //    那么 reportRect 会永久让路 ⇒ 一次矩形都不再上报 ⇒ 热点窗停在旧位置 ⇒
  //    「整个鲸鱼都点不动」（实测事故：hotUpdates 卡在 1、hotEvents=0）。
  //    所以这里加一道**兜底心跳**：即使处于 expanded 态，也至少每 EXPIRE_MS 上报一次
  //    真实矩形，保证主进程永远能靠常规通路自愈。
  if (expanded) {
    const now = Date.now()
    if (now - lastReportAt < EXPANDED_KEEPALIVE_MS) return
    lastReportAt = now
    const rk = interactiveRect()
    if (rk) {
      lastKey = ''
      stableRect = null
      const r = stabilizeRect(rk)
      lastKey = r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}` : 'none'
      try { ipcRenderer.send('dshw:hot-rect', r) } catch (err) {}
    }
    return
  }
  const raw = interactiveRect()
  // 诊断（排查抖动时用）：把原始矩形也记下来，看清是谁在跳
  try {
    const rk = raw ? `${Math.round(raw.x)},${Math.round(raw.y)},${Math.round(raw.w)},${Math.round(raw.h)}` : 'none'
    if (rk !== lastRawKey) {
      const prev = lastRawKey
      lastRawKey = rk
      if (raw && prev !== '' && prev !== 'none') {
        const p = prev.split(',').map(Number)
        const d = Math.max(Math.abs(raw.x - p[0]), Math.abs(raw.y - p[1]), Math.abs(raw.w - p[2]), Math.abs(raw.h - p[3]))
        if (d >= 6) ipcRenderer.send('dshw:log', `rawrect ${prev} → ${rk} (Δ${Math.round(d)})`)
      }
    }
  } catch (err) {}
  const r = stabilizeRect(raw)
  // 出屏部分不报（主进程会再裁一次）；这里只上报原始页面坐标
  const key = r
    ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    : 'none'
  if (key === lastKey) return
  lastKey = key
  try { ipcRenderer.send('dshw:hot-rect', r) } catch (err) {}
}
let lastRawKey = ''
// expanded 态下的兜底上报节奏（见 reportRect 开头说明）
const EXPANDED_KEEPALIVE_MS = 1200
let lastReportAt = 0

// 矩形死区（dead-band）：即便已经改用布局值，边缘吸附/重排仍会有几像素变化。
// 只要变化小于阈值就**沿用上次上报的矩形**，不让这点噪声走到主进程的 setBounds。
//
// 规则：
//   · 四条边位移都在 DEADBAND 像素内 → 不更新（沿用旧值）
//   · 任一边超过 DEADBAND → 立刻更新（真实的移动/缩放要跟手）
//   · 但若「尺寸」变化超过 SIZE_JUMP，说明是面板开/关这种结构性变化 → 立刻更新
const DEADBAND = 6
const SIZE_JUMP = 24
let stableRect = null

function stabilizeRect(r) {
  if (!r) { stableRect = null; return null }
  if (!stableRect) { stableRect = { ...r }; return stableRect }
  const dLeft = Math.abs(r.x - stableRect.x)
  const dTop = Math.abs(r.y - stableRect.y)
  const dRight = Math.abs((r.x + r.w) - (stableRect.x + stableRect.w))
  const dBottom = Math.abs((r.y + r.h) - (stableRect.y + stableRect.h))
  const dW = Math.abs(r.w - stableRect.w)
  const dH = Math.abs(r.h - stableRect.h)
  // 结构性变化（面板开/关、尺寸档位切换）：立刻采纳
  if (dW >= SIZE_JUMP || dH >= SIZE_JUMP) { stableRect = { ...r }; return stableRect }
  // 四条边的位移都在死区内 → 认为没变，沿用旧矩形（消抖核心）
  if (dLeft < DEADBAND && dTop < DEADBAND && dRight < DEADBAND && dBottom < DEADBAND) {
    return stableRect
  }
  stableRect = { ...r }
  return stableRect
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
      // 收窗后 lastKey / stableRect 都必须失效，否则 reportRect 会以为「矩形没变」而不补报
      lastKey = ''
      stableRect = null
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

// ---------------------------------------------------------------------------
// 诊断探针（只在 DSHW_PROBE=1 时启用）
// ---------------------------------------------------------------------------
// 目的：把「谁是矩形贡献者」这件事变成可读数据，而不是靠猜。
//   每个 tick 记录：root 落点盒、菜单实测盒、本轮上报盒，
//   以及菜单是否**落在 root 盒之外**（那就是「面板点不动」的几何证据）。
function probeTick() {
  if (!PROBE) return
  try {
    const root = document.querySelector('.dshwv-root')
    const rb = rootBox(root)
    const menu = document.querySelector('.dshwv-menu')
    let mb = null
    let mOpen = null
    if (menu) {
      try { const b = menu.getBoundingClientRect(); mb = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } } catch (err) {}
      try { mOpen = menu.classList.contains('dshwv-menu-open') } catch (err) {}
    }
    const outside = (rb && mb)
      ? (mb.x < rb.left - 1 || mb.y < rb.top - 1 || mb.x + mb.w > rb.right + 1 || mb.y + mb.h > rb.bottom + 1)
      : null
    ipcRenderer.send('dshw:probe', {
      raw: lastRawKey,
      stable: stableRect,
      expanded,
      openPopup: hasOpenPopup(),
      rootBox: rb ? { x: Math.round(rb.left), y: Math.round(rb.top), w: Math.round(rb.width), h: Math.round(rb.height) } : null,
      menu: mb,
      menuOpen: mOpen,
      menuOutsideRoot: outside,
    })
  } catch (err) {}
}

function startRectLoop() {
  if (rectTimer) return
  // 200ms 足够跟上拖动/四边吸附；挂件本身的位置变化不会比这更快
  rectTimer = setInterval(sync, 200)
  if (PROBE && !probeTimer) probeTimer = setInterval(probeTick, 250)
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
  stableRect = null
  // ⚠️ 必须连同 expanded / 收起防抖一起复位：
  //    切走再切回时若还留着 expanded=true，reportRect 会（在 keepalive 生效前）
  //    继续让路，而主进程那边热点窗是重建的、并没有处于扩窗态 —— 两边状态撕裂，
  //    表现就是「切回 hot 模式后热点窗永远停在初始位置、点不动」。
  expanded = false
  collapseStrikes = 0
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
  lastReportAt = 0
  if (mode === 'hot') {
    startRectLoop()
    sync()
  } else {
    if (rectTimer) { clearInterval(rectTimer); rectTimer = null }
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
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
  // 诊断：列出当前「被算进并集」的元素，用来定位矩形是谁贡献的
  diagnose: () => {
    const out = []
    let root = null
    try { root = document.querySelector('.dshwv-root') } catch (err) {}
    if (root) {
      let nodes = []
      try { nodes = root.querySelectorAll('*') } catch (err) {}
      for (let i = 0; i < nodes.length && i < 600; i++) {
        const r = elInteractive(nodes[i])
        if (!r) continue
        const cls = (nodes[i].className && String(nodes[i].className)) || ''
        out.push({ cls: cls.slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
    let pops = []
    try { pops = document.querySelectorAll(OVERLAY_SEL) } catch (err) {}
    for (let i = 0; i < pops.length; i++) {
      if (!popupVisible(pops[i])) continue
      const b = pops[i].getBoundingClientRect()
      out.push({ cls: 'POPUP:' + String(pops[i].className).slice(0, 50), x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) })
    }
    try { ipcRenderer.send('dshw:log', 'DIAG ' + JSON.stringify({ rect: interactiveRect(), expanded, n: out.length, items: out.slice(0, 40) })) } catch (err) {}
    return out
  },
})
