# 安装 dsh-sim（给别人的机器）

这个插件是一份纯 JS 的 DSH 插件加一份内置设备引擎，**不需要 Apple 开发者账号、不需要公证、不需要 Xcode 签名**就能用 iOS 模拟器、Android 模拟器和 iPhone 真机镜像。只有 agent-device 的 `device_*` 工具（本插件不在真机上使用）才需要 Xcode 签名。

## 系统要求

| 项目 | 要求 | 谁需要 |
| --- | --- | --- |
| 系统 | macOS 14+，Apple Silicon | 全部（内置原生组件只有 darwin-arm64） |
| DSH | ≥ 0.2.2-rc.3 | 全部 |
| Node | ≥ 22.19，或让插件回落到 DSH 自带运行时 | 引擎子进程 |
| Xcode | Xcode 26/27（含命令行工具） | iOS 模拟器；真机镜像只需要 Command Line Tools 里的 `devicectl`/usbmux 能力 |
| python3 | ≥ 3.9（系统自带或 `xcode-select --install`） | 物理 iPhone 截图/按键 |
| pymobiledevice3 | 插件自动装到 `~/.dsh/cache/dsh-sim/venv` | 物理 iPhone |
| iPhone | iOS 17+，开发者模式打开，已信任这台 Mac | 物理 iPhone |

Android 不需要额外安装：引擎自带 scrcpy-server；iOS 模拟器由内置引擎的 serve-sim 串流。

## 安装

**从 npm（推荐，别人也用这个方式）**

```bash
# 在 DSH 的插件页搜索/安装 dsh-sim@0.2.0，或手动：
# 1) 依赖写进当前 profile
python3 - <<'EOF'
import json, os
profile = os.path.expanduser('~/.dsh/profiles/desktop/package.json')
data = json.load(open(profile))
data.setdefault('dependencies', {})['dsh-sim'] = '^0.2.0'
data['dsh']['profile']['bundles'] = list(dict.fromkeys(data['dsh']['profile']['bundles'] + ['dsh-sim']))
json.dump(data, open(profile, 'w'), indent=2, ensure_ascii=False)
EOF
cd ~/.dsh/profiles/desktop && npm install       # 或 pnpm install
# 2) 重启 DSH 桌面端（宿主插件要重新加载）
```

**从本地目录（开发/内测）**

```bash
cd ~/.dsh/profiles/desktop
npm install --save "link:/path/to/dsh-sim"
# 再把 "dsh-sim" 加进 dsh.profile.bundles，重启 DSH
```

**从打好的 tgz（不发布 npm 也能分发）**

```bash
cd /path/to/dsh-sim && npm pack          # 产出 dsh-sim-0.2.0.tgz
cd ~/.dsh/profiles/desktop
npm install --save "file:/path/to/dsh-sim-0.2.0.tgz"
```

安装后重启桌面端，右边栏出现「模拟器 / 模拟器 2 / 模拟器 3」三个 tab（每个会话独立）。

## 第一次使用

1. 打开「模拟器」tab：第一次会启动内置引擎（约 1 秒），面板列出设备；
2. iOS 模拟器 / Android：直接选设备即可，不需要再装东西；
3. **iPhone 真机**：插上数据线（或同一 Wi-Fi），手机上点「信任」，并把「设置 → 隐私与安全性 → 开发者模式」打开；然后在 DSH 里调用一次 `sim_setup`（或对着 agent 说「检查模拟器环境」）：

   - `sim_setup { "action": "install" }` 会装好 `pymobiledevice3`（到 `~/.dsh/cache/dsh-sim/venv`）、给内置原生组件补 ad-hoc 签名、并列出还缺什么；
   - 首次调用 `sim_devices` 时，如果系统能看到 iPhone 但 `pymobiledevice3` 还没装，插件会自动装一次。

4. iPhone 第一次镜像需要 Developer Disk Image：装了 Xcode 就自动可用；没装 Xcode 时执行一次
   `~/.dsh/cache/dsh-sim/venv/bin/pymobiledevice3 mounter auto-mount --udid <UDID>`。

## 签名：到底需要签什么

- **插件本身**：不需要签名/公证。它是 JS 插件，由已经签名的 DSH 加载，不经过 Gatekeeper。
- **内置原生组件**（`vendor/runtime/dist` 里的 `ios-mirror/*.node`、`baguette/Baguette` 等 17 个 Mach-O）：随包发布的是 **ad-hoc 签名**。`setup.js` 会在每次启动时校验，失效就用 `codesign --force --sign -` 重签；npm 安装不会给文件打 quarantine，所以能直接运行。
- **iPhone 真机镜像 / 点击**：**不需要** Apple 开发者账号、不需要签名 team。走的是设备自带的 CoreDevice 服务（配对 + 开发者模式），不是 XCTest。
- **Xcode 签名（只有 agent-device 的 `device_*` 工具需要）**：插件内置的 XCTest runner 工程已恢复成上游形态（bundle id 走 `AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID` 等环境变量、team 为上游默认），本插件的真机路径不再使用它。若你确实要用 `device_*`，把 `~/.dsh/dsh-sim/runtime.env` 写上自己的 team/bundle id，然后 `npm run fix:runner` 把它们写进工程。

## 卸载

```bash
cd ~/.dsh/profiles/desktop
npm uninstall dsh-sim
# 从 dsh.profile.bundles 里删掉 "dsh-sim"，重启 DSH
rm -rf ~/.dsh/cache/dsh-sim          # 可选：清掉 pymobiledevice3 环境
```

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板显示 `Screen unavailable — has not produced a screen frame` | 手机锁屏/屏幕熄灭，或显示流被别的进程抢走（例如手动跑过 `pymobiledevice3 … display serve-web`）。插件会自动重启镜像；再不行 `pkill -9 -f ios-mirror-service.mjs` 后重开面板 |
| `sim_tap` 报 `Wait for a fresh physical iOS screen` | 0.2.0 起每个手势步骤都会自己重试，正常不该再出现；出现请 `sim_setup {"probe":true}` 看镜像是否健康 |
| 真机列表是空的 | 没信任本机 / 没开发者模式 / pymobiledevice3 未装：`sim_setup {"action":"install"}` |
| iOS 模拟器打不开 | 需要 Xcode 26+ 和 `xcodebuild -runFirstLaunch` 同意协议 |
| Android 看不到设备 | `adb devices` 确认授权；引擎自带 scrcpy-server，不需要单独装 |
