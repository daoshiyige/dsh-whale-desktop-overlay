# dshw-desktop-overlay

**让已经装在 DSH 里的那只小鲸鱼，同时悬浮到 Windows 桌面上。**

不改上游仓库、不重新实现挂件、不 fork 前端、不改 DSH 客户端 —— 前端那 1.7 万行一行都不动。

> **这是什么**
>
> 上游 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 是一只挂在 DSH 界面右下角的余额小鲸鱼。
> 本项目在**本机已安装的**那份插件上打一组**可剥离**的补丁，把它额外渲染到一个全屏透明置顶窗口里。
> 余额、今日已用、峰谷、记账、角色、气泡、音效、吸附**全部沿用同一份数据和同一套前端逻辑** ——
> 所以不需要重新配置 API Key，桌面和 DSH 里看到的就是同一只鲸鱼。
>
> **它不是什么**：不是独立的桌面宠物程序。想要完全独立、不依赖 DSH 的桌面版，
> 看上游的 `For–WinDesktop` 分支（Tauri 桌面版）。

![运行效果](docs/screenshot.png)

> 截图：右下角是鲸鱼本体，其余区域完全透明（自检实测四角像素 `[0,0,0,0]`，全图 99.16% 为全透明）。

---

## 前置要求

- **Windows 10 / 11**
- **DSH 桌面客户端**（Electron），且已经把 `dsh-whale-widget` 装进某个 profile（默认 `desktop`）
- 插件本体由上游提供，本项目不含也不替代它：

  ```bash
  # Web 形态
  dsh plugin --profile web add dsh-whale-widget
  ```

  > 官方桌面端不能这么装（`--profile desktop` 会被 CLI 拒绝，设计如此）。
  > 请在**桌面客户端会话里直接说一句「把 dsh-whale-widget 装上」**，由它内置的插件管理器装进 `desktop` profile。

- 不需要联网、不需要额外下载 Electron（复用 DSH 自带的运行时）

---

## 一句话原理

插件已经注册好的 23 条 `/dsh-whale/*` 路由，被补丁收集了一份**未经宿主信任栅栏包装的原始处理器**；
悬浮层在 `127.0.0.1` 上另起一个小服务把它们原样再挂一遍（自己实施更严的回环 + 令牌校验），
再用一个 **全屏 / 透明 / 无边框 / 置顶 / 不占任务栏 / 空白处点击穿透** 的 Electron 窗口去加载它。

于是：余额、今日已用、峰谷、记账、角色、气泡、音效、吸附 —— **全部走同一份服务端数据和同一套前端逻辑**，和 DSH 页面里的挂件是同一个东西，只是一个在窗口里，一个在桌面上。

---

## 为什么是「两个窗口」（点鲸鱼不能把别的窗口搞黑屏）

最早的版本只有一个全屏窗：指针压到鲸鱼时调 `setIgnoreMouseEvents(false)` 来接收点击。
那一步会摘掉窗口的 `WS_EX_TRANSPARENT` 扩展样式，于是浏览器（Chrome / Edge）的**窗口遮挡检测**不再把它当透明窗口，
判定自己「被完全遮挡」→ 停止绘制、丢掉硬件视频通路 → **正在播放的视频直接黑屏**，点一下浏览器才恢复。

所以现在拆成两个窗口：

| 窗口 | 尺寸 | 职责 | 关键属性 |
|---|---|---|---|
| 主窗 | 全屏 | 只负责**画** | 透明/无边框/置顶/不占任务栏 + **恒穿透**（运行期从不改）+ `focusable:false` |
| 热点窗 | ~160×180 | 只负责**接鼠标** | 透明/无边框/置顶/不占任务栏 + **不可激活**（`WS_EX_NOACTIVATE`）+ 跟随鲸鱼的包围盒 |

热点窗收到的真实鼠标，由主进程用 `webContents.sendInputEvent` **合成进主窗** ——
浏览器最多看到一块小窗口压在自己身上，不会被判成"完全遮挡"，视频照常播。
主窗又永不抢前台，所以也不会把浏览器踢出前台。

两个必须处理好的细节（都踩过）：

1. **拖动期间必须冻结热点窗位置。** 热点窗跟着鲸鱼跑，相对坐标就恒定不变，鲸鱼会变成"原地追自己"，拖动直接失效；顺带还会丢鼠标捕获。松手后再重新贴合。
2. **合成 `mouseMove` 带不上"左键仍按住"的位。** `sendInputEvent` 合成出来的 `pointermove`/`mousemove` 里 `e.buttons` 恒为 `0`
   （事件里塞 `button`/`buttons` 字段会被 Electron 忽略），而挂件的移动处理里有 `if (!e.buttons) endDrag()`
   —— 于是表现为"按住鲸鱼拖不动"。解法是在**悬浮层自己的页面壳**里（注册时机早于挂件脚本）把这一个字段补正，
   挂件那 900 KB 依旧一行不改：

   ```js
   document.addEventListener('pointermove', function (e) {
     if (held && !e.buttons) Object.defineProperty(e, 'buttons', { value: 1, configurable: true })
   }, true)
   ```

## 桌面上为什么只剩一只鲸鱼

插件有**两条**注入通道，会把挂件塞进 DSH 页面（`webserver/index-inject` 的结构化行 + `ctx.webServer.tapIndex`）。
桌面悬浮窗一旦能独立显示，页内那只就是重复的第二只 —— 补丁 D/E 在两条通道上都按 `config.json` 的
`hideInAppWidget` 短路（默认 `true`，即关掉页内那只）。

两条通道各自独立：**关掉页内挂件不影响任何服务端能力**，余额/记账/角色/气泡照常工作。
想两只都要（或只留页内那只）：托盘图标右键 → 勾上「DSH 页面里也显示小鲸鱼」，然后刷新一下 DSH 页面。

## 为什么必须绕开宿主那层 401

```
$ curl -i http://127.0.0.1:3791/dsh-whale/balance.json
HTTP/1.1 401 Unauthorized
{"error":{"message":"missing or invalid Authorization bearer", ...}}
```

这个 401 来自宿主的 `connection.requestRejection`（浏览器会话栅栏），**与插件逻辑无关**。
插件自己的校验是另一套（回环 Host / 同源 Origin / 非跨站），补丁收集的正是**过了插件这套、还没进宿主栅栏**的处理器。
悬浮层用「只绑 `127.0.0.1` + 每进程随机令牌 + `Sec-Fetch-Site: cross-site` 一律拒」替代那道栅栏 ——
比原来的路径更严，不是更松。

---

## 安装

```bash
node install.mjs            # 部署 + 打补丁
node install.mjs --status   # 只看现状
node install.mjs --uninstall# 还原（按标记剥离补丁 + 删掉部署的文件）
node install.mjs --dry-run  # 只打印将要做的改动
```

然后**重启 DeepSeek Harness**。悬浮层只在插件加载时挂载。

想不重启就验证渲染：

```bash
node selftest.mjs
```

它会用插件的真实资源起一次真实悬浮窗，渲染 9 秒 → 自动截图到 `./_selftest/overlay-shot.png` → 退出；
中途还会在热点窗里造一次「按下 → 拖动 → 抬起」，用真实链路验证输入通路，最后打印一份体检结论。

---

## 实测结果（本机，2026-10-06）

| 项目 | 结果 |
|---|---|
| Electron | 44.0.0 / Chrome 152 / Node 24（**复用宿主自带的运行时，零下载**） |
| 私有运行时 | 硬链接 **72** 个文件、复制 **0** 个 → 额外磁盘占用 **0 字节** |
| 窗口 | 1707×1020 DIP（scale 1.5），无边框、透明、置顶、不占任务栏 |
| 背景透明度 | **99.16% 全透明**，四角像素 `[0,0,0,0]` |
| 前端挂载 | `.dshwv-root` 存在，`250×250`，吸附在右下角 |
| 热点窗 | 162×177，贴合鲸鱼包围盒（外扩 14px） |
| 输入通路 | 按下 `(1646,958)` 拖动 → 鲸鱼 `(1458,770)` → `(1410,722)`，**根元素全程保持 `dshwv-dragging`** |
| 主窗是否被激活 | **否**（`focusable:false`，点击不抢前台） |
| 坐标一致性 | 注入 → 页面实测 `clientX/Y` 完全一致（1:1 DIP） |
| GPU | 本机 GPU 进程会崩 → **自动回退软件合成**并记住结论 |

---

## 配置

`<$DSH_HOME>/whale-desktop-overlay/config.json`

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 完全不挂载悬浮层 |
| `autoStart` | `true` | 插件加载时自动拉起窗口 |
| `port` | `37917` | 悬浮层服务端口（占用则自动 +1，最多试 12 次） |
| `bounds` | `'workArea'` | `'workArea'` 避开任务栏；`'screen'` 请求整屏（Windows 通常会裁回工作区） |
| `displayIndex` | 主屏 | 多显示器时指定第几块（0 起） |
| `alwaysOnTop` | `true` | 置顶（`screen-saver` 层级） |
| `clickThrough` | `true` | 空白处穿透 |
| `inputMode` | `'hot'` | 鼠标怎么交给悬浮窗 —— 见上一节。`'hot'` = 小热点窗转发（**推荐**）；`'window'` = 旧的全屏命中测试，**可能让正在播放的视频黑屏**，仅作降级用 |
| `hotPadding` | `14` | 热点窗相对鲸鱼包围盒外扩多少像素（留余量给气泡/菜单） |
| `hideInAppWidget` | `true` | `true` = 关掉 DSH 页面里那只鲸鱼（桌面只留一只）；改完刷新 DSH 页面即可 |
| `quitWhenHostExits` | `true` | 宿主没了就自动关窗，不留孤儿 |
| `tray` | `true` | 托盘图标（显示/隐藏、重载、置顶、交互方式、页内挂件、打开日志、退出） |
| `disableGpu` | `false` | 软件合成；GPU 崩过会自动回退并写回此项 |
| `electronExe` | `'auto'` | 指定 Electron 可执行文件；也可用环境变量 `DSHW_ELECTRON_EXE` |
| `role` | `''` | 预置角色 id（悬浮层是独立 origin，localStorage 不共享） |
| `extraQuery` | `''` | 追加到页面 URL 的查询串 |

---

## 怎么关掉悬浮窗

1. **托盘图标右键 → 退出悬浮窗**（最方便）
2. `config.json` 里 `enabled` 改 `false`，重启 DSH
3. `node install.mjs --uninstall` 彻底还原

---

## 目录

```
<插件>/lib/
  index.js                ← 打补丁（A/B/C/D/E 五段标记）
  desktop-overlay.mjs     ← 悬浮层运行时（本仓库 overlay.mjs）
  overlay-shell/          ← Electron 薄壳（本仓库 shell/）
    main.js               ← 主进程：主窗 + 热点窗 + 输入合成 + 托盘
    preload.js            ← 主窗：上报可交互区域（hot 模式）/ 命中测试（window 模式）
    hot.html              ← 热点窗页面（空白，只为接事件）
    hot-preload.js        ← 热点窗：真实鼠标 → IPC
<$DSH_HOME>/whale-desktop-overlay/
  config.json             ← 配置
  run/overlay.log         ← 运行时日志
  run/shell.log           ← 壳日志（Windows 下主进程 stdout 拿不到，只能写文件）
  run/shell-status.json   ← 壳阶段状态机 + 输入通路计数，排障用
  electron/               ← 私有 Electron 运行时（硬链接，0 字节）
```

---

## 排障

**桌面没出现鲸鱼**
1. 看 `<$DSH_HOME>/whale-desktop-overlay/run/overlay.log` 有没有「悬浮层服务已就绪」
2. 再看 `run/shell.log` 和 `run/shell-status.json` 的 `stage` 走到哪一步
3. `stage` 停在 `ready` → Electron 没起来；`load-failed` → 端口/URL 问题；`shown` 但没鲸鱼 → 看 `[renderer]` 日志

**有窗口但全白/全黑**
`disableGpu` 改 `true` 再重启。

**鲸鱼出现了但点不动 / 挡住下层窗口**
- 先看 `run/shell-status.json`：`hotBounds` 有没有值、`hotEvents`/`injected` 有没有在涨。
  `injected=0` 说明真实鼠标根本没进热点窗（`hotBounds` 为空 → 包围盒没算出来；主窗 preload 有问题）。
- 拖动时鲸鱼"不动"：看 `run/shell.log` 里有没有 `转发 mouseMove … 拖动=true`。有转发却不动，通常是页面壳里的
  `buttons` 补正没生效（挂件脚本被改过），或 `dshwv-dragging` 没挂上。
- 兜底：托盘 → 取消「低干扰交互」，回到旧的全窗命中测试（能点能拖，但压住鲸鱼时视频可能黑屏）。

**点鲸鱼时别的窗口里播放的视频黑屏**
说明还在用旧模式。托盘 → 勾上「低干扰交互」（或 `config.json` 里 `inputMode: 'hot'`）后重启悬浮窗。
如果已经是 `hot` 还黑屏，把 `run/shell-status.json` 发出来 —— 那种情况属于新问题，不是已知成因。

**DSH 页面里还有第二只鲸鱼**
`hideInAppWidget` 为 `true` 时只在**注入那一刻**生效，所以要**刷新 DSH 页面**（或重启 DSH）才会消失。
托盘里那个勾选项改完也是同理。

**改了没生效**
`dsh plugin update` 会覆盖 `index.js`。重跑 `node install.mjs` 即可（幂等，按标记替换，不会叠加）。

---

## 已知边界

- **只在 Windows 上验证过。** macOS/Linux 的 `setIgnoreMouseEvents(forward)` 是支持的，但全屏透明置顶窗口的行为需要各自验证。
- **悬浮层与 DSH 页面是两个 origin**，`localStorage` 不共享：位置、吸附、选中角色各自记一份。服务端配置（角色库、气泡、音效、记账）是共享的。
- **依赖宿主自带的 Electron。** 如果 DSH 换成非 Electron 外壳，悬浮层会找不到运行时，需要 `electronExe` 指定一个未打包的 `electron.exe`。
- **私有运行时是硬链接**，和 DSH 安装目录共用同一份 inode。DSH 升级不会破坏它（inode 只要还有链接就在），但版本会停在链接时的版本。删掉 `electron/` 目录会重建。
- 全屏透明窗口会一直在最上层（除非托盘关掉置顶）。全屏播放视频/玩游戏时建议托盘里隐藏。
- **热点窗是一块 ≈160×180 的矩形**，它比鲸鱼本体略大：落在鲸鱼包围盒里但**透明像素**上的点击会被它吃掉（既拖不动鲸鱼，也不会传给下层窗口）。
  这和旧模式的行为一致（挂件自己用逐像素 alpha 命中测试，透明区本来就不响应），只是范围明确成了这个矩形。要更极致可以按 alpha 生成逐像素热点区，但收益很小。
- **热点窗依赖鲸鱼的位置上报**（主窗 preload 每 200 ms 采样可交互元素的包围盒）。鲸鱼被拖到屏幕边缘时热点窗会被裁进显示器内，坐标换算按实际 `getBounds()` 回算，所以不会错位。

---

## 来源与许可

本项目**衍生自** [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），
不改上游仓库，只在本机已安装的那份插件上打一组可剥离的补丁。

- 本项目代码：**MIT**，见 [`LICENSE`](LICENSE)
- 上游代码：MIT（归 MeteorNOX 所有）
- 上游美术素材（`assets/**`）：**非 MIT**、as-is，本项目**不再分发**任何素材 ——
  运行时的图片与音效全部由本机已安装的上游插件提供

细节与权利主张入口见 [`NOTICE.md`](NOTICE.md)。

> 本项目与上游作者无隶属关系，未经其审核或背书。
