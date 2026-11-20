---
name: sim-testing
description: 对 iOS 模拟器、Android 设备或 iPhone 真机上的 app 做自动化测试：元素级快照/查找/点击/输入、等待与断言、失败取证；不依赖坐标。
---

# 设备自动化测试（dsh-sim）

坐标点击不稳定，测试优先用**元素级**操作。核心循环：

1. 确保设备在跑：`sim_devices` → `sim_status`；没跑就 `sim_start`；
2. `sim_snapshot`：导出当前界面树（带 ref），iOS/Android 统一；
3. `sim_find`：按文本/testID/ref 找元素；多匹配时用更窄的条件；
4. `sim_press`（ref）/ `sim_fill`（ref + 文本）：操作元素；
5. `sim_wait`：等元素出现/消失、等文本、等空闲（带超时）；
6. `sim_assert`：断言可见/文本/属性；失败时输出原因；
7. 失败取证：`sim_screenshot` + `sim_logs`（Android logcat / iOS 引擎日志）。

## 原则

- 用最新快照里的 ref 或稳定 selector，不要用上一次的 ref；
- 每一步操作后要验证（wait/assert），截图本身不算验证；
- 等待要带超时，超时后失败而不是无限等；
- 测试前先 `sim_launch` 目标 app，并确认前台 app 正确（`sim_app_state`）；
- 弱网/深色模式/语言等场景测试用环境类工具（见下）。

## 工具

当前已可用：`sim_screenshot`、`sim_tap`、`sim_swipe`、`sim_text`、`sim_key`、`sim_rotate`、`sim_ui`（Android）、`sim_logcat`（Android）、`sim_launch`、`sim_stop`、`sim_devices`、`sim_status`。

元素级工具（规划中，上线后本技能随之更新）：`sim_snapshot`、`sim_find`、`sim_press`、`sim_fill`、`sim_wait`、`sim_assert`。
应用：`sim_list_apps`、`sim_launch`、`sim_stop_app`、`sim_app_state`、`sim_open_url`
取证：`sim_screenshot`、`sim_logs`、`sim_performance`
环境：`sim_set_network`、`sim_set_location`、`sim_set_appearance`

## 平台差异

- Android：`sim_ui` 可直接拿 AX 树；logcat 可用；
- iOS 模拟器：AX 树通过引擎；无 shell/logcat，用截图+引擎日志；
- iPhone 真机：输入前确认屏幕有新帧，操作后等画面更新再断言。
