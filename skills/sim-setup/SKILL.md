---
name: sim-setup
description: 安装、构建和排查 dsh-sim 插件：从 engine 源码构建面板、打包安装包、重启运行时、处理面板打不开/真机输入报错等问题。
---

# 安装与排障（dsh-sim）

## 安装

- 插件页安装 tarball：`dist/dsh-sim-<version>.tgz`；
- 或源码 link 安装本目录（DSH 插件页「填入插件目录」）。

## 构建

```bash
cd engine && npm install     # 首次
cd .. && npm run build       # 面板从 engine 源码构建 -> 装入 vendor/runtime/dist -> 产出 dist/dsh-sim-<version>.tgz
```

构建需要 Node ≥22（可用 `DSH_SIM_NODE` 指定）。

## 排障

- 面板打不开 `panel did not finish opening`：运行时进程没启动或旧进程卡住；先 `pkill -f 'vendor/runtime/dist/server.mjs'`，再重开面板（桥接会自愈重启）；
- 真机输入报 `Wait for a fresh physical iOS screen`：面板没有新关键帧（锁屏/息屏/刚打开）；解锁或等画面刷新，运行时会自动等 2 秒；
- 面板空白：确认 `POST /_dsh/dsh-sim/mobile-panel` 能返回 URL，且面板页 HTTP 200；
- 工具不可用：确认插件已启用、`sim_devices` 能返回设备。
