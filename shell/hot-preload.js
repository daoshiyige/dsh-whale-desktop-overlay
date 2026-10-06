// ============================================================================
// dshw-desktop-overlay —— 热点窗 preload
// ============================================================================
// 这个窗口存在的唯一理由：**在不切换全屏窗口穿透状态的前提下**把真实鼠标交给鲸鱼。
//
// 为什么必须绕这一圈（issue：点鲸鱼会把 B 站视频点黑）：
//   旧做法是在全屏透明窗口上做命中测试，指针压到鲸鱼时调 setIgnoreMouseEvents(false)。
//   那一步会摘掉窗口的 WS_EX_TRANSPARENT 扩展样式，于是浏览器（Chrome/Edge）的
//   「窗口遮挡检测」不再把这个窗口当作透明窗口，判定自己被**完全遮挡** → 停止绘制、
//   丢掉硬件视频通路 → 视频变黑；只有点一下浏览器恢复前台才会重新绘制。
//
// 现在：全屏窗口永远保持穿透、永不改样式、永不激活（focusable:false）；
//   这个热点窗只在鲸鱼的包围盒上（几百像素见方），它始终可接收鼠标、且 focusable:false
//   （WS_EX_NOACTIVATE，点了不会抢前台，浏览器不会失去前台地位）。
//   浏览器最多看到一块小窗口压在自己身上 → 不会被判定为完全遮挡 → 视频照常播。
//
// 事件转给主进程后，主进程用 webContents.sendInputEvent 把鼠标合成到主窗口里，
// 于是鲸鱼的拖动/点击/悬停全部按原样工作（注入的是可信事件，pointer 事件也会被派生）。
// ============================================================================

const { ipcRenderer, contextBridge } = require('electron')

let pendingMove = null
let rafGate = false

const buttonName = (b) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

function modsOf(e) {
  const m = []
  if (e.shiftKey) m.push('shift')
  if (e.ctrlKey) m.push('control')
  if (e.altKey) m.push('alt')
  if (e.metaKey) m.push('meta')
  return m
}

function emit(type, e, extra) {
  const payload = {
    type,
    x: Math.round(e.clientX || 0),
    y: Math.round(e.clientY || 0),
    button: buttonName(e.button),
    clickCount: 1,
    modifiers: modsOf(e),
  }
  if (extra) Object.assign(payload, extra)
  try { ipcRenderer.send('dshw:hot-input', payload) } catch (err) {}
}

function flushMove() {
  rafGate = false
  const e = pendingMove
  pendingMove = null
  if (e) emit('mouseMove', e)
}

// —— 鼠标 ——
// 移动按帧合并：拖动鲸鱼时每秒可能上百条，没必要原样转发。
window.addEventListener('mousemove', (e) => {
  pendingMove = e
  if (rafGate) return
  rafGate = true
  requestAnimationFrame(flushMove)
}, true)

window.addEventListener('mousedown', (e) => {
  emit('mouseDown', e, { clickCount: Math.max(1, e.detail || 1) })
}, true)

window.addEventListener('mouseup', (e) => {
  emit('mouseUp', e, { clickCount: Math.max(1, e.detail || 1) })
}, true)

window.addEventListener('mouseenter', (e) => emit('mouseEnter', e), true)
window.addEventListener('mouseleave', (e) => emit('mouseLeave', e), true)

window.addEventListener('wheel', (e) => {
  emit('mouseWheel', e, { deltaX: e.deltaX || 0, deltaY: e.deltaY || 0 })
}, { capture: true, passive: true })

// 热点窗自身不出菜单、不参与拖放
window.addEventListener('contextmenu', (e) => { try { e.preventDefault() } catch (err) {} }, true)
window.addEventListener('dragstart', (e) => { try { e.preventDefault() } catch (err) {} }, true)

// 自检用：让主进程可以「在热点窗的 DOM 里」造一条事件，验证转发链路
// （真实鼠标投递由 shell/selftest 用系统级光标移动来验，这里只覆盖后半段）
contextBridge.exposeInMainWorld('__dshwHot', {
  inject: (type, x, y, button, extra) => {
    const fake = {
      clientX: x, clientY: y,
      button: button === 'right' ? 2 : button === 'middle' ? 1 : 0,
      detail: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    }
    emit(type, fake, extra || {})
    return true
  },
  ready: true,
})
