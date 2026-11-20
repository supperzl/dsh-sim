# dsh-sim 交接文档（2026-11-20 16:30）

仓库：`/Users/leon.zhao/dsh-sim`（GitHub supperzl/dsh-sim，分支 main）
DSH 以源码 link 安装本目录；插件名 dsh-sim，侧栏 tab「模拟器」。
用户当前诉求：**面板画面必须和 iPhone 真机实时同步**（用户说手机一直解锁亮屏，不是手机问题）。

## 一、项目结构现状

```
lib/                     DSH 插件宿主
  index.js               注册工具 + 挂路由
  tools.js               29 个 sim_* 工具
  tool_locale.js         工具/参数中文描述
  host/manager.js        会话流管理（iOS 模拟器 / Android / 真机 iPhone）
  host/engine_device.js  sim_* → 内置引擎 device_* 的桥接（真机输入走这里）
  host/device_runtime.js 启动内置引擎（MCP server），返回面板 URL；killStaleEngines
  host/ios_device.js     真机 iOS：pymobiledevice3 截图 + (旧) serve-web 流
  host/routes.js         /_dsh/dsh-sim/* 路由
  client.js              侧栏 tab（当前是 MobileDevTab：iframe 引擎面板 URL）
engine/                  上游 monorepo 源码（面板 UI + 服务端），已删上游 CI/agent 等
vendor/runtime/dist/     实际运行的引擎（当前是 Codex 缓存里的 0.1.189 原版 dist）
vendor/runtime/dist.0.1.183/  上一版备份（0.1.183，曾被我们构建/改过）
skills/                  我们自己的技能：simulator / sim-testing / sim-setup / sim-e2e
locale/                  插件 locale（en/zh 元数据）
scripts/                 build-panel.mjs、localize-runtime.mjs、check.mjs
~/.dsh/dsh-sim/runtime.env  引擎环境变量（签名用，见下）
```

运行中的引擎：`vendor/runtime/dist/server.mjs`（0.1.189，单个实例；有 Baguette、ios-mirror-service 子进程）。
面板 URL 获取：`POST http://127.0.0.1:<DSH_GUI_PORT>/_dsh/dsh-sim/mobile-panel`，返回 `{"ok":true,"url":"http://127.0.0.1:<port>/<token>/?tool=mobile_open_simulator"}`。

## 二、最近做过的操作（按时间）

1. **真机签名打通**
   - 修改 runner 工程（`vendor/runtime/dist/agent-device/.../AgentDeviceRunner.xcodeproj/project.pbxproj`）：
     - `DEVELOPMENT_TEAM` 从上游 `2S799L9W4M` → 用户团队 `4588W2ZBP4`；
     - bundle id 从 `com.callstack.agentdevice.runner` → `com.leon.dshsim.agentdevice.runner`（UITest target 同步 `.uitests.xctrunner`）；
   - `~/.dsh/dsh-sim/runtime.env`（插件启动引擎时注入）：
     ```
     AGENT_DEVICE_IOS_TEAM_ID=4588W2ZBP4
     AGENT_DEVICE_IOS_SIGNING_IDENTITY="Apple Development: 15808505050@qq.com (7NBF43J4GY)"
     AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.leon.dshsim.agentdevice.runner
     AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.leon.dshsim.agentdevice.runner.uitests.xctrunner
     ```
   - 结果：`xcodebuild build-for-testing` 成功，runner 装到真机；`device_home` 返回 `Home`，`device_click` 返回 `Tapped (201, 437)`。

2. **真机输入路径反复调整**
   - 先走 serve-web HID（真机动，面板不动）；
   - 再改走引擎 `device_home/device_gesture/device_swipe`（错误的 tap API，已改 `device_click {target:{kind:'point'}}`；点坐标 = 归一化 × (402,874)）；
   - 每个工具动作：`device_open` → 动作 → `device_close`（finally），避免占用设备；遇 DEVICE_IN_USE 会 `pkill agent-device daemon` 后重试；
   - 当前 `manager.start`（真机）**不再启动 serve-web 流**，只登记 entry；`sim_screenshot`（真机）用 `pymobiledevice3 developer core-device screen-capture screenshot --udid`。

3. **引擎切换**
   - 最初用 0.1.183 dist（我们改过 CSP、签名）；
   - 后来整包换成 **0.1.189 原版 dist**（用户 Codex 同版本），重新打了 CSP 补丁和 runner 签名补丁；
   - 面板由源码重建过（中文化），后因启动失败/版本不一致回退到原版。

4. **中文化**
   - 面板文案在 `engine/packages/mcp-app` 源码里改过（约 480 处 + 281 条句子），源码构建出过中文面板；
   - 但当前运行的 0.1.189 原版面板是**英文**；
   - `vendor/runtime/dist/server.mjs` 有中文注入脚本（部分词条），但不完整/未验证。

## 三、当前问题（核心）

**真机画面在面板里不更新**。具体现象：

- 手机是解锁、亮屏的（用户确认）；
- 我们的 `sim_screenshot`（pymobiledevice3 CoreDevice 截图）立刻能拿到 1206×2622、时间 16:23/16:25 的主屏截图；
- 但引擎面板显示：**“Screen unavailable — The iPhone has not produced a screen frame. Unlock it and retry.”**；
- 更早（16:20 左右）面板曾显示帧，但画面停在 **Agent Device Runner**（XCTest runner 应用界面），时间定格，之后不再更新；
- 现象与输入方式无关：面板自己滑动时手机在动、面板画面不动；工具操作时也一样。

已排查/排除：
- 手机锁屏（用户确认一直解锁亮屏）；
- 面板缓存（多次重开面板 URL、加 `&v=` 参数刷新）；
- 重复引擎（已加 `killStaleEngines`，当前只剩 1 个 server）；
- 设备被会话独占（动作后 `agent-device device status` 显示 “No local device claims found”）；
- native addon 加载（`ios-mirror/darwin-arm64.node` 在 Codex node 和系统 node 下都能 require）。

**怀疑方向**（交给新会话验证）：
1. **两个 CoreDevice display 消费者冲突**：之前 `sim_start` 会起 pymobiledevice3 serve-web（CoreDevice display 服务），与引擎的 ios-mirror 抢同一路显示流；现已移除 serve-web，但面板仍显示 no frame —— 可能引擎的 mirror 会话本身没起来（需要看 `ios-mirror-service` 日志/引擎 stderr）。
2. **XCTest runner 抢占前台**：`device_open`（agent-device）会把 AgentDeviceRunner 拉起到前台，引擎镜像可能跟丢；0.1.183 时面板显示的就是 runner 界面。Codex 里同样的 runner 却能正常镜像，需要对比 Codex 的启动参数/流程。
3. **0.1.189 版本差异**：换 0.1.189 后从“帧停在 runner”变成“完全 no frame”，可能是 0.1.189 的 mirror 启动方式不同（例如需要 devicectl tunnel/DTX、或 Screen Recording 权限）。
4. 需要看引擎日志：`vendor/runtime/dist/server.mjs` 的 stderr（插件里通过 `device_runtime.js` 的 logger 输出）、`ios-mirror-service.mjs` 的日志、以及 `~/.agent-device/apple-runner/...` 的 runner 日志。

## 四、当前可用的东西

- `sim_devices`：会列出 `physical`（朴圣佑's iPhone / 00008150-000111563A20401C / iOS 27.2.1）；
- `sim_start`（真机）：只登记 entry（无 serve-web），返回 running/physical；
- `sim_screenshot`（真机）：pymobiledevice3 screen-capture，能出图（1206×2622）；
- `sim_key home` / `sim_tap` / `sim_swipe`（真机）：走引擎 runner，能执行（返回 Home / Tapped / fling 回执）；
- Android：scrcpy 流、元素级工具、日志全部正常（用户确认 Android 没问题）；
- iOS 模拟器：serve-sim 流正常，元素级工具返回 supported:false。

## 五、关键命令

```bash
# 面板 URL（DSH_GUI_PORT 见运行上下文）
curl -s -X POST -H 'Origin: http://127.0.0.1:<PORT>' -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:<PORT>/_dsh/dsh-sim/mobile-panel

# 面板健康
curl -s -o /dev/null -w '%{http_code}\n' '<panel-url>'

# 引擎进程
pgrep -fl '[v]endor/runtime/dist'

# 设备占用
cd ~/dsh-sim/vendor/runtime/dist/agent-device/node_modules/agent-device
node bin/agent-device.mjs device status --platform ios --udid 00008150-000111563A20401C

# 上次引擎工具结果
cat /tmp/dsh-sim-engine-last.json
```

## 六、用户明确要求

- 不要让用户测试/点页面，代理自己截图核对（手机截图 vs 面板截图 OCR 对比）；
- 面板必须和真机画面实时同步；
- 不出现 Mobile Dev 品牌，中文界面；
- 交付可安装的插件（npm 包/目录），源码在仓库、构建命令可复现。
