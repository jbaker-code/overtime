# Overtime — the full guide

The deep dive: everything the widget does, every setting, and how to build, test,
and hack on it. If you just want to **download and run** it, the top-level
[`README.md`](../README.md) has the one-click install table — this guide is for when
you want the whole story.

Overtime is a tiny always-on-top desktop widget that shows **(1)** the current time
and **(2)** how long you've been recording. It floats over whatever you're capturing
so the viewer gets to watch the minutes burn.

It exists because of a running gag: you plan a "quick 10-minute episode" and then
record for an hour and a half. So now the clock is right there on screen, keeping
everyone honest. It was built on camera for the [BakerCode](https://www.youtube.com/@bakercode)
YouTube series, then set loose as its own little app.

```
        ╭───────────────────────────╮
        │                           │
        │        10:42  AM          │   ← wall clock (HH:MM + small AM/PM)
        │        00:37:12           │   ← recording stopwatch (HH:MM:SS)
        │                           │
        ╰───────────────────────────╯
           (hover to reveal:  ▶  ⏸  ↺  ⚙  × )
```

> **A note on naming.** Overtime grew up as a project called *Episode Timer*, so a
> few under-the-hood identifiers still wear the old name — the `EPISODE_TIMER_*`
> environment variables, the `window.episodeTimer` bridge, and the
> `episode-timer.config.v1` localStorage key. They're just historical leftovers; the
> app, the config folder, and everything you download are all **Overtime** now.

---

## Run it from source

```bash
git clone https://github.com/jbaker-code/overtime.git
cd overtime
npm install                      # first time: Electron + Playwright + electron-builder
npx playwright install chromium  # once, only needed for the single-file tests
npm start                        # launch the widget
```

That's it. No config, no flags. `npm start` runs `electron .`.

Dev nicety: `npm start -- --devtools` opens detached DevTools. Heads up — the window
goes **opaque** while DevTools is open. That's a documented Electron quirk for
transparent windows, not a bug in our CSS.

---

## Use it

The widget is just the two readouts on a dark pill (solid by default; dial in some
transparency in Settings) until you hover it. Hover (mouse over the widget) and the
control strip fades in over the pill:

- **▶ Play** — start the stopwatch (or resume a paused one).
- **⏸ Pause** — freeze it and keep the value on screen. Resume with Play. (There's no
  separate Stop button — Pause covers "halt and keep the value.")
- **↺ Reset** — back to `00:00:00`. The only destructive button, so it's hover-only
  — you can't fat-finger it mid-record.
- **⚙ Settings** — opens the tabbed settings panel (Layout / Font / Colors). Click a
  tile to change the look; see below.
- **×** — quit. The Dock icon is hidden (see "On macOS" below), so this is one way
  out; the menu-bar/tray **Quit** and Cmd/Ctrl+Q (when the widget is focused) also work.

**Move it:** drag anywhere on the pill (or the settings panel's title bar). **Resize
it:** drag any edge or corner — or the little grip in the bottom-right. Free resize,
no locked aspect ratio; the two readouts scale to fill whatever shape you give it, down
to a **100×60** minimum. It remembers its position and size between launches, and it'll
never reopen off-screen even if you unplug a monitor.

Pause and Reset are the whole story: Pause halts and keeps the value frozen, Reset
zeroes you back to `00:00:00`.

### On macOS: it lives in the menu bar

Overtime runs as an **accessory app** — **no Dock icon**, no app-switcher entry.
Instead it drops a little icon in the **menu bar** (top-right, near the system clock).
Click it to bring the widget to the front and open a menu: **Play · Pause · Reset ·
✓ Show clock · ✓ Show stopwatch · Settings… · Show / Bring to Front · ✓ Float on top ·
Quit**. "Show clock" and "Show stopwatch" are checkboxes that hide/show each readout
(turn both off for a blank pill); "Float on top" toggles always-on-top; and "Show /
Bring to Front" rescues the widget if it ever ends up hidden behind another window.
(Windows gets the same menu from a notification-area/system-tray icon, since the widget
stays out of the taskbar too.)

---

## Settings

Hit the **⚙ gear** in the hover controls and a little tabbed panel slides over the
widget — **Layout / Font / Colors**. Most choices are click-to-select tiles (no
typing, no dropdowns): pick an arrangement, a typeface, a background color, a text
color. The **Colors** tab also has a **transparency slider** (the pill is solid by
default — slide it down to see through to whatever's behind it). Every change applies
live and is saved immediately. This is the primary way to change the look and feel.

Opening Settings **grows the window** to a comfortable editing size (~720×620) and
**restores your real widget size when you close it** (the grown size is never saved).
The panel shows a ~3× live preview of the pill on a checkerboard backdrop, so lowering
the opacity actually reads as see-through.

Under the hood, settings live in `config.json` — the panel just clicks values into that
same store so you don't have to hand-edit it. The file remains the on-disk source of
truth. **`alwaysOnTop` lives in the menu-bar/tray menu** ("Float on top"), and `hour12`
and `showSeconds` have no panel tiles yet — so those two you still set by editing the
file (quit → edit → relaunch).

Where it lives:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Overtime/config.json` |
| Windows | `%APPDATA%\Overtime\config.json` |

The file holds your window bounds, the saved stopwatch value, and a `settings`
object with these knobs:

| Key | Type / allowed | Default | What it does | Panel tab |
|-----|----------------|---------|--------------|-----------|
| `layout` | one of `stack`, `stopwatch-top`, `clock-left`, `side-by-side`, `split`, `one-line`, `dash`, `clock-hero`, `stopwatch-hero`, `centered-gap` | `"stack"` | How the two readouts are arranged. `stack` is the original clock-over-stopwatch look. | Layout |
| `font` | one of `system`, `mono`, `serif`, `helvetica`, `courier`, `times`, `trebuchet`, `verdana`, `palatino`, `condensed` | `"system"` | Typeface. System / web-safe stacks only — no external or CDN fonts, so it stays fully offline. | Font |
| `bgColor` | one of 10 hex swatches (`#000000`, `#1a1a2e`, `#0f3d3e`, `#2d132c`, `#1b2a4a`, `#3a2d1b`, `#2c2c2c`, `#004e64`, `#f5f5dc`, `#ffffff`) | `"#000000"` | Pill base color. `opacity` still controls the translucency on top of it. | Colors |
| `textColor` | one of 10 hex swatches (`#ffffff`, `#f0f0f0`, `#e0e0e0`, `#111111`, `#f5c518`, `#ffd166`, `#4ade80`, `#60a5fa`, `#a78bfa`, `#ff6b6b`) | `"#ffffff"` | Color of the numerals and labels. | Colors |
| `opacity` | number `0`–`1` | `1.0` | Pill background alpha (`1.0` = solid). Values outside the range get clamped. | Colors (slider) |
| `showSeconds` | boolean | `false` | Show the wall clock as `HH:MM:SS` instead of `HH:MM`. | — (config file) |
| `hour12` | boolean | `true` | `true` = 12-hour clock with AM/PM; `false` = 24-hour and the meridiem is hidden. | — (config file) |
| `alwaysOnTop` | boolean | `true` | Whether the widget floats above everything. | Tray menu ("Float on top") |
| `showClock` | boolean | `true` | Show the wall-clock readout. | Tray menu ("Show clock") |
| `showStopwatch` | boolean | `true` | Show the stopwatch readout. Turn this and `showClock` both off for a blank pill. | Tray menu ("Show stopwatch") |

There's no `theme` setting — the widget auto-derives a light/dark tint for the hover
control buttons from how bright your `bgColor` is, so they stay readable on any
background. You don't set it.

The config file is **safe to delete** — the app just starts fresh from defaults. If
the file is ever missing, half-written, or hand-edited into garbage, the app falls
back to defaults and never crashes (a corrupt file gets renamed to
`config.json.corrupt-<timestamp>` so nothing is silently lost). Unknown keys get
dropped; bad values snap back to the default.

---

## OBS tip

Use **Display Capture** (or add the widget as its own **Window Capture** source). If
you only Window-Capture the app you're recording, the overlay won't be in the
capture — the widget is a separate window. Content protection is deliberately **off**
so recorders can see it; that's the whole point.

---

## Build it

```bash
npm run build          # everything → tmp/overtime-build-<slug>/dist/{mac,windows,single-file,source}/
npm run build:mac      # just the macOS zips
npm run build:win      # just the Windows zip
npm run build:single   # just the single-file HTML
npm run build:source   # just the source zip
npm run clean          # wipe the scratch temp dir and every tmp/overtime-build-* folder
```

**No installers. Unsigned. By design.** We ship the raw built binary + a README in a
zip, nothing fancier — no `.dmg`, `.pkg`, or NSIS. That keeps the whole pipeline free
of code-signing, notarization, and (on the Windows side) Wine/mono.

**Where the artifacts land:** each build gets its own dated+slugged folder under the
repo — `tmp/overtime-build-<YYYYMMDD-HHMMSS>-<slug>/dist/…`. That `tmp/` is
**gitignored**, so builds are **never committed to git**. Old builds just pile up there
until you `npm run clean`. Each build folder's `dist/` holds:

```
dist/
├── mac/            Overtime-mac-arm64-v1.0.0.zip   (.app + README.txt)
│                   Overtime-mac-x64-v1.0.0.zip     (.app + README.txt)
├── windows/        Overtime-windows-x64-v1.0.0.zip (win-unpacked folder + README.txt)
├── single-file/    index.html
└── source/         overtime-source-v1.0.0.zip
```

The curated, published copies of these zips live in the committed
[`releases/`](../releases/) folder — that's what the README's download links point at.

Notes that matter:

- **Both Mac architectures build every time** (arm64 **and** x64). You don't need a
  flag — and `--x64`, if you remember it from the plan, is now a harmless no-op.
- **The Windows build is cross-compiled on the Mac and never actually run here.**
  The `.exe` wears Electron's stock icon and version info (we skip exe-patching so
  the build never needs Wine). Smoke-test it on a real Windows box before telling
  viewers it's great.
- **electron-builder's scratch lives in the OS temp dir**, not in `tmp/`. macOS
  `.app` bundles are full of symlinks a shared folder can't store, so the unpacked
  apps are assembled on local disk at `<os-tmpdir>/overtime-build-scratch/` and only
  the finished (symlink-free) zips are copied into the build folder's `dist/`. Override
  the scratch dir with `EPISODE_TIMER_SCRATCH=<dir>` (must still be inside the OS temp
  dir).

### Scripts, one line each

| Script | Does |
|--------|------|
| `npm start` | Run the widget (`electron .`). |
| `npm test` | Playwright acceptance suite (unit + single-file + electron). |
| `npm run build` | single-file → source → mac → win, in sequence; stops at first failure. |
| `npm run build:mac` | Two `.app` zips (arm64 + x64) → `dist/mac/`. |
| `npm run build:win` | One `win-unpacked` zip → `dist/windows/`. |
| `npm run build:single` | Inline everything into one `index.html` → `dist/single-file/` (`--out <path>` to write elsewhere). |
| `npm run build:source` | Source zip (file-walk, includes uncommitted files) → `dist/source/`. |
| `npm run clean` | Remove the OS-temp scratch dir and every `tmp/overtime-build-*` folder. |

---

## Test it

```bash
npm test                                   # everything
npx playwright test --project=unit         # just the pure-Node unit tests
npx playwright test --project=single-file  # the built single-file page in headless Chromium
EPISODE_TIMER_SKIP_ELECTRON=1 npm test     # skip the Electron project
```

Three Playwright projects:

- **unit** — pure Node. Exercises the stopwatch state machine, the config schema, the
  formatters, and the single-file inliner. No browser.
- **single-file** — loads the built single-file `index.html` in headless Chromium (it
  uses the cached Playwright Chromium — that's what `npx playwright install chromium`
  is for).
- **electron** — the real app via Playwright's `_electron`. It opens real windows for
  ~10–20 s ("headless" here means *unattended*, not invisible). It **skips itself
  cleanly** if `EPISODE_TIMER_SKIP_ELECTRON=1` is set or no Electron binary is found,
  so the suite still goes green on a machine that can't launch the GUI.

---

## Single-file mode

`dist/single-file/index.html` is the whole thing (HTML + CSS + JS) inlined into one
file that runs in any browser — handy for a quick poke without installing anything.

**What works:** the clock, the stopwatch, Play/Pause/Reset, the hover controls,
the ⚙ settings panel (it only talks to the app through a callback, so it behaves
identically here), and persistence (via `localStorage`, per browser / per origin).

**What can't work** (it's a browser tab, not an OS window): no always-on-top, no
frameless window, no drag-to-move, and the **×** and resize grip are hidden.

---

## Gatekeeper / SmartScreen (it's unsigned)

- **macOS:** right-click the app → **Open** the first time. On macOS 15+ that no
  longer bypasses Gatekeeper — instead go **System Settings → Privacy & Security →
  Open Anyway**.
- **Windows:** SmartScreen flags an "unknown publisher." Click **More info → Run
  anyway**.

---

## Troubleshooting

- **The window went opaque.** DevTools is open (`--devtools`). Transparent Electron
  windows do that; close DevTools and it's see-through again.
- **It won't float over a fullscreen app.** This leans on the Dock-icon-hidden /
  `LSUIElement` + `visibleOnFullScreen` combo, which has shifted across macOS
  releases. OBS Display Capture should still see it regardless.
- **It forgot my stopwatch / position.** Check the `config.json` path above — if it's
  gone or was replaced with a `.corrupt-*` file, the app started from defaults.
- **Two clocks opened.** It shouldn't — there's a single-instance lock, and a second
  launch just focuses the first. (Under test that lock is disabled so parallel
  launches work.)

---

## Not in v1 (so nobody files a feature request)

Multiple/named timers, sound/notifications, cloud sync, auto-start-on-boot. It's one
small, sharp widget on purpose. (The look & feel *is* customizable via the ⚙ settings
panel — see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for how to add a new look option
to the catalog.)

---

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for how it's wired. The original product
spec and implementation plan are kept for the curious in
[`dev/PRD.md`](dev/PRD.md) and [`dev/PLAN.md`](dev/PLAN.md).
