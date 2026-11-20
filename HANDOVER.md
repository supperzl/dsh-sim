# dsh-sim 交接文档（2026-11-20 17:20 更新：真机镜像问题已修复）

仓库：`/Users/leon.zhao/dsh-sim`（GitHub supperzl/dsh-sim，分支 main）
DSH 以源码 link 安装本目录；插件名 dsh-sim，侧栏 tab「模拟器」。

## 一、问题与结论

**现象**：iPhone 真机在引擎面板里不更新，面板显示
`Screen unavailable — The iPhone has not produced a screen frame. Unlock it and retry.`，
但手机解锁亮屏、`pymobiledevice3` 截图正常；更早时面板曾显示帧但停在 Agent Device
Runner（XCTest runner 界面）。

**根因（已实测确认）**：真机屏幕的 CoreDevice 显示流只能有一个消费者。

1. `pymobiledevice3 … developer core-device display serve-web`（旧代码里真机
   `sim_start` 会起它）一旦启动，就会把显示流从引擎镜像手里抢走：镜像当场掉到 0 帧，
   而且**永不再恢复**（实测：抢走后 addon 的 `read()` 只返回空批次，`video_packets`
   冻结，重发 FIR 关键帧请求也没用）。
2. 引擎的镜像服务（`ios-mirror-service.mjs`，detached 单例）对一台 iPhone 只持有一个
   capture；capture 被抢走后 watchdog 之前没有任何超时，pump 一直空转，所有后续订阅者
   （面板）都拿不到帧 → 面板 15s 后报上面那句提示。这个僵尸 capture 会活到服务进程被
   杀为止，所以换引擎、重开面板都救不回来。
3. 旧代码里真机点按走 agent-device 的 XCTest runner：每次点按都要 `device_open` →
   前台拉起 runner → `device_click` → `device_close`。runner 一起一落既抢前台（面板看到
   的就是 runner），又要重新 build/install（实测可卡 1~2 分钟）。

**修复（已落地并实测）**：

| 位置 | 改动 |
| --- | --- |
| `lib/host/ios_device.js` | 删除 serve-web 串流类；只保留设备枚举、截图和 `hid button` 按键 |
| `lib/host/device_runtime.js` | 启动引擎时清理残留 serve-web；新增 `readResource`、每次写入的 generation、按 dist 精确清理旧引擎、`DSH_SIM_RUNTIME_DIST` 覆盖、面板活跃标记 |
| `lib/host/ios_mirror.js`（新） | 真机输入的唯一边界：每个手势开一个镜像会话并等关键帧；`preparePhysicalMirror` 探活 + 修复 + epoch；`repairMirror` 重启镜像服务 |
| `lib/host/manager.js` | 真机 start 只登记 + 创建 mirror；touch/scroll 走镜像 HID；home/lock/volume 走 `hid button`；文本/旋转明确报不支持；面板活跃时用镜像输入，否则用 pymobiledevice3 universal-hid |
| `lib/host/routes.js` | `/mobile-panel` 先探活镜像，返回 `&mirror=<epoch>`；epoch 变化会让侧栏重新加载 iframe |
| `scripts/localize-runtime.mjs` | 运行期补丁：CSP 放行、输入等待新帧、**镜像 watchdog**（空批次 + 已请求关键帧 ≥6 次即报错，让服务能自愈而不是僵死） |
| `HANDOVER.md` | 本文 |

> 注意：`vendor/runtime` 是生成目录。重建方式 `node scripts/localize-runtime.mjs`
> （`npm run build` / `prepack` 也会跑）；`dist.0.1.183` 只是旧版备份。

## 二、真机现在的输入/画面通路

```
面板画面：引擎 HEVC 镜像（唯一显示流消费者）
点按/滑动：engine mobile_ios_mirror_session → 读一帧关键帧 → mobile_ios_mirror_input
           （每个手势一个短会话，约 0.5~1.5s；会话在请求结束后约 1s 失效，
             所以一个手势的所有输入都在同一个会话里发完）
主页/锁屏/音量：pymobiledevice3 developer core-device hid button <name>
截图：pymobiledevice3 developer core-device screen-capture screenshot（不干扰镜像）
无面板时：pymobiledevice3 developer core-device universal-hid-service tap/drag
          （它会占用显示流，所以只在 panelServedRecently() 为 false 时使用）
```

坐标：工具层是 0..1 归一化（左上原点），镜像输入按逻辑点 `402×874`（= 1206×2622 / 3）；
`hid button` 只认名字。

## 三、已验证（2026-11-20 17:00–17:20）

- 面板在 DSH 桌面端（Electron 44 / Chrome 152）实时出帧：面板时钟与手机一致；
- `sim_tap(0.58, 0.709)` 让手机打开「设置」，面板同步显示设置页；
- `sim_swipe` 上下滑动设置列表，手机与面板同步（滑动分 4 组、间隔 25ms 发送，否则 iOS
  会当成零位移 fling 丢掉）；
- `sim_key home` 1.2s 回到桌面（HID 按键，不拉 runner）；
- 无面板时 `sim_tap` 走 universal-hid，约 1.7~2.1s；
- 镜像被抢/僵死时：`/mobile-panel` 探活失败 → 重启镜像服务 → epoch+1 → 侧栏重载面板；
- 面板自带的重连（约 10s）也能在服务重启后自己恢复。

## 四、排障速查

```bash
# 面板 URL（第二个字段 mirror 是 epoch）
curl -s -X POST -H 'Origin: http://127.0.0.1:<PORT>' -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:<PORT>/_dsh/dsh-sim/mobile-panel

# 引擎 / 镜像服务进程
pgrep -fl 'vendor/runtime/dist/server.mjs'
pgrep -fl 'ios-mirror-service'

# 显示流是否被别的进程抢走（有输出就是有残留，必须杀掉）
pgrep -fl 'core-device display serve-web'

# 真机截图（不干扰镜像）
~/.dsh/cache/dsh-sim/venv/bin/pymobiledevice3 developer core-device screen-capture \
  screenshot /tmp/p.png --udid <UDID>

# 插件热重载（改 lib/*.js 后不用重启 DSH）
#   用 plugin_manager: set_plugin include:dsh-sim enabled=false，再 enabled=true
```

- 镜像服务僵死时可以直接 `pkill -9 -f ios-mirror-service.mjs`，下次打开面板会自动重建。
- 服务器端日志（`[mobile-dev:ios-mirror] …`）走引擎 stderr，被插件的
  `device_runtime.js` 转发到 DSH 日志。

## 五、分发（0.2.0 起）

- `sim_setup` 工具（`lib/host/setup.js`）：检查系统/Node/内置引擎补丁/原生组件签名/python3/pymobiledevice3/Xcode/真机，
  `action:"install"` 会自动把 pymobiledevice3 装进 `~/.dsh/cache/dsh-sim/venv` 并重签失效的 Mach-O；
  `sim_devices` 首次遇到"系统能看到 iPhone 但 pymobiledevice3 没装"时也会自动装一次。
- 签名：插件本体不需要签名/公证；内置 17 个 Mach-O 是 ad-hoc 签名并在启动时校验/重签；真机镜像与点击**不需要**
  Apple 开发者账号（走 CoreDevice，不是 XCTest）。
- `scripts/fix-runner-signing.mjs`：打包前把内置 XCTest runner 恢复成上游签名（bundle id 走环境变量、team 上游默认），
  避免把本机 team 发给别人；`npm run fix:runner` 可写回本机身份（只有 agent-device 的 `device_*` 需要）。
- package.json：0.2.0、`engines.node >=22.19` + `engines.dsh >=0.2.2-rc.3`、`os/cpu` 限 darwin/arm64、files 不含旧版备份。
- 打好的包：`npm pack` → `dsh-sim-0.2.0.tgz`（33 MB，956 files，无 dist.0.1.183、无本机 team id）。
- 发布（需要用户的 npm 账号/2FA，代理没有凭据）：
  ```bash
  cd ~/dsh-sim && npm version patch && npm publish        # npm 包名 dsh-sim 属于 supperzl
  ```
  用户安装：DSH 插件页装 `dsh-sim@0.2.0`，或 profile `dependencies` + `dsh.profile.bundles` 加 `dsh-sim`。
  详见 `docs/INSTALL.md`。

## 六、还没做的事

- 中文面板：当前 `vendor/runtime/dist` 仍是 0.1.189 **英文原版**面板；中文化脚本
  （`scripts/localize-runtime.mjs` 只覆盖补丁）和 `engine/packages` 里的中文源码还没有
  重新构建进 dist。需要时 `node scripts/build-panel.mjs` 从 `engine/` 重建并重新打补丁。
- npm 发布与 GitHub Release 附件：需要用户自己的 npm 凭据（2FA），本次只做到打包验证。
- 真机文本输入：镜像只有触摸 HID，`pymobiledevice3 universal-hid-service type` 会抢显示流，
  目前 `sim_text` 在真机上明确报“不支持”。
- 物理 iPhone 旋转：CoreDevice 没有对应能力，`sim_rotate` 明确报不支持。
- `lib/client.js` 里还留着早期自绘 HEVC 播放器（`/codec`、`/stream` 路由）的死代码，
  当前 UI 只用 `MobileDevTab` 的 iframe；清理时注意别动 `/mobile-panel`。

## 六、交付

- 源码即交付：本目录作为 DSH profile 的 `link:` 依赖；
- 静态检查：`node scripts/check.mjs`（13 个模块 + manifest）；
- 打包：`node scripts/build-panel.mjs`（构建面板并修改 `vendor/runtime/dist`，产出
  `dist/dsh-sim-<version>.tgz`）。
