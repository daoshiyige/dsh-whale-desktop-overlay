# dsh-whale-desktop-overlay

让已经装在 DSH 里的那只小鲸鱼，同时悬浮在 Windows 桌面上。

![运行效果](docs/screenshot.png)

## 作用

- **桌面悬浮** —— 鲸鱼出现在桌面上：透明、无边框、置顶、不占任务栏。
- **点击穿透** —— 鲸鱼之外的透明区域不拦截鼠标，下面的窗口照常操作。
- **拖动与吸附** —— 拖动、四边吸附、边缘镜像，都是挂件自带的行为。
- **数据同源** —— 余额、今日已用、峰谷、记账、角色、气泡、音效全部走 DSH 里那份服务端数据，
  不需要重新填 API Key；桌面和 DSH 里看到的是同一只鲸鱼。
- **托盘控制** —— 显示 / 隐藏、重载、交互方式、退出。

它**不是**独立的桌面宠物程序：不重写挂件、不 fork 前端、不改 DSH 客户端，
只在本机已安装的那份插件上打一组可剥离的补丁。
如果你想要完全独立、不依赖 DSH 的桌面版，上游另有 `For–WinDesktop` 分支（Tauri）。

## 安装

**前置要求**：Windows 10 / 11，且已装 DSH 桌面客户端 + `dsh-whale-widget` 插件。

> 桌面端装插件不能走 CLI（`--profile desktop` 会被拒绝，设计如此）。
> 请在**桌面客户端会话里直接说一句「把 dsh-whale-widget 装上」**，由它内置的插件管理器安装。

然后在本目录执行：

```bash
node install.mjs              # 部署 + 打补丁
node install.mjs --status     # 只看现状
node install.mjs --dry-run    # 只打印将要做的改动
node install.mjs --uninstall  # 还原（按标记剥离补丁 + 删掉部署的文件）
```

装完**重启 DeepSeek Harness** —— 悬浮层只在插件加载时挂载。

不想重启就验证渲染：

```bash
node selftest.mjs
```

它会用插件的真实资源起一次真实悬浮窗，渲染 9 秒后自动截图到 `_selftest/overlay-shot.png`，
并打印一份体检结论。

**关掉悬浮窗**：托盘图标右键 → 退出悬浮窗；或把 `config.json` 里 `enabled` 改成 `false` 再重启；
或 `node install.mjs --uninstall` 彻底还原。

## 配置

`<$DSH_HOME>/whale-desktop-overlay/config.json`

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 完全不挂载悬浮层 |
| `autoStart` | `true` | 插件加载时自动拉起窗口 |
| `port` | `37917` | 悬浮层服务端口（被占用则自动 +1，最多试 12 次） |
| `bounds` | `'workArea'` | `'workArea'` 避开任务栏；`'screen'` 请求整屏（Windows 通常裁回工作区） |
| `displayIndex` | 主屏 | 多显示器时指定第几块（0 起） |
| `alwaysOnTop` | `true` | 置顶（`screen-saver` 层级） |
| `clickThrough` | `true` | 空白处穿透 |
| `inputMode` | `'hot'` | `'hot'` = 小热点窗转发真实鼠标（推荐）；`'window'` = 整窗命中测试 |
| `hotPadding` | `14` | 热点窗相对鲸鱼包围盒外扩的像素（留余量给气泡 / 菜单） |
| `hideInAppWidget` | `true` | `true` = 关掉 DSH 页面里那只鲸鱼，桌面只留一只 |
| `quitWhenHostExits` | `true` | 宿主退出时自动关窗，不留孤儿 |
| `tray` | `true` | 托盘图标 |
| `disableGpu` | `false` | 软件合成；GPU 崩过会自动回退并写回此项 |
| `electronExe` | `'auto'` | 指定 Electron 可执行文件；也可用环境变量 `DSHW_ELECTRON_EXE` |
| `role` | `''` | 预置角色 id（悬浮层是独立 origin，`localStorage` 不共享） |
| `extraQuery` | `''` | 追加到页面 URL 的查询串 |

改完配置需要**重启 DSH**。只有 `hideInAppWidget` 例外 —— 它在页面注入那一刻生效，
改完**刷新 DSH 页面**即可。

## 来源与许可

本项目**衍生自** [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），
不改上游仓库，只在本机已安装的那份插件上打一组可剥离的补丁。

- 本项目代码：**MIT**，见 [`LICENSE`](LICENSE)
- 上游代码：MIT，版权归 MeteorNOX 所有
- 上游美术素材（`assets/**`）：**非 MIT**、as-is —— 本项目**不再分发**任何素材，
  运行时的图片与音效全部由本机已安装的上游插件提供

细节见 [`NOTICE.md`](NOTICE.md)。本项目与上游作者无隶属关系，未经其审核或背书。
