# dsh-sim 交接文档（给 Codex）

日期：2026-11-20 · 交接人：DSH agent · 版本：0.1.36（代码）／插件以源码 link 安装

## 1. 代码位置与运行环境

- 开发目录：`/Users/leon.zhao/dsh-sim`
- GitHub：https://github.com/supperzl/dsh-sim （main，最新提交 `925faef`）
- DSH 桌面 profile：`~/.dsh/profiles/desktop`，插件通过 **目录 link** 安装（不是 npm 包），版本显示 0.1.36。
- 本地安装/重载插件：用 DSH 的 `plugin_manager`（remove_bundle + install_bundle `/Users/leon.zhao/dsh-sim`），或在插件页 toggle；重装后前端包需要**刷新页面/重开 tab** 才生效。
- npm 已发布版本仍是 `dsh-sim@0.1.9`（public），与当前代码差距很大，尚未重新发布。
- 运行时依赖：Node ≥ 22（`DSH_SIM_NODE` 可指定，否则用 PATH 里的 `node`，本机还会优先用 Codex 自带的 node）。

## 2. 架构（当前实现）

面板现在**不是我们自己的 UI**，而是内置了 Mobile Dev（Callstack，MIT）的运行时，把它的面板嵌进 DSH 侧栏 tab。

```
lib/index.js                 插件入口：注册 19 个 sim_* 工具 + 挂路由
lib/tools.js                 工具实现（sim_devices/start/stop/... 共 19 个）
lib/tool_locale.js           工具描述 + 参数描述的中文表
lib/host/manager.js          按 (sessionId, streamId) 管理流；iOS 模拟器/Android/真机 iOS
lib/host/routes.js           /_dsh/dsh-sim/* 路由
lib/host/devices.js          simctl + adb + AVD 设备枚举
lib/host/ios.js              iOS 模拟器 serve-sim 流与控制
lib/host/android.js          Android scrcpy 流与 adb 工具
lib/host/ios_device.js       真机 iOS（CoreDevice/pymobiledevice3 serve-web）— 旧方案，保留
lib/host/device_runtime.js   启动/管理内置运行时（原 Mobile Dev MCP server），返回面板 URL
lib/client.js                DSH 侧栏 tab（当前注册的是 MobileDevTab：iframe 面板 URL）
vendor/runtime/              内置运行时（97MB，gitignore，不进 git）
locale/runtime-zh.json       面板 797 条中英词表
scripts/localize-runtime.mjs 对 vendor 运行时做本地化/补丁的构建脚本
```

关键路由（挂在本机 DSH webserver 上，loopback + 同源校验）：

- `POST /_dsh/dsh-sim/mobile-panel` → 启动运行时并返回面板 URL（`{"ok":true,"url":"http://127.0.0.1:<port>/<token>/?tool=mobile_open_simulator"}`）
- 旧的 `sim_*` 流路由：`/devices /status /start /stop /control /screenshot /diag /logs /shutdown /codec /stream`

`device_runtime.js` 的行为：

1. 从 `vendor/runtime/dist/server.mjs` 启动运行时（`MOBILE_DEV_PANEL=browser`，browser 面板模式）；
2. 走 MCP stdio 调 `mobile_open_simulator`，从返回文本里解析面板 URL；
3. 复用前先探活，挂了自动重启（自愈）；
4. 面板由运行时自己的 HTTP 服务提供，**没有反向代理**（代理会破坏面板自己的 MCP streamable-HTTP 端点）。

## 3. 已经做过的改动（vendor 内，gitignore，靠脚本复现）

`vendor/runtime/dist/` 是从本机 Codex 缓存拷来的 Mobile Dev 0.1.183 dist，做过：

1. **CSP 放宽**：`server.mjs` 里面板响应的 `content-security-policy` 从 `frame-ancestors 'none'; base-uri 'none'` 改为 `base-uri 'none'`，否则 DSH tab 无法 iframe。
2. **真机输入保护放宽**：`server.mjs` 的 physical iOS input 在 keyframe generation 不匹配时，原来直接抛 `Wait for a fresh physical iOS screen before sending input.`，现在先等最多 2 秒新帧再放行。
3. **位置预设中文化**：`app.html` 里的 `$Ae=[{value:"cupertino",...}]` 数组替换成北京/上海/广州/深圳/杭州/成都/武汉/西安（真实经纬度）。
4. **中文翻译**：`locale/runtime-zh.json`（797 条）通过 `scripts/localize-runtime.mjs` 直接替换 `app.html`/`browser-panel.html` 里的引号字符串 —— **这一步有已知问题，见第 4 节**。

## 4. 当前问题（重点）

### P1. 面板界面仍是英文（主要未完成项）

现象：面板菜单、设置、各工具视图（性能/存储/性能追踪/应用流程/测试）仍是英文。

经过：

- 运行时面板由两个文件组成：`browser-panel.html`（约 700KB 的壳，`/panel` 返回的就是它）和 `app.html`（约 3.9MB，真正的应用 UI，所有 `Live performance`、`Choose an app` 等文案都在这里）。
- 直接把 `locale/runtime-zh.json` 的 797 条字符串替换进 `app.html`（共 1158 处）后，面板启动失败，宿主报 **“模拟器 could not open: 模拟器's panel did not finish opening. Reload this page to try again.”**
  - 原因判断：被替换的字符串里有一部分不是展示文本，而是应用内部查表用的**键/枚举值**；键被改了导致初始化失败、面板没能完成 MCP 握手。
  - 处理：已把 `app.html`、`browser-panel.html` 从 Codex 缓存恢复成原版（面板恢复可用，但界面回到英文）。
- 随后尝试**运行时 DOM 翻译**：把 797 条词表做成一个 `<script>`（只翻译文本节点与 title/aria-label/placeholder，不碰键名）注入 `app.html` 的 `</head>` 前，同时重新应用了国内城市预设。
  - 这一步**尚未验证成功**：面板的壳页面 (`browser-panel.html`) 和真正的 app 文档不是同一个 HTTP 请求；app 很可能是壳页面从 MCP 资源（`simulator.html` / `ui://mobile-dev/...`）取到后挂载的。需要先确认“app 文档实际是哪个 URL/文档”，再把翻译脚本注入到那个文档。
  - 验证方法：打开面板 URL，看菜单/设置是否中文（可截图 + OCR）；也可在运行时目录里搜索 app 文档的实际服务路径。

建议的解决路径（二选一）：

A. **找到 app 文档的真实来源**：在 `browser-panel.html` 里搜 `simulator.html` / `ui://` / `mcp` / `iframe`，确认它怎么加载 app；把翻译脚本注入到那份内容（或运行时返回该资源的地方），保留 DOM 翻译方式（安全，不动键）。
B. 若 app 是壳页面内联渲染，则把翻译脚本注入壳页面即可；之前注入壳页面没生效，说明不是这条路。

**注意**：不要再全局替换 `app.html` 的字符串（会再次导致面板打不开）；需要替换时只处理确认是展示文本的字符串，并在每次改动后重启运行时、重开面板实测。

### P2. 中文化没有自动验收

目前只能：重启运行时 → `POST /_dsh/dsh-sim/mobile-panel` 拿 URL → 在 DSH 侧栏打开 → 截图/OCR 看标签是否中文。建议 Codex 做一个小的 Playwright/Chromium 脚本连面板 URL，读取 `document.body.innerText` 做断言。

### P3. vendor 不在 git 里（97MB）

- `vendor/` 在 `.gitignore` 里，仓库 clone 下来没有运行时；npm 包通过 `package.json` 的 `files` 会把 `vendor` 打进去，但当前没有任何构建步骤在打包前生成/打补丁。
- `scripts/localize-runtime.mjs` 已实现：CSP 放宽、真机输入等待、词表替换、城市替换 —— 但它对 `app.html` 的字符串替换是 **P1 里已知会坏掉面板** 的做法，需要改成注入翻译脚本的方式。
- 需要 Codex 补：`scripts/build-release.mjs` 在打包前先 `localize-runtime.mjs`（新版、安全的注入方式），确保 npm 包内的面板是中文且可用。

### P4. 其他待办

- npm 发布：代码 0.1.36，npm 还停在 0.1.9；需要重新 `npm publish`（注意 2FA/PTY 流程，见 memory）。
- README/文档还停留在旧架构（自研面板 + 19 工具），需要更新成“内置运行时面板”的说明。
- awesome-dsh-plugin 的收录 PR 仍在等仓库满 1 天后的 gate 重跑（原 PR #17094）。
- 其他用户没有 Codex：运行时来自 npm 包内的 `vendor/`，但首次使用设备时运行时可能从 GitHub release 下载 Baguette/镜像组件（网络依赖）。

## 5. 常用操作与命令

```bash
# 目录
cd /Users/leon.zhao/dsh-sim

# 看当前插件版本/工具（DSH 插件页 toggle 即可重载）
# 面板 URL（DSH GUI 端口见会话里的 Web GUI URL，例如 http://127.0.0.1:59927）
curl -s -X POST -H 'Origin: http://127.0.0.1:59927' -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:59927/_dsh/dsh-sim/mobile-panel

# 重启运行时（杀掉子进程后桥接会自愈重启）
pkill -f 'vendor/runtime/dist/server.mjs'

# 对 vendor 运行时应用补丁（当前版本包含 CSP/输入等待/城市/词表替换）
node scripts/localize-runtime.mjs

# 检查面板页
curl -s -o /dev/null -w '%{http_code}\n' '<panel-url>'
```

## 6. 重要约束（用户明确要求）

- 面板必须是**中文**（工具描述/参数描述/面板标签都要中文），语言跟随 DSH 默认语言；
- 位置预设要用**国内城市**，不是美国城市；
- 面板要嵌在 DSH 侧栏 tab 里（不是外部网页），不要体现 Mobile Dev 品牌（目录、标题、界面品牌都改为「模拟器」/Simulator）；
- 交付要可用：面板能打开、真机 iOS/Android 能连、输入不报错；改完必须自己截图/OCR 验证，不要未验证就报完成。

## 7. 已知可用/已验证的部分

- 19 个 `sim_*` 工具（模拟器/Android/真机 iOS 的旧路径）工作正常，工具描述与参数描述已中文；
- 面板能启动并渲染设备视图（截图确认过设备列表与画面）；
- 真机 iOS 输入报错已修（等待新帧）；
- 国内城市预设已应用；
- 面板 CSP 已放宽，DSH tab 可嵌入。
