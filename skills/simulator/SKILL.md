---
name: simulator
description: 用 dsh-sim 插件的侧栏「模拟器」tab 和 sim_* 工具查看、操作 iOS 模拟器、Android 模拟器/真机、iPhone 真机（HEVC 镜像）；覆盖设备发现、启停、串流、截图、点按/滑动/输入/按键、安装/启动/卸载、日志、权限。
---

# 模拟器（dsh-sim）

dsh-sim 在 DSH 右侧栏注册「模拟器」tab，每个会话独立；agent 通过 `sim_*` 工具操作当前会话正在串流的设备。工具名固定，参数用 JSON（不是命令行参数）。

## 平台能力

| 能力 | iOS 模拟器 | Android 设备/模拟器 | iPhone 真机 |
| --- | --- | --- | --- |
| 串流 | serve-sim H.264 | scrcpy H.264 | 内置引擎 HEVC |
| 截图/点按/滑动/输入/按键 | 支持 | 支持 | 支持（输入需屏幕有新帧） |
| 可访问性树 `sim_ui` | 不支持 | 支持 | 走引擎（视版本） |
| logcat `sim_logcat` | 不支持 | 支持 | 不支持 |
| shell `sim_shell` | 不支持 | 支持 | 不支持 |
| 关机 `sim_shutdown` | simctl shutdown | adb emu kill / 断开 | 只断开 |

## 基本流程

1. `sim_devices` 拿设备 id：iOS udid、Android 序列号/AVD 名、真机 udid；
2. `sim_start`（platform + device）启动串流；面板会显示画面；
3. 操作：`sim_screenshot`、`sim_tap`（0..1 坐标）、`sim_swipe`、`sim_text`、`sim_key`、`sim_rotate`；
4. 应用：`sim_install`、`sim_launch`、`sim_uninstall`、`sim_open_url`、`sim_permission`；
5. 观察：`sim_logcat`（Android）、`sim_ui`（Android）、`sim_shell`（Android）；
6. 结束：`sim_stop`（设备保持开机）或 `sim_shutdown`（关机）。

## 注意

- 坐标是**归一化**的（0..1，左上角原点），按设备实际画面计算；
- 一次会话只有一路流时，工具作用于它；面板里开了多个设备时以最近使用的那一路为准；
- 真机 iPhone 需要解锁并保持屏幕刷新；锁屏/息屏时输入会被拒绝，等画面刷新或解锁后重试；
- iOS 模拟器没有 shell、也没有可访问性树，需要元素级操作时用 `sim-testing` 技能里的方案。
