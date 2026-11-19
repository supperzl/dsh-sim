# DSH 模拟器（dsh-sim）

把 **iOS 模拟器 / Android 模拟器（或 USB 真机）** 以**原生侧边栏 tab** 的形式放进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：在右侧栏「开始」页新建一个
「模拟器」窗口，下拉选择设备，就能看到实时 H.264 画面并直接在画面上点按、拖动。

- **每个会话独立**：模拟器 tab 和推流都绑定当前会话，A 会话开着的设备不会跑到 B 会话。
- **低延迟**：iOS 走 serve-sim 的 `/stream.avcc`（H.264），Android 走 scrcpy-server 4.0（H.264），
  浏览器用 WebCodecs 硬解；不是 MJPEG，也不是逐帧 PNG。
- **原生外观**：手机框 / 细边框 / 无框三种外壳，带听筒挖孔、Home 条、侧键；画面按侧栏宽高
  自适应缩放，始终完整可见。
- **设备选择器**：搜索、使用过的设备分组、其他设备折叠、运行状态与选中标记。
- **10 个 agent 工具**：列设备、启动/停止、截图、点按、滑动、输入、按键、旋转、状态。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | ≥ 0.2.2（Web / 桌面版） |
| dsh-better-sidebar | ≥ 0.32（必需：模拟器 tab 注册在它上面） |
| iOS | macOS + **完整版 Xcode**（`xcrun simctl`、模拟器运行时） |
| Android | Android SDK `platform-tools`（adb）；模拟器 AVD 或 USB 真机 |
| Node | ≥ 22（DSH 宿主进程） |

首次启动 Android 流时，插件会把 **scrcpy-server 4.0** 下载到 `~/.dsh/cache/dsh-sim`
（约 1 MB，需要一次 GitHub 访问，之后离线可用）。

## 安装

```sh
git clone git@github.com:supperzl/dsh-sim.git ~/dsh-sim
cd ~/dsh-sim && npm install
```

然后把它注册进 DSH profile：

- 桌面端：让 DSH 安装本地目录（插件页 → 添加插件 → 选择目录），或让 agent 调用
  `plugin_manager install_bundle /Users/<you>/dsh-sim`；
- Web/TUI profile：`dsh plugin --profile web add /Users/<you>/dsh-sim`。

安装后**硬刷新一次** GUI（`Cmd+Shift+R`）：宿主端即时生效，前端包会被浏览器缓存一次。

## 使用

1. 右侧栏点「+」→「开始」页 → 点 **「模拟器」** 卡片，新建模拟器窗口。
2. 点左上角设备按钮：搜索设备，或在「使用过的设备 / 此计算机上的其他设备」里选一台，
   点击即启动（iOS 已启动的模拟器会直接用，未启动的会先 boot）。
3. 工具条：`播放/停止`、`旋转`、`主页`、`锁屏（iOS）/ 电源（Android）`，
   右侧可选 `手机框 / 边框 / 无框`。
4. 画面操作：**点按 = 轻触，拖动 = 滑动手势**。
5. 想放大就拖宽右侧栏，画面会跟着缩放（始终完整可见）。

## 工具

所有工具都返回纯 JSON，并绑定**当前会话**的模拟器流（`exec.agent.session.id`）。

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `sim_devices` | 列出 iOS 模拟器、Android 设备、AVD | — |
| `sim_start` | 启动设备并把流接到当前会话 | `device`、可选 `platform` |
| `sim_stop` | 停止当前会话的流 | — |
| `sim_status` | 当前会话正在推流的设备 | — |
| `sim_screenshot` | 截一张 PNG，返回路径与像素尺寸 | — |
| `sim_tap` | 按归一化坐标点按 | `x`、`y`（0..1） |
| `sim_swipe` | 按归一化坐标滑动 | `fromX`、`fromY`、`toX`、`toY`、`durationMs` |
| `sim_text` | 输入 ASCII 文本 | `text` |
| `sim_key` | 按 home/back/recents/power/volume_up/volume_down/enter/delete/menu | `name` |
| `sim_rotate` | 旋转（iOS 指定方向，Android 切换） | `orientation` |

## 架构

```
lib/
├── index.js          # 宿主插件入口：工具注册、webServer 路由挂载、生命周期
├── client.js         # 浏览器 bundle（__ModuleLoader__ 格式）：模拟器 tab + WebCodecs 播放器
├── tools.js          # 10 个 sim_* 工具定义
└── host/
    ├── devices.js    # simctl / adb / emulator 设备发现
    ├── ios.js        # serve-sim 生命周期 + AVCC 流地址 + HID 控制协议
    ├── android.js    # scrcpy-server 启动、视频/控制 socket、控制消息编码
    ├── manager.js    # 按 sessionId 隔离的流会话、截图、空闲回收
    ├── resolve.js    # 跨 profile 解析 serve-sim / ws（link 安装场景）
    └── routes.js     # /_dsh/dsh-sim/* HTTP 路由与同源/loopback 围栏
```

详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 已知限制

- iOS 流仅支持 macOS + 完整 Xcode；Android 需要 `adb` 能看到设备。
- 每个会话同时只推一路流；同一时间一个浏览器面板对应一个会话。
- 工具目前覆盖设备操作；构建运行、OCR、UI 树等能力暂未包含。
- 画面解码依赖 WebCodecs H.264（DSH 桌面版已支持）。

## 开发

```sh
npm run check     # 语法检查所有模块 + 校验 package.json / bundle 文件
```

改完代码后用 `plugin_manager set_plugin <id>`（禁用再启用）热重载宿主；前端包可能需要硬刷新。

## 许可

MIT。第三方：serve-sim（Apache-2.0）、scrcpy（Apache-2.0）、ws（MIT）。
