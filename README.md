# dsh-sim

A native **simulator panel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
an iOS Simulator / Android emulator (or USB phone) lives in a **per-conversation sidebar tab**,
streaming H.264 video that you can tap and drag directly.

- **Per conversation** — the tab and its stream are scoped to the active session; devices never
  leak between conversations.
- **Low latency** — iOS uses serve-sim's `/stream.avcc` (H.264), Android uses scrcpy-server 4.0
  (H.264), decoded with WebCodecs. No MJPEG, no per-frame PNG.
- **Native chrome** — phone frame / slim bezel / frameless, with punch-hole, home indicator and
  side buttons; the picture scales to fit the sidebar and is always fully visible.
- **Device picker** — search, recently used group, collapsible "other devices", live status and
  a check mark for the selected device.
- **10 agent tools** — list, start/stop, screenshot, tap, swipe, text, key, rotate, status.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | ≥ 0.2.2 (web or desktop) |
| dsh-better-sidebar | ≥ 0.32 (required — the tab is registered there) |
| iOS | macOS + **full Xcode** (`xcrun simctl` + simulator runtimes) |
| Android | Android SDK `platform-tools` (adb); an AVD or a USB device |
| Node | ≥ 22 (DSH host) |

The first Android stream downloads **scrcpy-server 4.0** into `~/.dsh/cache/dsh-sim`
(~1 MB, one GitHub request, offline afterwards).

## Install

```sh
git clone git@github.com:supperzl/dsh-sim.git ~/dsh-sim
cd ~/dsh-sim && npm install
```

Register the directory in a DSH profile:

- Desktop: Plugins → Add plugin → choose the directory, or ask the agent to run
  `plugin_manager install_bundle /Users/<you>/dsh-sim`;
- Web/TUI profile: `dsh plugin --profile web add /Users/<you>/dsh-sim`.

Hard-refresh the GUI once (`Cmd+Shift+R`): the host applies immediately, the client bundle is
cached by the browser for one load.

## Usage

1. Right sidebar → **+** → **Start** page → click the **Simulator** card.
2. Click the device button: search, or pick from **Recently used** / **Other devices on this Mac**.
   Selecting a device starts it (booted simulators attach immediately).
3. Toolbar: **play/stop**, **rotate**, **home**, **lock (iOS) / power (Android)**; the frame style
   selector sits on the right (`Phone frame / Bezel / Frameless`).
4. On the picture: **tap = touch**, **drag = swipe**.
5. Drag the sidebar wider to zoom — the device always fits completely.

## Tools

All tools return plain JSON and act on the **current conversation's** stream
(`exec.agent.session.id`).

| Tool | Description | Arguments |
| --- | --- | --- |
| `sim_devices` | List iOS simulators, Android devices, AVDs | — |
| `sim_start` | Start a device and attach its stream | `device`, optional `platform` |
| `sim_stop` | Stop the conversation's stream | — |
| `sim_status` | Which device this conversation is streaming | — |
| `sim_screenshot` | Capture a PNG, return path and pixel size | — |
| `sim_tap` | Tap at normalized coordinates | `x`, `y` (0..1) |
| `sim_swipe` | Swipe between normalized points | `fromX`, `fromY`, `toX`, `toY`, `durationMs` |
| `sim_text` | Type ASCII text | `text` |
| `sim_key` | Press home/back/recents/power/volume_up/volume_down/enter/delete/menu | `name` |
| `sim_rotate` | Rotate (iOS takes an orientation, Android toggles) | `orientation` |

## Architecture

```
lib/
├── index.js          # host entry: tools, webserver routes, lifecycle
├── client.js         # browser bundle (__ModuleLoader__): simulator tab + WebCodecs player
├── tools.js          # the sim_* tool definitions
└── host/
    ├── devices.js    # simctl / adb / emulator discovery
    ├── ios.js        # serve-sim lifecycle + AVCC endpoints + HID control protocol
    ├── android.js    # scrcpy-server startup, video/control sockets, control messages
    ├── manager.js    # sessionId-scoped streams, screenshots, idle reaping
    ├── resolve.js    # locate serve-sim / ws across the linked-install boundary
    └── routes.js     # /_dsh/dsh-sim/* HTTP routes and loopback/same-origin fences
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (Chinese).

## Limitations

- iOS streaming is macOS + full Xcode only; Android needs `adb`-visible devices.
- One stream per conversation; one viewer panel per stream.
- The tool surface covers device control; build/run, OCR and UI-tree tools are not included yet.
- Video decoding needs WebCodecs H.264 (supported by the DSH desktop build).

## Development

```sh
npm run check     # syntax-check every module + validate package.json / bundle files
```

Toggle the plugin (`plugin_manager set_plugin`) to reload the host; hard-refresh for the client.

## License

MIT. Third-party: serve-sim (Apache-2.0), scrcpy (Apache-2.0), ws (MIT).
