---
name: dsh-sim-setup
description: 安装、构建与排障 dsh-sim 插件：内置设备引擎、Node/Xcode 依赖、面板打不开、真机输入报错等问题。
---

# 安装与排障（dsh-sim）

The installed plugin contains 内置引擎 0.2.1, its resource bundle, 设备引擎 0.20.9 with its dependencies and Apple runner source, and the built MCP servers and panel. Do not install 内置引擎 with Homebrew, install a global 设备引擎 CLI, or start separate servers.

First resolve dsh-sim tools through the host's tool discovery when available.
If `sim_start` and the device-list tools are unavailable, tell the user:
"dsh-sim could not start. I'll check its setup." Follow
[missing-tools recovery](references/missing-tools.md) before stopping: inspect the
installed configuration and startup failure, explain the result, and offer a
repair for that specific failure. Do not leave the user with
terminal commands to diagnose the problem when you can run the checks. A generic
startup timeout alone does not justify increasing the timeout. Stop device setup
until the tools are available; do not claim that 当前 DSH 会话 was created too early
without evidence or work around the failure with another device backend.

1. Call `sim_start` to open the panel beside 当前 DSH 会话, or reuse an open dsh-sim panel. Use `sim_start` if the user asks for fullscreen. For an explicit tool-only workflow or a host without panels, use the device-list tools instead. The iOS tools start the bundled backend on a private loopback port and list simulators.
2. If the backend fails, read the returned error. Check that this is an Apple Silicon Mac and that `xcode-select -p` points to Xcode 26 or later. Use `xcodebuild -version` when needed. Diagnose the server's actual startup error if the tools are unavailable.
3. If no devices appear, have the user add an iOS runtime in Xcode's Settings, Components. A runtime download can be large, so do not start it without the user's request.
4. Follow the user's device choice; otherwise reuse a compatible device shared by the panel, then a suitable booted simulator. For app development, choose and boot a suitable installed simulator if none runs. Pick among equivalent devices yourself; ask only when a device choice changes what the task needs and the project gives no answer. Setup alone does not require booting a device. Confirm tool connectivity with `sim_devices`.
5. The `device_*` tools run the bundled 设备引擎 runtime, which starts on the first command. Its first iOS interaction builds the XCTest runner with the local Xcode. When a command reports that Agent Device could not start or complete it, call `sim_diagnostics` for the device and toolchain readiness it reports. Do not install 设备引擎 or start its CLI separately.

No account, token, tunnel, or hosted service is needed. Do not repeat setup after a successful connection.

For source development, `npm run vendor:baguette` downloads the pinned official archive, checks its SHA-256, and rebuilds the same source with Swift 6.4 or later to avoid macOS 27 crashes. Preparing 内置引擎 requires Xcode 27 and Git. `npm run vendor:设备引擎` installs 设备引擎 and its dependencies from the runtime lockfile without package scripts. `npm run build` copies both runtimes into `dist`, and `npm run package` creates a local marketplace and a ZIP. The installed package needs neither npm nor the source checkout.

## Android setup

The package also contains a checked-in Node.js fork of serve-emu 0.0.6, its Node dependencies, and scrcpy 4.0. Android uses the same Node runtime as the server and needs Android SDK platform-tools and emulator, and an AVD or authorized attached device. Check connectivity with `sim_devices`. The SDK lookup checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, then PATH.

Open or reuse the panel for Android work. Call `sim_devices` to discover devices; listing does not boot them. Follow the user's choice or reuse a compatible device shared by the panel. For app development, reuse a suitable running emulator or choose an installed AVD and call `sim_start` if needed. Pick among equivalent AVDs yourself; ask only when the choice changes what the task needs. The user can also enable Android in the panel toolbar and select an AVD to boot and stream it. Use the returned running serial with the dsh-sim Android tools. The panel needs WebCodecs H.264 support. Do not install a global serve-emu package or start a second app dev server.

For source development, run `npm run vendor:serve-emu` before building. It installs the fork’s pinned Node dependencies with scripts disabled and checks the scrcpy server hash. The build copies the runtime to `dist/serve-emu`; the installed package needs no npm download.
