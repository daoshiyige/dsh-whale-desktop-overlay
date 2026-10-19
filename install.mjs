#!/usr/bin/env node
// ============================================================================
// dshw-desktop-overlay —— 安装 / 卸载 / 体检
// ============================================================================
//   node install.mjs                 安装（部署文件 + 给插件 lib/index.js 打补丁）
//   node install.mjs --status        体检（只看，不改）
//   node install.mjs --uninstall     还原（剥掉补丁 + 删掉部署的文件）
//   node install.mjs --dry-run       只打印将要做的改动
//
// 补丁是「标记式」的：A/B/C 三段各有一对 begin/end 标记，
// 重复执行只会替换自己那几行，不会叠加；卸载时按标记精确剥离。
// 这样 dsh plugin update 覆盖掉 index.js 之后，重新跑一次本脚本即可恢复。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE_EXE = process.env.DSHW_NODE_EXE || process.execPath

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const DRY = has('--dry-run')
const UNINSTALL = has('--uninstall')
const STATUS_ONLY = has('--status')
const PROFILE = opt('--profile', 'desktop')

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------
function candidateHomes() {
  const out = []
  if (process.env.DSH_HOME) out.push(process.env.DSH_HOME)
  if (opt('--dsh-home')) out.unshift(opt('--dsh-home'))
  out.push(path.join(os.homedir(), '.dsh'))
  // 桌面端的数据目录不一定落在用户目录下（可能装在别的盘），扫一遍常见盘符
  for (const d of ['C', 'D', 'E', 'F']) {
    out.push(`${d}:\\DeepSeek Harness Data\\home`)
    out.push(`${d}:\\AI\\DeepSeek Harness Data\\home`)
  }
  return [...new Set(out.filter(Boolean))]
}

function findPluginDir() {
  const explicit = opt('--plugin', '')
  if (explicit && fs.existsSync(explicit)) return { pluginDir: explicit, dshHome: path.dirname(path.dirname(path.dirname(path.dirname(explicit)))) }
  for (const home of candidateHomes()) {
    const p = path.join(home, 'profiles', PROFILE, 'node_modules', 'dsh-whale-widget')
    try { if (fs.existsSync(path.join(p, 'lib', 'index.js'))) return { pluginDir: p, dshHome: home } } catch (err) {}
  }
  return null
}

const found = findPluginDir()
if (!found) {
  console.error('✗ 找不到已安装的 dsh-whale-widget。用 --plugin <插件目录> 或 --dsh-home <DSH_HOME> 指定。')
  process.exit(1)
}
const { pluginDir, dshHome } = found
const indexPath = path.join(pluginDir, 'lib', 'index.js')
const runtimeDir = path.join(dshHome, 'whale-desktop-overlay')

// ---------------------------------------------------------------------------
// 补丁片段
// ---------------------------------------------------------------------------
const M = (n, side) => `// ==== dshw-desktop-overlay :: patch-${n} ${side} ====`

const PATCH_A = `${M('A', 'begin')}
// 桌面悬浮补丁（由 dshw-desktop-overlay/install.mjs 注入）。本段不含逻辑，只为 patch-B/C/D/E/F 备好作用域。
// 卸载与重新打补丁都靠这组标记定位 —— 请勿改动标记文本。
const __dshwOverlayState = { routes: [] }
// 运行时数据（config.json / run 日志）刻意放在 $DSH_HOME 下，插件被更新覆盖也不会丢。
const __dshwOverlayRuntimeDir = path.join(DSH_HOME, 'whale-desktop-overlay')
// 页内挂件开关：桌面悬浮窗已经能独立显示时，DSH 页面里那只就是重复的第二只。
// **判定点只有一处**：/dsh-whale/widget.js 路由（patch-F）。
// （早期版本在"往注入表推不推这一行"那里判 —— 那层是宿主**启动时一次性收集**的，
//  等于只在启动那一刻生效，之后改配置必须重启 DSH，用户实测"勾了没反应"。）
function __dshwInAppWidgetDisabled() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dshwOverlayRuntimeDir, 'config.json'), 'utf8'))
    return !!(c && c.hideInAppWidget === true)
  } catch (err) { return false }
}
// 这次请求是不是**桌面悬浮层自己**发的？
// 悬浮层跑的是 overlay.mjs 起的独立 HTTP 服务，分发到插件路由前会打上 x-dshw-overlay 头
// （见 overlay.mjs 的 server 分发处）。用它来把"桌面那只"和"DSH 页内那只"精确分开，
// 不靠 Referer 之类的推测。
// 拿不到 req/headers 时**按悬浮层处理**（返回 true）：宁可少拦一次，也绝不能把桌面那只弄没。
function __dshwIsOverlayRequest(req) {
  try {
    const h = req && req.headers
    if (!h) return true
    return String(h['x-dshw-overlay'] || '') === '1'
  } catch (err) { return true }
}
${M('A', 'end')}
`

const PATCH_B = `      ${M('B', 'begin')}
      // 收集**未经宿主信任栅栏包装**的原始处理器：桌面悬浮层会在本机另一个回环端口上直接复用它们，
      // 从而绕开宿主 webserver 的会话 bearer 栅栏（那层与插件逻辑无关，且是 401 的唯一来源）。
      try {
        if (route && typeof route.path === 'string' && typeof inner === 'function') {
          __dshwOverlayState.routes.push({ kind: route.kind, path: route.path, handler: inner })
        }
      } catch (err) {}
      ${M('B', 'end')}
`

const PATCH_C = `    ${M('C', 'begin')}
    // 所有 /dsh-whale/* 路由都注册完之后才起悬浮层（顺序要紧：路由表必须已经齐了）。
    // 用动态 import，模块缺失时只留一条日志，绝不连累插件本体。
    const __dshwOverlayLoad = () => import(new URL('./desktop-overlay.mjs', import.meta.url).href)
    Promise.resolve()
      .then(__dshwOverlayLoad)
      .then((mod) => mod.startWhaleDesktopOverlay({
        routes: __dshwOverlayState.routes,
        packageRoot: PACKAGE_ROOT,
        dshHome: DSH_HOME,
        runtimeDir: __dshwOverlayRuntimeDir,
        logger: console,
      }))
      .catch((err) => { try { console.warn('[dshw-overlay] 启动失败：' + String((err && err.message) || err)) } catch (e) {} })
    // 插件被停用 / 卸载 / 宿主退出时收尾（延迟关闭，热重载不会白闪）
    ctx.effect(() => () => {
      Promise.resolve().then(__dshwOverlayLoad).then((m) => m.stopWhaleDesktopOverlay()).catch(() => {})
    })
    ${M('C', 'end')}
`

const PATCH_D = `        ${M('D', 'begin')}
        // ⚠️ 页内挂件开关**不再在这里判**。
        // 这一层是"往宿主的页面注入表里推不推这一行"，而桌面壳的注入表是
        // **宿主启动时一次性收集**的（dsh-desktop-host: collectIndexInjections）——
        // 在这里判，等于只在启动那一刻生效：之后无论怎么勾、怎么刷新页面都不会变，
        // 只能重启 DSH。用户实测就是"勾了「页内也显示」但页面上没出现"。
        // 现在**永远把这一行推进表**，真正的开关交给 /dsh-whale/widget.js 路由
        // 按请求判（那条路由本来是 no-store，每次加载都会重新请求）—— 见 patch-F。
        ${M('D', 'end')}
`

const PATCH_E = `      ${M('E', 'begin')}
      // 同上，另一条注入通道（web 形态走 tapIndex；桌面端走上面的结构化行）
      if (__dshwInAppWidgetDisabled()) return html
      ${M('E', 'end')}
`

const ANCHOR_A = `export default {
  name: 'whale-balance-widget',`
const ANCHOR_B = `    function registerRoute(route) {
      const inner = route && route.handler
`
const ANCHOR_C = `    }) // ← 结束 root.inject(['webServer','credentials','connection'], cb)`
// ① 结构化注入行（桌面端通道）里的去重判断之前
const ANCHOR_D = `        if (!Array.isArray(table)) return`
// ② tapIndex（web 端通道）
const ANCHOR_E = `      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html`

const PATCH_F = `        ${M('F', 'begin')}
        // ── 页内挂件开关的**唯一判定点** ────────────────────────────────────
        // 为什么判在这里：这条路由带 Cache-Control: no-store，页面每次加载都会重新请求
        // ⇒「勾选/取消 → 刷新 DSH 页面」立刻生效，不用重启 DSH。
        // （判在注入表那里不行，见 patch-D 的说明：那是启动时一次性收集的。）
        // 为什么必须放行 x-dshw-overlay 请求：桌面悬浮层是 overlay.mjs 起的**独立服务**，
        // 它的首页也就是一张只引这个脚本的透明页。这里若不加区分地拦，
        // 桌面那只鲸鱼会跟着一起消失。
        if (__dshwInAppWidgetDisabled() && !__dshwIsOverlayRequest(req)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end('/* dshw-desktop-overlay: 页内挂件已关闭（config.json 里 hideInAppWidget=true） */\\n')
          return
        }
        ${M('F', 'end')}
`
// /dsh-whale/widget.js 路由的 handler 头
const ANCHOR_F = `      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
`

// ---------------------------------------------------------------------------
// 补丁外科手术
// ---------------------------------------------------------------------------
function stripBlocks(text) {
  const lines = text.split('\n')
  const out = []
  let depth = 0
  for (const line of lines) {
    const isBegin = /^\/\/ ==== dshw-desktop-overlay :: patch-[A-F] begin ====$/.test(line.trim())
    const isEnd = /^\/\/ ==== dshw-desktop-overlay :: patch-[A-F] end ====$/.test(line.trim())
    if (isBegin) { depth++; continue }
    if (isEnd) { if (depth > 0) depth--; continue }
    if (depth > 0) continue
    out.push(line)
  }
  return out.join('\n')
}

function hasBlocks(text) {
  return ['A', 'B', 'C', 'D', 'E', 'F'].every((n) => text.includes(M(n, 'begin')))
}

function applyPatch(text) {
  const clean = stripBlocks(text)
  if (!clean.includes(ANCHOR_A)) throw new Error('找不到插入锚点 A：export default { name: ... }')
  if (!clean.includes(ANCHOR_B)) throw new Error('找不到插入锚点 B：registerRoute 定义')
  if (!clean.includes(ANCHOR_C)) throw new Error('找不到插入锚点 C：root.inject 结束行')
  if (!clean.includes(ANCHOR_D)) throw new Error('找不到插入锚点 D：webserver/index-inject 处理器')
  if (!clean.includes(ANCHOR_E)) throw new Error('找不到插入锚点 E：tapIndex 注入回调')
  if (!clean.includes(ANCHOR_F)) throw new Error('找不到插入锚点 F：/dsh-whale/widget.js 路由')

  let out = clean.replace(ANCHOR_A, PATCH_A + ANCHOR_A)
  out = out.replace(ANCHOR_B, ANCHOR_B + PATCH_B)
  out = out.replace(ANCHOR_C, PATCH_C + ANCHOR_C)
  out = out.replace(ANCHOR_D, ANCHOR_D + '\n' + PATCH_D)
  out = out.replace(ANCHOR_E, PATCH_E + ANCHOR_E)
  out = out.replace(ANCHOR_F, ANCHOR_F + PATCH_F)
  return out
}

function syntaxCheck(file) {
  try {
    const url = 'file:///' + file.replace(/\\/g, '/')
    execFileSync(NODE_EXE, [
      '-e',
      `import(${JSON.stringify(url)}).then(m=>{if(!m.default||!m.default.apply){console.error('default export 异常');process.exit(1)}console.log('OK')},e=>{console.error(String(e&&e.stack||e));process.exit(1)})`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: String((err && (err.stderr || err.message)) || err).slice(0, 800) }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function status() {
  const text = fs.readFileSync(indexPath, 'utf8')
  const patched = hasBlocks(text)
  const dep = {
    loader: fs.existsSync(path.join(pluginDir, 'lib', 'desktop-overlay.mjs')),
    shell: fs.existsSync(path.join(pluginDir, 'lib', 'overlay-shell', 'main.js')),
    preload: fs.existsSync(path.join(pluginDir, 'lib', 'overlay-shell', 'preload.js')),
    hot: fs.existsSync(path.join(pluginDir, 'lib', 'overlay-shell', 'hot.html')),
    hotPreload: fs.existsSync(path.join(pluginDir, 'lib', 'overlay-shell', 'hot-preload.js')),
  }
  const cfgPath = path.join(runtimeDir, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (err) { cfg = {} }
  console.log('插件目录   :', pluginDir)
  console.log('DSH_HOME  :', dshHome)
  console.log('index.js  :', patched ? '已打补丁 A–E ✓' : '未打补丁 ✗')
  console.log('运行时文件 :', `overlay=${dep.loader ? '✓' : '✗'} shell=${dep.shell ? '✓' : '✗'} preload=${dep.preload ? '✓' : '✗'} hot=${dep.hot ? '✓' : '✗'} hotPreload=${dep.hotPreload ? '✓' : '✗'}`)
  console.log('配置目录   :', runtimeDir, fs.existsSync(cfgPath) ? '(有 config.json)' : '(未创建)')
  console.log('交互方式   :', cfg.inputMode === 'window' ? 'window（旧：压住鲸鱼可能让视频黑屏）' : 'hot（小热点窗，低干扰）')
  console.log('页内小鲸鱼 :', cfg.hideInAppWidget === true ? '关闭（桌面只有一只）' : '显示（DSH 页面里会另有一只）')
  return patched && dep.loader && dep.shell && dep.preload && dep.hot && dep.hotPreload
}

if (STATUS_ONLY) { status(); process.exit(0) }

const bakDir = path.join(pluginDir, 'lib')
function backupOnce() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const p = path.join(bakDir, `index.js.bak-dshw-overlay`)
  if (!fs.existsSync(p)) {
    fs.copyFileSync(indexPath, p)
    console.log('已备份原始 index.js →', path.basename(p))
  }
  const stamped = path.join(bakDir, `index.js.bak-dshw-overlay-${stamp}`)
  fs.copyFileSync(indexPath, stamped)
  return stamped
}

if (UNINSTALL) {
  const text = fs.readFileSync(indexPath, 'utf8')
  const clean = stripBlocks(text)
  if (!DRY) fs.writeFileSync(indexPath, clean, 'utf8')
  const removed = []
  for (const f of [
    path.join(pluginDir, 'lib', 'desktop-overlay.mjs'),
    path.join(pluginDir, 'lib', 'overlay-shell', 'main.js'),
    path.join(pluginDir, 'lib', 'overlay-shell', 'preload.js'),
    path.join(pluginDir, 'lib', 'overlay-shell', 'hot.html'),
    path.join(pluginDir, 'lib', 'overlay-shell', 'hot-preload.js'),
    path.join(pluginDir, 'lib', 'overlay-shell', 'package.json'),
    path.join(pluginDir, 'lib', 'overlay-shell'),
  ]) {
    try { if (fs.existsSync(f)) { if (!DRY) fs.rmSync(f, { recursive: true, force: true }); removed.push(path.relative(pluginDir, f)) } } catch (err) {}
  }
  console.log(DRY ? '（dry-run）将剥离补丁并删除：' : '✓ 已还原。删除：', removed.join(', ') || '（无）')
  console.log('运行时数据保留在', runtimeDir, '（要一起删可手动移除）')
  process.exit(0)
}

// ---- 安装 ----
console.log('── 目标 ──')
console.log('插件目录 :', pluginDir)
console.log('DSH_HOME :', dshHome)
console.log('运行时   :', runtimeDir)
console.log('Electron :', process.env.DSHW_ELECTRON_EXE || '（自动探测 process.execPath）')
console.log('')

const CFG_DEFAULTS = {
  enabled: true,
  autoStart: true,
  port: 37917,
  portScan: 12,
  bounds: 'workArea',
  alwaysOnTop: true,
  clickThrough: true,
  // 鼠标交给悬浮窗的方式。'hot' = 小热点窗转发（全屏窗恒穿透，不会让正在播放的视频黑屏）
  inputMode: 'hot',
  hotPadding: 14,
  // 悬浮窗独立显示后，DSH 页面里那只就是重复的第二只 → 默认关掉
  hideInAppWidget: true,
  quitWhenHostExits: true,
  tray: true,
  disableGpu: false,
  electronExe: 'auto',
  role: '',
  extraQuery: '',
}

// 1) 部署文件
const plan = [
  [path.join(HERE, 'overlay.mjs'), path.join(pluginDir, 'lib', 'desktop-overlay.mjs')],
  [path.join(HERE, 'shell', 'main.js'), path.join(pluginDir, 'lib', 'overlay-shell', 'main.js')],
  [path.join(HERE, 'shell', 'preload.js'), path.join(pluginDir, 'lib', 'overlay-shell', 'preload.js')],
  [path.join(HERE, 'shell', 'hot.html'), path.join(pluginDir, 'lib', 'overlay-shell', 'hot.html')],
  [path.join(HERE, 'shell', 'hot-preload.js'), path.join(pluginDir, 'lib', 'overlay-shell', 'hot-preload.js')],
  [path.join(HERE, 'shell', 'package.json'), path.join(pluginDir, 'lib', 'overlay-shell', 'package.json')],
  [path.join(HERE, 'README.md'), path.join(pluginDir, 'lib', 'overlay-shell', 'README.md')],
]
for (const [src, dst] of plan) {
  if (!fs.existsSync(src)) { console.error('✗ 源文件缺失：' + src); process.exit(1) }
  if (DRY) { console.log('[dry] 复制', src, '→', dst); continue }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log('✓ 部署', path.relative(pluginDir, dst))
}

// 2) 运行时配置目录（存在的配置只补**缺失**的键，绝不覆盖用户改过的值）
if (!DRY) {
  fs.mkdirSync(path.join(runtimeDir, 'run'), { recursive: true })
  const cfgPath = path.join(runtimeDir, 'config.json')
  let cur = null
  try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (err) { cur = null }
  if (!cur || typeof cur !== 'object') {
    fs.writeFileSync(cfgPath, JSON.stringify(CFG_DEFAULTS, null, 2), 'utf8')
    console.log('✓ 写入默认配置', path.relative(dshHome, cfgPath))
  } else {
    const added = []
    for (const [k, v] of Object.entries(CFG_DEFAULTS)) {
      if (!(k in cur)) { cur[k] = v; added.push(k) }
    }
    if (added.length) {
      fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2), 'utf8')
      console.log('✓ 配置补齐新键：' + added.join(', '))
    } else {
      console.log('· 配置已是最新，保留不动', path.relative(dshHome, cfgPath))
    }
  }
}

// 3) 打补丁
const original = fs.readFileSync(indexPath, 'utf8')
const alreadyPatched = hasBlocks(original)
let patchedText
try {
  patchedText = applyPatch(original)
} catch (err) {
  console.error('✗ 打补丁失败：' + String(err && err.message || err))
  process.exit(1)
}
if (DRY) {
  console.log('[dry] 将写入 index.js（原 ' + original.split('\n').length + ' 行 → 新 ' + patchedText.split('\n').length + ' 行）')
} else {
  if (!alreadyPatched) backupOnce()
  else console.log('· index.js 已有补丁，将按标记替换（幂等）')
  fs.writeFileSync(indexPath, patchedText, 'utf8')
  console.log(`✓ ${alreadyPatched ? '刷新' : '写入'}补丁 → lib/index.js`)
}

// 4) 校验语法 / 可加载
if (!DRY) {
  const r = syntaxCheck(indexPath)
  if (r.ok) console.log('✓ index.js 语法与模块加载校验通过')
  else { console.error('✗ 校验失败，正在回滚：\n' + r.message); fs.writeFileSync(indexPath, original, 'utf8'); process.exit(1) }
}

console.log('')
status()
console.log('')
console.log('── 下一步 ──')
console.log('① 重启 DeepSeek Harness（悬浮层只在插件加载时挂载）')
console.log('② 桌面上应该只剩**一只**小鲸鱼（DSH 页面里那只已按 hideInAppWidget 关掉）')
console.log('③ 点鲸鱼/拖鲸鱼都不会影响别的窗口里正在播放的视频（输入走小热点窗，全屏窗恒穿透）')
console.log('④ 想找回 DSH 页内那只：托盘右键 → 勾上「DSH 页面里也显示小鲸鱼」，再刷新 DSH 页面')
console.log('⑤ 若热点窗在你的环境里不好用：托盘右键 → 取消「低干扰交互」即回到旧的全窗命中测试')
console.log('⑥ 关掉悬浮层：托盘图标右键 → 退出悬浮窗；或把 config.json 的 enabled 改为 false 再重启')
console.log('⑦ 只想验证渲染、不想重启 DSH：')
console.log(`   ${NODE_EXE} "${path.join(HERE, 'selftest.mjs')}"`)
console.log(`   （用插件的真实资源做一次离线渲染自检，会截图落盘并自动退出）`)
console.log('⑧ dsh plugin update 覆盖 index.js 之后，重新跑一次本脚本即可恢复（幂等）')
