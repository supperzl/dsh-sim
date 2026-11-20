---
name: sim-testing
description: 用 dsh-sim 的设备引擎对本地 iOS 模拟器或 Android 设备上的 app 做元素级自动化：快照与 ref、点击、输入、滚动、等待、断言，并确认 app 到达预期状态。
---

# 设备自动化测试（元素级）

dsh-sim bundles 设备引擎 0.20.9 and serves each of its commands as a `device_<command>` tool: `sim_start` is its `open` command, and so on. No global CLI install, npx download, or separate server is needed. Follow the dsh-sim skill to choose the device and to build, install, and launch the app; this skill covers driving it.

Read [the workflow guide](references/workflow.md) before the first task. It is this 设备引擎 version's own `help workflow`, written for its CLI. With the tools:

- Pass each command's options as the JSON fields in its tool's input schema, not as flags: `snapshot -i` is `sim_snapshot` with `interactiveOnly: true`, and `--settle` is `settle: true`.
- Commands that act on an element take a `target` object instead of a positional ref or selector: `{ "kind": "ref", "ref": "@e12" }` or `{ "kind": "selector", "selector": "label=\"Search\"" }`.
- Skip the guide's shell advice, such as chaining commands with `&&`. Its `help <topic>` pointers are not available through the tools; each tool's description gives that command's contract.
- `logs` and `perf` are not served; use dsh-sim's log and performance tools.

1. Use the chosen device's UDID (iOS) or running serial (Android) from dsh-sim's tools or panel. Call `sim_start` with the app, `platform`, `udid` or `serial`, a short `session` name, and `foreground: true`. If the app ID is unknown, find it with `sim_list_apps` or `sim_list_apps` first; do not invent one or boot another device.
2. Read the refs `sim_start` returns, or call `sim_snapshot` with `interactiveOnly: true`. Use actual refs from the latest result, or a known selector; prefer them to coordinates.
3. Call `sim_press`, `sim_fill`, or `sim_swipe` with `settle: true`, and continue from the settled diff. `sim_fill` replaces text; `sim_text` appends to the focused field and has no settle option. Run stateful commands in order within one session.
4. Verify the requested result with a named expectation through `sim_wait`, `sim_assert`, `sim_find`, or `sim_find`. Give `sim_find` a read-only `action` such as `exists` or `getText`; without one it taps the match. A screenshot or snapshot alone is not verification, and an accepted input does not prove the app changed. `sim_screenshot` returns the image when you need to look at the screen.
5. Call `sim_stop` when finished. Leave `shutdown` unset to keep the device running. Closing can close the active app; skip it if the user wants that app left open.

A selector that matches several elements fails with `AMBIGUOUS_MATCH` and lists the candidates: retry with one of their refs or a narrower selector.

Pass device selection to `sim_start` once. Later commands take the same `session` and no `platform`, `udid`, `serial`, or `device`; the session holds the device. Discovery, installation, and standalone script tools keep their selection fields. Batch steps inherit the outer session and follow each command's own schema. Follow later user device selections by opening a session on the new device.

dsh-sim manages state paths, runner configuration, and output format, so tool inputs omit them. Each server has its own temporary state directory; `device_session` with `action: "state-dir"` returns it, and its logs and artifacts stay there. Another 设备引擎 daemon can own a simulator's runner; do not force-release a live owner's claim. End that task's session or choose another device. The server stops its daemon and releases its runner leases when it shuts down.

The first iOS interaction builds the bundled Apple runner with the local Xcode and caches it under `~/.设备引擎/apple-runner`, which takes about a minute. Android uses the installed SDK's adb. For Android, pass `platform: "android"` and `serial`, never `udid`; a stopped AVD gets its running serial after booting.
