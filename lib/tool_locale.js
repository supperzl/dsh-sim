/**
 * Chinese tool descriptions for the DSH UI (the tool names stay stable).
 *
 * DSH renders tool descriptions with the session language; where the host
 * does not pass a locale to plugins we default to Chinese for these tools.
 */
export const toolDescriptionZh = {
  sim_list_apps: '列出设备上已安装的应用包名（Android；可只列第三方应用）。',
  sim_app_state: '查看当前前台应用（包名/Activity，Android）。',
  sim_stop_app: '按包名强制停止应用（Android）。',
  sim_logs: '读取设备日志（Android logcat，支持行数/过滤/级别；iOS 后续接入）。',

  sim_snapshot: '导出当前界面的元素树（带 ref 与归一化中心坐标），仅 Android；iOS 目前返回 supported:false。',
  sim_find: '按文本 / resource-id / content-desc 查找元素，返回 ref 供 sim_press/sim_fill 使用。',
  sim_press: '按 ref 或 text/id/desc 点击元素中心；多匹配会报错并列出候选。',
  sim_fill: '聚焦元素并输入文本（ASCII）。',
  sim_wait: '等待元素出现或消失（带超时），返回匹配的 ref。',
  sim_assert: '断言元素可见或不可见（text/id/desc），返回 pass 与匹配列表。',

  sim_devices: '列出这台机器可以串流的设备：iOS 模拟器（ios，含 udid/名称/运行时/状态）、已连接的 Android 设备（android）和本机定义的 Android AVD（avds）。把 id（iOS udid、Android 序列号或 AVD 名称）传给 sim_start 即可启动并在当前会话的模拟器面板里打开。',
  sim_start: '启动/连接设备，并在当前会话的模拟器面板里开始实时 H.264 串流。device 可以是 iOS 模拟器 udid（sim_devices.ios）、Android 序列号（emulator-5554 或 USB 序列号）或 AVD 名称。iOS 走 serve-sim（AVCC/H.264），Android 走 scrcpy-server（H.264）。串流只属于当前会话。',
  sim_stop: '停止当前会话的模拟器串流（设备保持开机）。',
  sim_status: '查看当前会话的模拟器面板正在串流哪台设备。',
  sim_screenshot: '截取当前设备屏幕为 PNG，返回文件路径和像素尺寸。',
  sim_tap: '在屏幕的归一化坐标（0..1，左上角为原点）处点按。',
  sim_swipe: '在两个归一化坐标（0..1）之间滑动屏幕。',
  sim_text: '向设备输入文本（ASCII；需要先打开设备键盘）。',
  sim_key: '按下硬件/导航键：home、back、recents、power、volume_up、volume_down、enter、delete、menu。',
  sim_rotate: '旋转设备。iOS 支持 portrait / landscape_left / landscape_right；Android 为切换方向。',
  sim_install: '在设备上安装应用。Android 传 .apk 路径（adb install -r -t，默认覆盖安装）；iOS 传已构建的 .app 路径（simctl install）。请先用 sim_start 启动设备。',
  sim_uninstall: '按包名（Android）或 bundle id（iOS）卸载应用。',
  sim_launch: '在设备上启动已安装的应用。Android 传包名，或用 activity 指定组件（如 com.example/.MainActivity）；iOS 传 bundle id。',
  sim_open_url: '在设备上打开 URL 或 deep link（Android 走 intent VIEW，iOS 走 simctl openurl）。',
  sim_permission: '授予或撤销权限。Android：permission 为 android.permission.*；iOS：permission 为 simctl privacy 服务（camera、microphone、photos、location、contacts 等）。',
  sim_ui: '以扁平节点列表导出设备的访问性层级（文本、content-desc、resource-id、class、bounds、clickable）。仅 Android；iOS 需要 WebDriverAgent，返回 supported:false。',
  sim_logcat: '读取已串流 Android 设备的最近 logcat 行（可指定行数和 tag 过滤）。iOS 返回 supported:false，请改用 sim_shell 执行 `log show`。',
  sim_shell: '通过 adb shell 在设备上执行命令（仅 Android）。iOS 模拟器没有 shell，会返回 supported:false。适合诊断和没有专用工具的设置操作。',
  sim_shutdown: '停止当前会话的串流并关机（iOS 用 simctl shutdown；Android 模拟器用 adb emu kill）。物理 Android 设备只断开连接。',
}

export const parameterDescriptionZh = {
  '0..1 horizontal position': '0..1 水平位置',
  '0..1 vertical position': '0..1 垂直位置',
  'Absolute path to the .apk file or .app bundle': '.apk 文件或 .app 包的绝对路径',
  'Android only: explicit component, pkg/.Activity': '仅 Android：显式组件，pkg/.Activity',
  'Android only: replace an existing install (default true)': '仅 Android：覆盖已有安装（默认 true）',
  'Android package name or iOS bundle id': 'Android 包名或 iOS bundle id',
  'Command to run inside the device': '在设备内执行的命令',
  'Gesture duration (default 300)': '手势时长（默认 300ms）',
  'How many recent lines (default 200)': '读取最近多少行（默认 200）',
  'Optional tag filter, passed to logcat -s': '可选 tag 过滤，传给 logcat -s',
  'Optional; inferred from the device id': '可选；会根据设备 id 推断',
  'android.permission.* (Android) or privacy service (iOS)': 'android.permission.*（Android）或隐私服务（iOS）',
  'http(s) URL or app deep link': 'http(s) URL 或应用 deep link',
  'iOS udid, Android serial or AVD name': 'iOS udid、Android 序列号或 AVD 名称',
}
