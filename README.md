# dsh-sim

Device simulator plugin for DeepSeek Harness (DSH): a native sidebar tab that
shows iOS simulators, Android emulators/devices, and physical iPhones (HEVC
mirror), with agent tools and a built-in device panel.

## Layout

```
lib/              DSH host plugin: sim_* tools, routes, sidebar tab
engine/           device engine source (panel UI + runtime server)
vendor/runtime/   built engine shipped with the plugin (generated, do not edit)
locale/           plugin locale (en/zh metadata)
scripts/          build and check scripts
docs/             architecture / handover notes
```

## Build

```bash
cd engine && npm install      # once
cd .. && npm run build        # builds the panel from engine/, patches the runtime,
                              # installs into vendor/runtime/dist and packs dist/dsh-sim-<version>.tgz
```

Install the resulting tarball from the DSH plugin page, or install this
directory as a source link.

## Panel

- one tab in the right sidebar, one stream per conversation (stream slots);
- Android: scrcpy H.264; iOS simulator: serve-sim H.264; physical iPhone: HEVC
  mirror through the embedded engine;
- Chinese UI by default; the panel, tool descriptions and parameter schemas are
  localized in `engine/packages/*` and `lib/tool_locale.js`.

## Physical iPhone

The phone's screen has exactly one owner: the engine's HEVC mirror
(`ios-mirror-service.mjs`). A second consumer of the CoreDevice display stream
takes it away for good, which is why `pymobiledevice3 … display serve-web` was
removed and why the plugin reaps leftovers of it.

- video: the engine's panel, fed by the engine's mirror;
- taps, drags and scrolling: the mirror's own HID service
  (`mobile_ios_mirror_*`), one short-lived session per gesture, so the phone
  stays on the app the user is looking at — no XCTest runner window;
- home, lock and volume: `pymobiledevice3 developer core-device hid button`
  (the separate HID button service);
- before the sidebar gets a panel URL the plugin probes the mirror
  (`preparePhysicalMirror`), replaces a mirror that cannot produce a frame and
  bumps the `mirror` epoch in the URL, which reloads a tab that was left on the
  broken stream.
- no panel open: input uses `pymobiledevice3 … universal-hid-service`, which is
  fast and leaves nothing half-open (it does take the display stream, so it is
  only used when nothing is watching).

## Tools

29 `sim_*` tools: devices, start/stop/status, screenshot, tap/swipe/text/key,
rotate, install/uninstall/launch/open_url/permission/ui/logcat/shell/shutdown.
