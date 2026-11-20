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

## Tools

29 `sim_*` tools: devices, start/stop/status, screenshot, tap/swipe/text/key,
rotate, install/uninstall/launch/open_url/permission/ui/logcat/shell/shutdown.
