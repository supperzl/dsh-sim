# dsh-sim 架构

## 总览

```
┌──────────────────────────── DeepSeek Harness 宿主进程 ────────────────────────────┐
│  lib/index.js  ── 注册 10 个 sim_* 工具                                          │
│                └─ ctx.inject(['webServer']) → /_dsh/dsh-sim/* 路由                │
│                                                                                  │
│  lib/host/manager.js   Map<sessionId, Session>                                   │
│      ├─ ios.js       serve-sim 子进程 + AVCC + HID WebSocket                     │
│      └─ android.js   adb forward + scrcpy-server 4.0（video/control 两个 socket）│
└──────────────────────────────────────────────────────────────────────────────────┘
                     ▲  HTTP（fetch 流 / JSON）              ▲  agent 工具调用
┌────────────────────┴──────────────────┐   ┌───────────────┴──────────────────────┐
│ lib/client.js（浏览器 bundle）        │   │ 模型：sim_devices / sim_start / …    │
│  better-sidebar tab「模拟器」         │   │ 绑定 exec.agent.session.id           │
│  WebCodecs H.264 → <canvas>           │   └──────────────────────────────────────┘
└───────────────────────────────────────┘
```

## 会话模型

每个会话（`sessionId`）最多一路流：

```ts
interface SimSession {
  platform: 'ios' | 'android'
  device: string          // iOS udid / Android serial
  name: string
  width?: number
  height?: number
  stream: IosStream | AndroidStream
  control?: IosControl
  startedAt: number
  lastAccess: number
}
```

- 客户端从 better-sidebar 的 tab 作用域拿到 `scope.sessionId`，所有请求都带这个 id。
- agent 工具从 `exec.agent.session.id` 取同一个 id，因此 agent 启动的设备会出现在
  该会话的模拟器窗口里。
- 空闲 30 分钟自动停流（`manager.reap`）；插件 dispose 时停止全部流。
- 切换设备 = 先停掉旧流，再在新设备上建流。

## iOS 通路（serve-sim）

1. `xcrun simctl boot <udid>`（已启动则跳过）。
2. `serve-sim --detach -q <udid>`，从 stdout 读一行 JSON 握手：
   `{ port, url, streamUrl, wsUrl, device }`。
3. AVCC 地址 = `streamUrl.replace('stream.mjpeg', 'stream.avcc')`；`/helper/<udid>/config`
   给出 `{ width, height, orientation }`（启动时轮询到非 0 为止）。
4. 视频流是「长度前缀信封」：

   ```
   u32 BE 长度（含 tag 字节） | u8 tag | payload
   tag 1 = avcC 解码配置（直接作为 VideoDecoder.description）
   tag 2 = 关键帧（payload 为 4 字节长度前缀的 NAL）
   tag 3 = 差分帧
   tag 4 = JPEG 种子帧（首帧前先画出来，避免黑屏）
   ```

5. 控制走 serve-sim 的 WebSocket，帧格式 `[tag][UTF-8 JSON]`：
   `3` 触摸 `{type:'begin'|'move'|'end', x, y}`（0..1）、`4` 硬件键 `{button}`、
   `6` 键盘 `{type, usage}`、`7` 旋转 `{orientation}`。

## Android 通路（scrcpy-server 4.0）

1. 首次把 `scrcpy-server-v4.0` 下载到 `~/.dsh/cache/dsh-sim`，`adb push` 到
   `/data/local/tmp/dsh-sim-scrcpy.jar`（远端大小一致则跳过）。
2. `adb forward tcp:<随机端口> localabstract:scrcpy`，然后
   `adb shell CLASSPATH=… app_process / com.genymobile.scrcpy.Server 4.0
   tunnel_forward=true audio=false control=true send_device_meta=false
   send_dummy_byte=false max_size=1920 max_fps=60`。
3. **连接时序很关键**：forward 端口在设备端 socket 就绪前也会接受连接，并立刻关闭。
   因此先反复连接，直到某个连接「连上后 0.5 秒内没有断开」——那才是 video socket；
   随后**立刻**连 control。scrcpy 要两个 socket 都连上才开始推流，
   反过来“先等视频首字节再连 control”会死锁。
4. 视频流布局：

   ```
   u32  "h264"
   12B  session 包：首字节 bit7=1，[4..7] width，[8..11] height
   12B  媒体包头：bit63 保留/0，bit62=config，bit61=key，低 61 位 PTS；[8..11] 包长
   ```

   - config 包：MediaCodec CSD（Annex-B 或 AVCC 均可）→ 解析 SPS/PPS 构造 avcC，
     作为 `VideoDecoder.configure({ description })`。
   - 媒体包：若为 Annex-B（`00 00 00 01`）转换成 4 字节长度前缀的 AVCC 再解码；
     已经是 AVCC 则原样送入。
5. 控制 socket 是二进制消息：
   - `2` 触摸：action u8、pointerId u64、x i32、y i32、w u16、h u16、pressure u16、buttons u32；
   - `0` 按键：action、keycode、repeat、metastate；
   - `1` 文本：长度 + UTF-8；
   - `3` 滚动：x、y、w、h、hscroll、vscroll、buttons；
   - `11` 旋转设备。

## 应用与系统操作

除了推流和输入，工具还直接调用设备的包管理和系统命令（`lib/host/{android,ios}.js`）：

| 能力 | Android | iOS |
| --- | --- | --- |
| 安装 | `adb install -r -t <apk>` | `simctl install <udid> <app>` |
| 卸载 | `adb uninstall <pkg>` | `simctl uninstall <udid> <bundle>` |
| 启动 | `am start -n <component>` 或 `monkey -p <pkg> -c LAUNCHER 1` | `simctl launch <udid> <bundle>` |
| 打开链接 | `am start -a VIEW -d <url>` | `simctl openurl <udid> <url>` |
| 权限 | `pm grant/revoke <pkg> <permission>` | `simctl privacy <udid> <op> <service> <bundle>` |
| UI 树 | `uiautomator dump` + `exec-out cat` | 不支持（需要 WebDriverAgent） |
| 日志 | `logcat -d -t N [-s tag]` | 不支持（没有等价 logcat） |
| Shell | `adb shell <cmd>` | 不支持（iOS 模拟器没有 shell） |
| 关机 | 模拟器 `adb emu kill`；真机只断开 | `simctl shutdown <udid>` |

Android 的安装/卸载走 120–180 秒超时并校验 `Success` 输出；失败时原样返回 adb 的
`Failure [...]` 文本，方便 agent 判断是签名、版本还是路径问题。

## HTTP 路由

全部挂在 DSH webserver 的 `/_dsh/dsh-sim` 下，**不用 WebSocket**（桌面 GUI 可能来自
自定义 scheme，`ws://` 不可靠；同源 `fetch` 流在各宿主下都成立）：

| 路径 | 作用 |
| --- | --- |
| `GET /devices` | iOS 模拟器 + Android 设备 + AVD，含 OS/API/状态 |
| `POST /status` | `{sessionId}` → 运行状态、尺寸、客户端诊断 |
| `POST /start` | `{sessionId, platform, device}` → 建流 |
| `POST /stop` | `{sessionId}` → 停流 |
| `POST /control` | `{sessionId, event}` → 触摸/按键/文本/旋转 |
| `POST /screenshot` | `{sessionId}` → PNG 字节 |
| `POST /diag` | 面板上报解码帧数/错误（诊断用，附在 status 里） |
| `GET /stream?sessionId=` | 流式视频字节（iOS 为 AVCC 信封，Android 为 scrcpy 包） |

围栏（每个请求先于任何业务逻辑）：对端必须是 loopback 地址、`Host` 必须是 loopback
权威（防 DNS rebinding）、有 `Origin` 时必须同源。浏览器永远不会直连 serve-sim / adb。

## 客户端

- `ctx.inject(['betterSidebar'])` → `registerTab({ id, title, icon, single: true, component })`，
  卡片出现在右侧栏「开始」页，tab 由 better-sidebar 按会话隔离。
- `DevicePicker`：搜索 / 使用过的设备（localStorage 最近 12 个）/ 折叠的其他设备；
  每行显示运行状态点、名称、`iOS 27.2 · 已停止` 或 `Android 10 · API 29 · 运行中`。
- `H264Player`：解析 iOS 信封或 Android 包，维护 `VideoDecoder`，把 `VideoFrame`
  画到 `<canvas>`；拿到分辨率后立刻设置画布位图尺寸（避免首帧前出现 300×150 的横向空框）。
- `DeviceShell`：按宽度等比计算圆角/内边距/挖孔/Home 条/侧键，三种外壳。
- 布局：工具栏单行（下拉靠左、按钮靠右），窄宽度时依次收缩下拉、隐藏边框选择；
  连接状态是画面右下角的悬浮胶囊。
- 缩放：始终 contain（按侧栏可用宽高取较小值），拖宽侧栏即放大，设备永远完整可见。

## 已知取舍

- 每个会话只有一路流、一个观看面板；多面板共享同一流尚未实现。
- Android 停止流时额外 `pkill com.genymobile.scrcpy`，避免宿主重载后残留服务端进程。
- iOS 的 `serve-sim` 与 `ws` 通过 `lib/host/resolve.js` 在插件目录和各个 profile 的
  `node_modules` 之间解析，兼容 `link:` 安装。
