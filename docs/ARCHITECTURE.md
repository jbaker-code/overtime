# Overtime — Architecture

How the thing is wired. If `README.md` is "how do I run it," this is "how does it
work." Written against the actual code, not the aspirations.

> **A naming leftover:** the app used to be called *Episode Timer*, and a few internal
> identifiers still carry that name — the preload bridge is `window.episodeTimer`, the
> environment variables are `EPISODE_TIMER_*`, and browser mode persists under the
> `episode-timer.config.v1` localStorage key. They're historical; the product is
> **Overtime**. Code identifiers below are quoted exactly as they appear in the source.

---

## Process model

Electron app, three layers, one bridge:

```
┌──────────────────────── MAIN process (Node) ─────────────────────────┐
│  source/electron/main.js                                             │
│   • creates the frameless/transparent/always-on-top pill window      │
│   • creates a SEPARATE settings window on demand (beside the pill)   │
│   • restores + persists BOTH windows' bounds (clamped on-screen)     │
│   • runs as a macOS accessory app (no Dock) + a menu-bar tray menu   │
│   • owns config.json (the only thing that touches the file)          │
│   • wires the IPC channels, flushes config on quit                   │
│   source/electron/config.js        — atomic JSON read/write, corrupt-safe   │
│   source/electron/window-state.js  — restore/clamp + track bounds (per key) │
└───────────────┬──────────────────────────────────────────────────────┘
                │  IPC (contextBridge, the ONLY door)
┌───────────────┴──────── PRELOAD (source/electron/preload.js) ────────┐
│  exposes exactly one object: window.episodeTimer                      │
│  contextIsolation: ON   sandbox: ON   nodeIntegration: OFF            │
└───────────────┬──────────────────────────────────────────────────────┘
                │  window.episodeTimer.*
┌───────────────┴──────── RENDERER (the web page) ─────────────────────┐
│  source/app/renderer/index.html + styles.css   (the PILL)             │
│   app.js            — UI wiring, tick scheduler, buttons, hover, grip │
│   bridge.js         — picks Electron vs. browser, same async API      │
│   settings-apply.js — the one place settings → DOM/CSS                │
│   settings-panel.js — the tabbed click-to-select ⚙ panel (v2)        │
│  source/app/renderer/settings.html + settings-window.js  (Electron settings│
│   window: reuses settings-panel/-apply + shared modules to fill its   │
│   own window; browser build keeps the in-page panel instead)          │
│  source/app/shared/*  (format.js, stopwatch.js, config-schema.js)     │
│   pure, UMD-wrapped, no DOM/Node — shared by main, renderer, tests    │
└───────────────────────────────────────────────────────────────────────┘
```

**Browser mode** (the single-file build) is just the renderer layer running alone
in a tab. There's no main process and no preload, so `bridge.js` falls back to a
`localStorage`-backed implementation of the same async API. Same renderer code, two
environments.

The stopwatch **state lives in the renderer** (`source/app/shared/stopwatch.js`). Main only
*persists* what the renderer hands it. That keeps main tiny and lets the identical
state machine run in browser mode.

---

## File map

```
source/
  electron/
    main.js                  Electron main entry (package.json "main").
    preload.js               The one contextBridge → window.episodeTimer.
    config.js                config.json: load/get/set/update, debounced atomic write,
                             corrupt-file quarantine, flushSync() for before-quit.
    window-state.js          restoreBounds() (clamp to a connected display) +
                             trackBounds() (debounced moved/resized → config.window).
    build/                   electron-builder buildResources (icons, trayTemplate.png).
  app/
    shared/                  Pure JS, UMD-wrapped (no DOM, no Node).
      format.js              formatClock(date,{hour12,showSeconds}) + formatElapsed(ms).
      stopwatch.js           the state machine: play/pause/stop/reset/elapsedMs,
                             fromPersisted (restore-as-paused), toPersisted.
      config-schema.js       DEFAULT_CONFIG, SETTINGS_KEYS, the option catalogs
                             (LAYOUTS/FONTS/BG_COLORS/TEXT_COLORS), normalizeConfig(),
                             normalizeSettingsPatch(), MIN_WIDTH/MIN_HEIGHT.
    renderer/
      index.html             the one page (relative script/link refs, fixed order).
      styles.css             transparent body, pill, vmin sizing, hover, data-layout
                             arrangements, the settings-panel styling.
      bridge.js              Electron vs. browser; exposes env + the async API.
      settings-apply.js      applySettings(): settings object → CSS vars + data-layout
                             (+ derived data-theme); also fontFamilyFor + getClockOptions.
      settings-panel.js      the tabbed ⚙ panel: builds tiles from the catalogs,
                             calls back onSelect(key, value); no direct persistence.
      app.js                 DOM refs, second-aligned tick, buttons, hover, grip,
                             panel wiring, persistence pushes, window.__episodeTimer hook.
  scripts/                   Build pipeline (plain Node, no deps). See "Build pipeline".

tests/                       Playwright suite + helpers (incl. playwright.config.js). See "Testing".
```

---

## Window configuration (source/electron/main.js), flag by flag

```js
new BrowserWindow({
  ...bounds,                 // x/y/width/height, restored + clamped on-screen
  minWidth: 100, minHeight: 60,   // schema.MIN_WIDTH / MIN_HEIGHT
  frame: false,              // no OS chrome, ever — we draw our own controls on hover
  transparent: true,         // rounded dark pill, see-through corners
  hasShadow: false,
  resizable: true,           // native edge resize as a bonus; the grip is the guarantee
  maximizable: false, fullscreenable: false, minimizable: false,
  alwaysOnTop: settings.alwaysOnTop,
  skipTaskbar: true,
  title: 'Overtime',
  show: false,               // show on 'ready-to-show' to avoid a white flash
  webPreferences: {
    preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
    backgroundThrottling: false,   // keep ticking at 1 Hz when occluded/unfocused
  },
});
```

Then, after creation:

- `win.setAlwaysOnTop(true, 'screen-saver')` — top-most window level, so it floats
  over basically everything (only when the setting is on).
- `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` on non-Windows
  — ride over Spaces and other apps' fullscreen.
- **No aspect-ratio lock.** The old `setAspectRatio(240/130)` is gone — the host wanted
  **free resize**: the right edge changes width, the bottom edge changes height, the
  corner changes both independently. The content just re-fills whatever shape it's given
  (see "Rendering & scaling" — the readouts scale to fill).
- `app.dock.hide()` on macOS (skipped under test) — required for the over-fullscreen
  trick to actually work, and we're an accessory app anyway (the `LSUIElement` flag in
  the electron-builder config pairs with this). With no Dock icon, the app lives in the
  **menu-bar tray** instead (see "Menu-bar tray" below); the on-widget **×** button, the
  tray's **Quit**, and **Cmd/Ctrl+Q** are the ways out.
- A minimal app menu so **Cmd/Ctrl+Q** works when the widget is focused.
- Single-instance lock — a second launch focuses the first (disabled under test).
- `window-all-closed → app.quit()` on **all** platforms (a widget with no window is
  pointless; this overrides the macOS stay-alive default).
- `before-quit → config.flushSync()` — write whatever the renderer last pushed.

**Deliberately absent: `win.setContentProtection(true)`.** OBS (and any recorder)
*must* be able to capture the widget — that's the entire point. There's a comment in
`source/electron/main.js` marking it, and a unit test greps the file to make sure it never creeps
back in.

**Dev/test env knobs** read by main: `EPISODE_TIMER_USER_DATA` (point `userData` at a
disposable dir — honored via `app.setPath` before anything loads), `EPISODE_TIMER_TEST=1`
(skip the single-instance lock and `app.dock.hide()` so parallel test launches
behave), and the `--devtools` CLI flag (opens detached DevTools; the window goes
opaque while it's open — a documented Electron limitation).

### Menu-bar tray (Electron-only)

Because the Dock icon is hidden, `createTray()` gives the app a presence in the
**menu-bar tray** (macOS; a notification-area icon on Windows/Linux). The tray icon is
a monochrome `*Template` image from `source/electron/build/trayTemplate.png` (`+@2x`), which macOS
auto-inverts for light/dark menu bars; if that asset is missing it falls back to an
empty image plus a short `⏱` text title so the entry is never invisible. A tray failure
is swallowed — it never takes the app down.

The context menu (`buildTrayMenu`): **Play · Pause · Reset · ✓ Show clock · ✓ Show
stopwatch · Settings… · Show / Bring to Front · ✓ Float on top · Quit**.
Play/Pause/Reset send `timer:command` to the renderer (which owns the state); **Show
clock** / **Show stopwatch** are checkboxes that write `showClock` / `showStopwatch`
through `applySettingsPatch` (the renderer then hides the readout via
`#app[data-show-clock=…]` / `[data-show-stopwatch=…]`; both off = a blank pill);
**Settings…** raises the window and sends `ui:open-settings`;
**Show / Bring to Front** runs `showAndFocus()` (restore + show + focus + `moveTop`), also
bound to a left-click on the icon; **Float on top** is a checkbox that writes
`alwaysOnTop` through the same `applySettingsPatch` path the renderer uses, so main-side
effect + persistence + the renderer broadcast + the checkmark all stay in sync
(`updateTrayMenu` rebuilds the menu after any settings change).

### The separate settings window (Electron)

In Electron, **Settings is its own window**, not an in-pill overlay. Choosing
"Settings…" (tray / right-click) calls `openSettingsWindow()` in main: focus the window
if it's already up, otherwise `createSettingsWindow()` — a second frameless/transparent
`BrowserWindow` loading `source/app/renderer/settings.html`, which reuses the same tabbed panel
(`settings-panel.js`), applier (`settings-apply.js`) and shared modules to fill the
window. The pill keeps its small always-on-top self over the wallpaper; edits broadcast
back so the **real clock updates live** (see `settings:changed` below). This REPLACES the
old "grow the pill to fit an in-page panel" hack — `growForSettings`/`restoreFromSettings`
and `window:settings-open` are gone.

The settings window:
- persists its position AND size under its own config key `settingsWindow`
  (`trackBounds(settingsWin, config, { key: 'settingsWindow' })`), clamped on-screen like
  the pill;
- opens at a **default ~1262×975** when unset, run through `clampBounds` so it fits the
  display work area (shrunk to the largest that fits if the screen is smaller), positioned
  beside the pill the first time;
- has a bottom-right **resize grip** (`#settings-grip`) wired to `window:resize-by` (main
  resizes whichever window SENT the IPC);
- closes via its own `×` (closing it leaves the pill running).

The **browser / single-file build** is unaffected: it has no second window, so it keeps
the in-page `#settings-panel` overlay exactly as before. The split is on `bridge.env`
(renderer) / `BrowserWindow.fromWebContents(event.sender)` (main).

---

## IPC contract

`source/electron/preload.js` exposes exactly one object, `window.episodeTimer`, carrying
`isElectron: true` and `platform`. Everything it does maps to one of these frozen
channels:

| Channel | Direction | Payload | Main does |
|---------|-----------|---------|-----------|
| `timer:get` | renderer → main (invoke) | — | returns `config.get('timer')` (already normalized; `null` only if never saved) |
| `timer:push` | renderer → main (send) | persisted timer | `stopwatch.fromPersisted` (validate + clamp) → `config.set('timer', …)` (debounced atomic write) |
| `config:get-settings` | renderer → main (invoke) | — | returns the full `settings` object (defaults merged) |
| `config:set-settings` | renderer → main (invoke) | `Partial<Settings>` | `normalizeSettingsPatch` → merge → persist → apply main-side effects → **broadcast `settings:changed` to BOTH windows** → return full settings |
| `settings:changed` | main → BOTH renderers (send) | full `Settings` | each renderer calls `applySettings` — the pill updates the real clock live, the settings window updates its preview |
| `window:resize-by` | renderer → main (send) | `{ dx, dy }` | **free** resize of the SENDER's window (`BrowserWindow.fromWebContents`): `dx`/`dy` change width/height independently, each clamped to that window's own min (pill vs. settings); rounded to integers + finite-guarded before `setSize` |
| `window:open-settings` | renderer → main (send) | — | open/focus the SEPARATE settings window (`openSettingsWindow()`); used by the pill's debug hook (the tray/right-click "Settings…" calls it directly) |
| `app:quit` | renderer → main (send) | — | `app.quit()` |
| `timer:command` | main → renderer (send) | `{ action }` | tray Play/Pause/Reset — the renderer (state owner) runs the transition; `action` is `'play'｜'pause'｜'reset'` |

The preload API surface (`window.episodeTimer`):
`isElectron`, `platform`, `getTimer()`, `pushTimer(t)`, `getSettings()`,
`setSettings(partial)`, `onSettingsChanged(cb) → unsubscribe`, `resizeBy(dx, dy)`,
`quit()`, `setSettingsOpen(open)`, `onTimerCommand(cb) → unsubscribe`,
`onOpenSettings(cb) → unsubscribe`.

**Security posture:** `contextIsolation` on, `sandbox` on, `nodeIntegration` off. The
renderer gets no Node, no `require`, no `remote` — only that one object. And main
**never trusts the renderer blindly even though it's ours**: every inbound payload is
run through the shared schema (numbers must be finite, enums must match exactly,
unknown keys dropped) before anything is stored.

`bridge.js` normalizes the two environments behind one async API. In Electron it
forwards to `window.episodeTimer`; in a browser it reads/writes the same config blob
in `localStorage['episode-timer.config.v1']` (run through the same `normalizeConfig`),
`onSettingsChanged` fires right after `setSettings`, and `resizeBy`/`quit` are no-ops
(the grip and × are hidden). `bridge.env` is `'electron'` or `'browser'` and gets
stamped onto `#app[data-env]`.

---

## Stopwatch state machine

State shape (`source/app/shared/stopwatch.js`):

```js
{ status: 'stopped' | 'running' | 'paused',
  accumulatedMs: number,       // time banked from previous running stretches
  runningSince: number | null } // anchor of the current stretch (null unless running)
```

Transitions are **pure functions `(state, now) → state`**. No-ops return the *same
object* (identity) so the UI can cheaply skip a re-render/persist.

> The `stop` transition still exists in the module (and its row below), but it is
> **no longer wired to any control** — the UI dropped the Stop button because Pause
> already covers "halt and keep the value." It's kept here so the state machine stays
> complete and could be re-exposed trivially.

| from \ action | `play` | `pause` | `stop` | `reset` |
|---|---|---|---|---|
| **stopped (0)** | → running | — | — | — |
| **running** | — | → paused (bank) | → stopped (bank) | → stopped (0) |
| **paused** | → running (resume) | — | → stopped (keep) | → stopped (0) |
| **stopped (value)** | → running (resume) | — | — | → stopped (0) |

- "bank" = `accumulatedMs += max(0, now - runningSince); runningSince = null`.
- `canPlay/canPause/canStop/canReset(state)` are the one source of truth for both the
  table and the buttons' `disabled` state.

**Elapsed is always computed from the anchor, never accumulated per tick:**

```js
elapsedMs = accumulatedMs + (running ? max(0, now - runningSince) : 0)
```

Ticks only drive *rendering*. A missed or late tick (throttled page, busy CPU) costs
display latency, never drift — this is why we **don't** do `elapsed += 1000` in a
`setInterval`. The anchor clock is `Date.now()` (wall-clock epoch), and backward
jumps (NTP step, manual clock change) clamp to `0` for that stretch — better to
under-count by a second than show a negative value.

**`Date.now()` vs `performance.now()` trade-off:** with `Date.now()`, closing the lid
mid-`running` counts the nap as episode time (the question is "how long has this
episode been going," which is wall-clock semantics). If "only count while awake" is
ever preferred, it's a one-line swap in `stopwatch.js` to
`performance.now() + performance.timeOrigin` and nothing else moves.

**Persistence helpers:**
- `fromPersisted(obj)` validates and applies **restore-as-paused** (D6): a timer that
  was `running` at quit comes back `paused` at its last saved value, `runningSince:
  null`. Offline time is never back-filled. Garbage → a fresh initial state.
- `toPersisted(state, now)` snapshots the elapsed value into `accumulatedMs`, drops
  the anchor, and serializes a running timer as `paused` — exactly how it'll come
  back.

---

## Config & persistence

One JSON file, `config.json`, in Electron's `userData` dir, owned entirely by
`source/electron/config.js`:

- macOS: `~/Library/Application Support/Overtime/config.json`
- Windows: `%APPDATA%\Overtime\config.json`
- Tests/dev override the folder with `EPISODE_TIMER_USER_DATA=<dir>`.
- Browser mode keeps the same object in `localStorage['episode-timer.config.v1']`.

The shape (frozen in `source/app/shared/config-schema.js`, the single source of truth):

```jsonc
{
  "schemaVersion": 1,
  "window":   { "x": 1480, "y": 60, "width": 240, "height": 130 },  // x/y absent on first run
  "timer":    { "status": "paused", "accumulatedMs": 5400000, "runningSince": null },
  "settings": {
    "layout":      "stack",     // one of LAYOUTS (arrangement of the two readouts)
    "font":        "system",    // one of FONTS (system / web-safe stacks only)
    "bgColor":     "#000000",   // one of BG_COLORS (pill base color)
    "textColor":   "#ffffff",   // one of TEXT_COLORS (numerals + labels)
    "opacity":     1.0,         // pill alpha, clamped to [0, 1]; default 1.0 = solid
    "showSeconds": false,       // HH:MM:SS instead of HH:MM
    "hour12":      true,        // false → 24-hour, meridiem hidden
    "alwaysOnTop": true         // main-side window level
  }
}
```

The sixteen `SETTINGS_KEYS` are `layout, font, customFont, useCustomFont, bgColor,
textColor, customBgColor, customTextColor, opacity, textOpacity, cutout, showSeconds,
hour12, alwaysOnTop, showClock, showStopwatch`. `layout` and `font` are **enums** whose
allowed values live in the exported catalogs `LAYOUTS` (10 arrangements) and `FONTS` (9
system/web-safe keywords). `bgColor`/`textColor` hold the **active** color — any valid
`#rrggbb` (a preset OR a hex mixed in the color picker), validated by shape, not enum
membership; `BG_COLORS` (9 hex) and `TEXT_COLORS` (9 hex) are just the quick-pick preset
swatches. `customBgColor`/`customTextColor` remember the last picker color, and
`customFont` + `useCustomFont` remember/toggle an arbitrary installed family. These
catalogs are the single source of truth the panel renders tiles from and the schema
validates against, so the two can't drift. (There is **no `theme` setting** — see the
rendering section for how `data-theme` is derived.)

`normalizeConfig(raw)` **always returns a complete, valid config** — deep-merge over
defaults, per-field validation (enums via `pickEnum` against the catalogs, opacity
clamped, bounds must be finite integers, `timer` via `stopwatch.fromPersisted`),
unknown keys dropped. `normalizeSettingsPatch(raw)` (used by `config:set-settings`) is
stricter: only *supplied* keys with a *valid* value survive — a garbage color like
`'#zzz'` is dropped rather than coerced to the default, so a misbehaving caller can't
silently reset a setting. `migrate(raw)` brings an older file up to the current shape;
a file stamped with an unknown/newer `schemaVersion` can't be interpreted safely, so it
collapses to a clean default config (an *unversioned* file is treated as current).

**Atomic write:** `writeFileSync(config.json.tmp)` → `renameSync` over the real file.
`rename` is atomic on the same filesystem, so a reader never sees a half-written file
and a crash mid-write leaves the previous good file intact. Writes are debounced
(~500 ms); `flushSync()` writes immediately and is called from `before-quit`.

**Corrupt-file fallback:** `load()` never throws. `ENOENT` → defaults. Invalid JSON
or a valid-JSON-but-wrong-type file (an array, a string, `null`) → defaults **and**
the bad file is renamed to `config.json.corrupt-<timestamp>` so nothing is silently
destroyed. One log line either way.

**Off-screen clamp** (`source/electron/window-state.js`, `restoreBounds`): size is always
restored (clamped to `MIN_WIDTH`/`MIN_HEIGHT`). Position is kept only if the saved
rect still overlaps a *connected* display's work area by ≥ 50% (via
`screen.getDisplayMatching`); otherwise it slides fully back onto that display, and if
nothing matches, x/y are dropped so the OS centers it. Result: comes back exactly
where it was when the monitors are the same, visibly on-screen when they aren't.
`trackBounds` writes `{x,y,width,height}` back to `config.window` on debounced
`moved`/`resized` (and on `close`).

**Write cadence:** the renderer `pushTimer()`s on every transition and once per second
while running; main debounces disk I/O. Worst-case data loss on a hard kill is ≤ 1 s.

### The settings panel (v2)

The settings UI is `source/app/renderer/settings-panel.js`, a tabbed click-to-select panel built
inside an `#app` host and revealed with `#app[data-settings="open"]`. The SAME panel code
runs in two homes, chosen by `bridge.env`:

- **browser (single-file):** built inside the pill's own `#app` (`app.js → setupPanel()`),
  an in-page overlay — there is no second window in a tab. Unchanged.
- **electron:** NOT in the pill. It lives in a **separate window** (`settings.html` +
  `settings-window.js`) that builds the identical panel to fill its own `#app`. The pill
  builds no panel (`setupPanel` is skipped when `bridge.env === 'electron'`).

How it's wired:

```
"Settings…" (tray/right-click, electron) → openSettingsWindow()  (main)
⚙ gear click (browser)                   → panel.open()          (in-page)
 tile click  → onSelect(key, value)          (app.js / settings-window.js)
             → bridge.setSettings({ [key]: value })
                  Electron: config:set-settings → main validates + merges + persists
                            + applies main-side effects + broadcasts settings:changed
                            to BOTH windows (pill clock live + settings preview)
                  browser:  writes the localStorage blob through normalizeConfig
             → the normalized full settings come back → applySettings(settings)
             → panel.reflect(settings)  re-highlights the selected tiles
```

The panel:
- builds its tiles straight from the shared catalogs (`LAYOUTS`, `FONTS`, `BG_COLORS`,
  `TEXT_COLORS`), so it can never offer a value the schema would reject;
- has three tabs — **Layout / Font / Colors** (the old *Advanced* tab is gone; Colors
  holds the background swatches, the text swatches, **and an `#opacity-slider`** range
  input — a continuous value, so not a tile group). Font swatches render in the real
  stacks via `fontFamilyFor`; layout tiles render a mini preview using the *same*
  `data-layout` mechanism the real `#face` uses;
- shows a ~3× live preview of the pill at the top, sitting on a checkerboard backdrop
  (`#settings-preview` inside `#settings-preview-backdrop`) so lowering the opacity
  visibly reveals the "desktop" through the translucent pill;
- in Electron it fills its own window (which main sizes/persists via the `settingsWindow`
  bounds — see "The separate settings window"); in the browser it's an in-page overlay and
  `onToggle` just re-fits the preview box (there's no OS window to grow);
- never persists anything itself — it only calls back `onSelect(key, value)`. The host
  (app.js in browser, settings-window.js in Electron) sends a one-key patch down the
  normal settings path and applies the result. One source of truth, no drift.

`hour12` and `showSeconds` have no tiles yet — they're still edited in `config.json` by
hand. `alwaysOnTop` has no panel tile either, but it *is* toggleable at runtime via the
tray's **Float on top** checkbox (which routes through the same `config:set-settings`
path).

### How to add a new look option

Because the catalog is the single source of truth, a new arrangement/font/color is
three small edits and nothing else:

1. **`config-schema.js`** — add the value to the right catalog array (`LAYOUTS` /
   `FONTS` / `BG_COLORS` / `TEXT_COLORS`). That alone makes it a valid, persistable
   value and a panel tile.
2. **`settings-apply.js`** — teach `applySettings` to render it: for a font, add its
   CSS stack to `FONT_STACKS`; for a layout, the arrangement is pure CSS on
   `#app[data-layout="…"]` in `styles.css`; colors need nothing (the hex flows straight
   into the CSS vars). Add a caption to `FONT_LABELS`/`LAYOUT_LABELS` in
   `settings-panel.js` if you want a friendlier name than the raw key.
3. **tests** — the schema unit test pins the catalogs, so update it.

No IPC, no main-process, and no new persistence code — the key is already in
`SETTINGS_KEYS` so it rides the existing `config:set-settings` path.

---

## Rendering & scaling

- The window resizes **freely** (no aspect lock), so the two readouts **scale to fill**
  whatever shape the window has: `app.js`'s `fitFace()` measures the face and applies a
  `transform: scale()` so the type grows as large as fits (down to a ~6px padding), and
  the controls overlay the pill rather than reserving space.
- `#app` carries the state the CSS keys off: `data-env` (electron/browser),
  `data-status` (stopped/running/paused), `data-hover` (false/true), `data-layout` (the
  chosen arrangement — the `#face.arrange` row/column rules key off it, same as the
  panel's preview tiles), `data-settings` (open/closed — the panel overlay), and
  `data-theme` (dark/light, **derived** — see below).
- **Hover:** `mouseenter`/`mouseleave` on the document toggle `data-hover`; the
  controls fade in and the readouts shrink slightly to make room. (If that ever proves
  flaky over `-webkit-app-region: drag`, the planned fallback is a main-process cursor
  poll against the window bounds — not built unless needed.)
- **Drag:** `-webkit-app-region: drag` on the face; `no-drag` on every button and the
  grip.
- **Resize grip:** `pointerdown` on `#grip` captures the pointer; `pointermove` sends
  `resizeBy(dx, dy)` using screen-coordinate deltas (the window moves under the cursor,
  so client coords are useless); with the aspect lock gone, main applies `dx` to width
  and `dy` to height independently (each clamped to its own minimum). Native edge/corner
  resize works too (`resizable: true`).
- **Settings → DOM** (`settings-apply.js`, the one place that reads settings): sets
  `--bg-rgb` (the `bgColor` hex parsed to an `r, g, b` triplet, so CSS can build
  `rgba(var(--bg-rgb), var(--pill-opacity))`), `--pill-opacity`, `--text-rgb` (the
  `textColor` hex parsed to an `r, g, b` triplet) + `--text-opacity` (so text renders as
  `color: rgba(var(--text-rgb), var(--text-opacity))` — the Colors tab's text-opacity
  slider fades the numerals), `--font` (the keyword mapped through `FONT_STACKS`),
  `#app[data-layout]` (the arrangement), and `#app[data-theme]`. It also exposes
  `getClockOptions()` so the tick can read `hour12`/`showSeconds` without re-reading
  config. Called once at startup and on every settings change.
- **`data-theme` is derived, not a setting.** `applySettings` computes the perceived
  luminance of `bgColor` and sets `data-theme` to `light` when it's bright (> 140) else
  `dark`. Its only job is to keep the hover control buttons readable against whatever
  background was picked — the user never sets it.
- **Tick:** `setTimeout` re-armed to the next second boundary so minute/second flips
  land crisply; same tick re-renders the stopwatch from its anchor.

### Debug/test hook

The renderer installs a read-only `window.__episodeTimer`:
`{ getState(), elapsedMs(), getSettings(), env }`. Tests use it; nothing in the app
depends on it.

---

## Build pipeline

Plain Node, no runtime deps, electron-builder's **programmatic API**. Flow:

```
electron-builder (dir target) → scratch → stage (+ README.txt) → zip → dist/
```

- `source/scripts/lib/paths.js` — every path and artifact name in one place. `ROOT` is the repo
  root. Each run gets a dated+random `SLUG` (`YYYYMMDD-HHMMSS-xxxxx`; `build-all` makes one
  and shares it with its children via `EPISODE_TIMER_BUILD_SLUG`), so the artifacts land in a
  per-build folder `BUILD_DIR = ROOT/tmp/overtime-build-<slug>/` with `DIST = BUILD_DIR/dist`.
  `ROOT/tmp/` is **gitignored**, so builds are never committed and old ones accumulate until
  `clean`. `SCRATCH = <os-tmpdir>/overtime-build-scratch` stays on **local disk** (override
  with `EPISODE_TIMER_SCRATCH`, must stay inside the OS temp dir) because electron-builder's
  unpacked `.app` is full of symlinks a shared folder can't store. A `safeRemove` guard
  refuses to delete anything outside `SCRATCH` or a build folder under `ROOT/tmp/`;
  `listBuildDirs()` enumerates those build folders for `clean`.
- electron-builder config (`source/scripts/lib/electron-builder.config.js`): `dir` targets
  only, `asar: true`, `npmRebuild: false`. macOS `identity: null` (unsigned on purpose),
  `extendInfo.LSUIElement: true` (accessory app, pairs with `app.dock.hide`). Windows
  `signAndEditExecutable: false` so the cross-build never reaches for `rcedit`/Wine.
- `source/scripts/lib/stage.js` — builds `<SCRATCH>/stage/<name>/` holding the app + the usage
  doc renamed **`README.txt`** (+ `LICENSE` if present), then zips it so unzipping
  yields one tidy folder.
- `source/scripts/lib/zip.js` — `ditto` on macOS (preserves `.app` symlinks/exec bits), `tar`
  elsewhere; also asserts a known path exists inside the finished zip.

Per target:

- **mac** (`build-mac.js`): builds **both** arm64 and x64 every time (the old `--x64`
  flag is now a no-op) → two `.app` zips in `dist/mac/`. No `.dmg`/`.pkg`. If Apple
  Silicon ever kills the app ("Killed: 9"), the one-line fix is an ad-hoc
  `codesign --sign -`; not pre-added.
- **win** (`build-win.js`): cross-builds the `win-unpacked` folder → one zip in
  `dist/windows/`. No NSIS/portable. Built on macOS, **not run** — needs a smoke test
  on real Windows.
- **single** (`build-single-file.js`): inlines `index.html` + CSS + JS into one file
  via the pure, unit-tested `source/scripts/lib/inline-html.js`. Swaps each relative
  `<link>`/`<script>` for its contents in document order, escapes `</script`, prepends
  a banner, and **fails loudly on any absolute/`http` reference**. `--out <path>` writes
  elsewhere (the test suite uses this so it never dirties `dist/`).
- **source** (`build-source-zip.js`): file-walk (NOT `git archive`, so uncommitted
  files are included), ignoring `node_modules`, `dist`, `.git`, test output, `.DS_Store`,
  `*.log`; top-level folder `overtime-source/`.
- **build-all** runs single → source → mac → win in sequence, stops at the first
  failure, prints a summary.
- **clean** removes the OS-temp scratch dir and every `ROOT/tmp/overtime-build-*` folder
  (via the guard).

**No installers, no signing, no notarization, no Wine/mono** — adding a `dmg`, `pkg`,
`nsis`, or `portable` target is exactly the moment all of that would re-enter the
picture, so it stays out of v1.

The inliner contract the renderer must honor: `index.html` references assets only via
*relative* `<link rel="stylesheet">` / `<script src>` (no `type="module"`, no
`defer`/`async`, no external URLs), in this order — `../shared/format.js`,
`../shared/stopwatch.js`, `../shared/config-schema.js`, `./bridge.js`,
`./settings-apply.js`, `./settings-panel.js`, `./app.js`.

---

## Testing

`npm test` = `playwright test`, three projects (see `tests/playwright.config.js`):

- **unit** — pure Node; `require()`s the shared modules and the inliner directly. The
  stopwatch transition table, config schema tolerance, formatters, the inliner, and
  the static "no `setContentProtection(true)`" grep. No browser needed.
- **single-file** — the built single-file page in headless Chromium, 240×130 viewport.
  Deterministic time via Playwright's `page.clock`.
- **electron** — the real app via Playwright's `_electron`. It skips itself cleanly when
  `EPISODE_TIMER_SKIP_ELECTRON=1` or no Electron binary is found, so the suite still
  passes on a machine that can't launch the GUI. If you need to point it at an Electron
  binary somewhere other than the npm dependency, set `EPISODE_TIMER_ELECTRON_PATH`.
  `globalSetup` builds the single-file page into `<SCRATCH>/test/index.html`. A permanent
  **resize-stress** test lives here, covering the fractional/`NaN`/`Infinity` deltas that
  once crashed `setSize` (now rounded + finite-guarded in `window:resize-by`).

The single-file and electron projects share one assertion suite (`tests/helpers/`),
so the same behaviour is checked in both environments.

---

## Decisions & known limitations

The full decisions log (D1–D15) lives in [`docs/dev/PLAN.md`](docs/dev/PLAN.md) §0, and
the risks that shaped v1 (unsigned-binary friction, transparent-window quirks,
over-fullscreen behaviour, sleep semantics) are in its §8. The honest bottom line:
the Electron half — always-on-top, transparency, drag, bounds persistence, and the
Electron Playwright project — can only really be proven by running the app on real
macOS; the browser/single-file half is verified anywhere Chromium runs.
