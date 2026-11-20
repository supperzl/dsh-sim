# dsh-sim

DeepSeek Harness（DSH）的设备模拟器插件：在右侧栏开一个原生 tab，显示 iOS 模拟器、Android 模拟器/真机和 iPhone 真机（HEVC 镜像），并提供 agent 工具与内置设备面板。

## 目录

```
lib/              DSH 插件宿主：sim_* 工具、路由、侧边栏 tab
engine/           设备引擎源码（面板 UI + 运行时服务端）
vendor/runtime/   随插件发布的引擎构建产物（生成，不要手改）
locale/           插件语言元数据（en/zh）
scripts/          构建与检查脚本
docs/             架构/交接说明
```

## 构建

```bash
cd engine && npm install      # 首次
cd .. && npm run build        # 从 engine/ 构建面板、给运行时打补丁、
                              # 安装到 vendor/runtime/dist，并打包 dist/dsh-sim-<version>.tgz
```

产物 tarball 可在 DSH 插件页直接安装，或把本目录作为源码 link 安装。

## 面板

- 右侧栏一个 tab，每个会话独立流（stream slot）；
- Android：scrcpy H.264；iOS 模拟器：serve-sim H.264；iPhone 真机：内置引擎的 HEVC 镜像；
- 默认中文界面：面板文案在 `engine/packages/*`，工具描述/参数在 `lib/tool_locale.js`。

## 工具

19 个 `sim_*` 工具：设备列表、启动/停止/状态、截图、点按/滑动/输入/按键、旋转、安装/卸载/启动/打开链接/权限/UI 树/logcat/shell/关机。
