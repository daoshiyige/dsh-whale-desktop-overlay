# 来源与许可说明（NOTICE）

## 一、与上游的关系

`dshw-desktop-overlay` **衍生自** [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）。

上游是一个 DSH（DeepSeek Harness）插件：一只显示账户余额的小鲸鱼，挂在 DSH 界面右下角。

本项目**不改上游仓库**，而是在**本机已安装的**那份插件上打一组带标记的补丁，把它额外渲染到一个 Windows 桌面悬浮层里。
换句话说，宿主、插件、后端接口、前端逻辑全都还是上游那一份，本项目只增加了「多一个桌面出口」。

## 二、本项目没有重新实现挂件

`assets/whale-widget.js`（前端挂件本体，上游约 1.7 万行）**一行都没有改动**，运行时由补丁后的插件照常提供。

本项目新增的只有：

| 文件 | 作用 |
|---|---|
| `overlay.mjs` | 悬浮层运行时：只绑 `127.0.0.1` 的小 HTTP 服务 + 拉起 Electron 窗口 |
| `shell/main.js` | Electron 主进程：主窗 + 热点窗 + 输入合成 + 托盘 |
| `shell/preload.js` | 主窗 preload：上报可交互区域 / 命中测试 |
| `shell/hot.html`、`shell/hot-preload.js` | 热点窗：把真实鼠标转成 IPC |
| `install.mjs`、`selftest.mjs` | 部署（打补丁 / 还原）与无人值守自检 |

补丁本身是**幂等、可剥离**的：每段代码两端有固定标记
（`// ==== dshw-desktop-overlay :: patch-X begin/end ====`），
`node install.mjs --uninstall` 会按标记把它们摘干净，并删除部署进去的文件。

## 三、上游素材（`assets/**`）没有再分发

上游 `PROVENANCE.md` 明确声明：

> `assets/**`（图片 / 动图 / 音效）**不适用 MIT**：由维护者提供或使用 AI 工具生成，
> 按 **as-is** 随插件分发，仅用于运行本插件；不授予再许可，也不声明为原创作品。

本项目**不包含、不打包、不再分发**上游 `assets/` 里的任何素材。
运行时的图片与音效全部由**本机已安装的上游插件**提供 —— 本项目只是让同一个页面换个窗口显示出来。

`docs/screenshot.png` 是本项目运行时的屏幕截图（画面中包含由上游插件渲染出来的挂件），仅用于说明本项目效果。

## 四、许可

| 范围 | 许可 |
|---|---|
| 本项目全部代码（`*.mjs`、`shell/**`） | **MIT**，见 [`LICENSE`](LICENSE) |
| 上游代码 | MIT（上游仓库） |
| 上游美术素材（`assets/**`） | **非 MIT**，as-is，见上游 `PROVENANCE.md` |

上游版权归 [MeteorNOX](https://github.com/MeteorNOX) 所有，本项目保留其署名。

## 五、权利主张

如果上游作者或其他权利人认为本项目的任何内容不妥（包括命名、描述或截图），
请开一条 issue 说明，我会立即调整或移除。
