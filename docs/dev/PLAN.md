# Overtime — Implementation PLAN

> **Developer archive.** The original implementation plan, written by the planning agent
> before any code existed (back when the app was *Episode Timer* under `tools/clock/`).
> It's a historical snapshot — parts were superseded during the build, so for the app as
> it actually shipped see [`../GUIDE.md`](../GUIDE.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
> and [`DECISIONS.md`](./DECISIONS.md). Kept for the full paper trail.

> Companion to [`PRD.md`](./PRD.md) (the *what*). This file is the *how*: file layout,
> Electron wiring, state machine, build pipeline, tests, docs, and the recommended train
> of builder agents. Written by the planning agent; **no application code exists yet**.
>
> Ground rules carried over from the PRD and the repo `CLAUDE.md`:
> **Claude writes; the host runs.** Nothing in here assumes the VM can run Electron,
> `npm install`, or electron-builder. Everything is written so the host can run
> `npm install && npm test && npm run build` on the M2 Air and get committed `dist/`.

---

## 0. Decisions made in this plan (read these first)

| # | Decision | Why |
|---|----------|-----|
| D1 | **No runtime npm dependencies.** No `electron-store`; a hand-rolled **config module** (atomic JSON file + schema/defaults/validation, §2.4). | `electron-store` ≥ v9 is ESM-only and awkward from a CommonJS `main.js`; a hand-rolled module is more readable on camera, keeps `package.json` exactly as scaffolded, and lets the same schema code run in browser mode. |
| D2 | **Plain classic `<script>` files, no bundler, no ES-module `import`/`export`.** Shared modules use a tiny UMD wrapper. | Lets one `index.html` serve both the Electron renderer and the single-file build (the inliner just swaps `<script src>` for inline `<script>`), and lets Playwright unit-test the state machine in Node with `require()`. |
| D3 | **Stopwatch state lives in the renderer** as a pure, framework-free state machine; the **main process only persists**. | Same code runs in browser mode (single-file). Main stays tiny. |
| D4 | **Elapsed time is computed from an anchor, never accumulated per tick.** `elapsed = accumulatedMs + (now - runningSince)`. | Zero `setInterval` drift. Ticks only drive *rendering*. |
| D5 | **Anchor clock = `Date.now()`** (wall-clock epoch), with backward-jump clamping. (`performance.now()` discussed in §3.3 — flagged for the human.) | The question the widget answers is "how long has this episode been going", which is wall-clock semantics (laptop sleep should count). `Date.now()` also serializes cleanly for persistence. |
| D6 | **Restore-as-paused.** If the app quits while `running`, next launch shows the last saved value in `paused`. Offline time is never added. | PRD says so explicitly. |
| D7 | **No installers. electron-builder target = `dir` for both platforms**; our scripts stage the `.app` / `win-unpacked` folder + a README and zip it ourselves. No `.dmg`, `.pkg`, NSIS, code-signing identity, or notarization. `win.signAndEditExecutable: false` so the Windows build never touches `rcedit`/Wine. | PRD says so. `dir` is the one target that cross-builds Windows from macOS with zero extra tooling; staging ourselves is the only way to get the README *inside* the zip next to the app. |
| D8 | **macOS: arm64 only by default** (`--x64` opt-in flag on the build script). **Windows: x64 `win-unpacked` zip only.** | Host is M2; each extra arch is ~100 MB more in a committed `dist/` (see Risk R1). |
| D9 | **electron-builder config is a JS file** (`scripts/lib/electron-builder.config.js`), not a `build` key in `package.json`. | `directories.output` must be computed from `os.tmpdir()`; JSON can't do that. Also keeps `package.json` untouched. |
| D10 | **A custom resize grip** (bottom-right, hover-revealed, IPC → `win.setSize`) ships from day one, with native edge-resize (`resizable: true`) left on as a bonus. | Electron's docs still say transparent windows "are not resizable" / may break on some platforms. The grip is ~40 lines and guaranteed to work on both OSes. |
| D11 | **Aspect ratio locked** (`win.setAspectRatio(240/130)`), so `vmin`-based sizing fills the frame at every size. | Makes "everything scales with the window" trivially true and testable. |
| D12 | **A quit button (×) lives in the hover strip.** | With `skipTaskbar: true` and the dock icon hidden (needed for over-fullscreen on macOS), the user needs an on-widget way out. |
| D13 | Test IDs, IPC channel names, the preload API, and the config-file schema are **frozen in this document** (§2.4, §2.5, §5.3) so the app, build, and test agents can work in parallel. | Parallelism without integration surprises. |
| D14 | **One config file** (`config.json` in `userData`) holds `window` bounds, `timer`, and a forward-looking **`settings`** object (font, theme, opacity, showSeconds, hour12, alwaysOnTop). Schema + defaults + validation live in a **shared** UMD module so main, renderer, and browser mode all agree. v1 ships **no settings UI**, but every setting is read, applied, and writable over IPC today. | PRD requirement. Adding a settings window later = a new BrowserWindow that calls the existing `config:set-settings` channel; nothing else changes. |
| D15 | **Window restore clamps to a visible display**: restore size exactly; restore position only if it lands on a connected display's work area, otherwise slide it in (or fall back to the default position). | PRD: "never opens off-screen" (monitors come and go). |

---

## 1. File / module layout

Everything below lives in `overtime/`. `main` in `package.json` is `main.js`, and the
`scripts/*` filenames match the scaffolded npm scripts exactly.

```
overtime/
├── package.json                 # AS SCAFFOLDED — nobody edits it (see D9). main = main.js
├── .gitignore                   # as scaffolded
├── PRD.md / PLAN.md             # spec + this plan
├── README.md                    # human docs: what/run/build/test (docs agent)
├── ARCHITECTURE.md              # how it's wired + how the pipeline works (docs agent)
│
├── main.js                      # Electron MAIN process entry. Creates the BrowserWindow,
│                                #   applies always-on-top/workspace flags, wires IPC,
│                                #   restores/saves window bounds, flushes state on quit.
├── preload.js                   # contextBridge → window.episodeTimer (the ONLY bridge).
│
├── src/
│   ├── main/
│   │   ├── config.js            # THE config module (main side, §2.4): load() from
│   │   │                        #   userData/config.json, tolerate missing/corrupt, normalize via
│   │   │                        #   shared schema, get()/set(path, value)/update(partial), debounced
│   │   │                        #   ATOMIC write (tmp + rename), flushSync() for before-quit.
│   │   └── window-state.js      # restoreBounds(config, defaults) → bounds clamped onto a connected
│   │                            #   display's workArea (D15); trackBounds(win, config) debounces
│   │                            #   'moved'/'resized' into config.window.
│   ├── shared/                  # Pure JS, no DOM, no Node — UMD wrapped (D2).
│   │   ├── config-schema.js     # DEFAULT_CONFIG, SCHEMA_VERSION, normalizeConfig(raw) (deep-merge
│   │   │                        #   with defaults + per-field type/range validation, drop unknowns),
│   │   │                        #   migrate(raw) hook, SETTINGS_KEYS. Used by main AND browser mode.
│   │   ├── stopwatch.js         # The state machine (§3). createInitial(), play/pause/stop/
│   │   │                        #   reset(state, now), elapsedMs(state, now), fromPersisted().
│   │   └── format.js            # formatClock(date, {hour12, showSeconds}) → {time, meridiem|''};
│   │                            #   formatElapsed(ms) → HH:MM:SS
│   └── renderer/
│       ├── index.html           # The one page. Loads styles.css + shared/*.js + bridge.js + app.js
│       │                        #   with RELATIVE paths only (inliner contract, §4.4).
│       ├── styles.css           # Transparent body, dark pill, vmin sizing, hover transitions,
│       │                        #   -webkit-app-region rules, tabular numerals. Reads settings via
│       │                        #   CSS custom props (--pill-opacity, --font) + [data-theme].
│       ├── bridge.js            # Picks window.episodeTimer (Electron) or a localStorage
│       │                        #   fallback (browser). Exposes the same async API either way,
│       │                        #   incl. getSettings()/setSettings(). Browser mode runs the same
│       │                        #   normalizeConfig() over whatever is in localStorage.
│       ├── settings-apply.js    # applySettings(settings, els): one place that turns the settings
│       │                        #   object into DOM/CSS state. A future settings UI calls nothing else.
│       └── app.js               # UI wiring: DOM refs, tick scheduler (second-aligned),
│                                #   button handlers, hover state, resize grip, persistence pushes,
│                                #   window.__episodeTimer test hook.
│
├── scripts/                     # Build pipeline (build agent). Node, CommonJS, no deps.
│   ├── build-all.js             # npm run build      → mac + win + single + source, in sequence
│   ├── build-mac.js             # npm run build:mac  → dist/mac/<zip>
│   ├── build-win.js             # npm run build:win  → dist/windows/<zip>
│   ├── build-single-file.js     # npm run build:single → dist/single-file/index.html (--out flag)
│   ├── build-source-zip.js      # npm run build:source → dist/source/<zip>
│   ├── clean.js                 # npm run clean      → rm scratch tmp + dist/
│   └── lib/
│       ├── paths.js             # ROOT, DIST, SCRATCH (= os.tmpdir()/overtime-build-scratch), names
│       ├── log.js               # tiny coloured step/ok/warn logger
│       ├── zip.js               # zipDir(src, dest): `ditto -c -k --sequesterRsrc --keepParent`
│       │                        #   on macOS, `tar -a -cf` elsewhere; mkdir -p; size report
│       ├── stage.js             # stageAndZip({ appDir, usageDoc, stagingName, outZip })
│       ├── inline-html.js       # the single-file inliner (pure function, unit-testable)
│       └── electron-builder.config.js   # shared electron-builder config object (D9)
│
├── build/                       # electron-builder buildResources (OPTIONAL in v1)
│   └── icon.png                 # 1024×1024; electron-builder derives .icns/.ico. Omit → default
│                                #   Electron icon (fine for v1; see Stretch S1)
│
├── docs/                        # READMEs that get bundled INTO the zips (docs agent)
│   ├── usage-mac.txt            # "README" for the mac zip (one-line Gatekeeper note)
│   └── usage-windows.txt        # "README" for the windows zip (SmartScreen, unzip first)
│
├── tests/                       # Playwright acceptance suite (test agent)
│   ├── stopwatch.unit.spec.js   # PRD transition table, table-driven, pure Node
│   ├── config-schema.unit.spec.js # defaults, deep-merge, corrupt/garbage tolerance, unknown keys dropped
│   ├── format.unit.spec.js      # HH:MM / AM-PM / 24h / seconds / HH:MM:SS edge cases
│   ├── inline-html.unit.spec.js # inliner: swaps link/script tags, preserves order, escapes
│   ├── widget.browser.spec.js   # single-file build in headless Chromium
│   ├── widget.electron.spec.js  # real Electron via _electron (host only)
│   └── helpers/
│       ├── launch-electron.js   # launch with isolated userData dir; returns {app, page, win()}
│       └── dom.js               # selectors + small assertions shared by both widget specs
├── playwright.config.js         # projects: unit, single-file, electron (§5.1)
│
└── dist/                        # COMMITTED build outputs (scripts write here)
    ├── mac/        Overtime-mac-arm64-v0.1.0.zip      (.app + README)
    ├── windows/    Overtime-windows-x64-v0.1.0.zip   (win-unpacked folder + README)
    ├── single-file/ index.html
    └── source/     overtime-source-v0.1.0.zip
```

**What gets packaged into the Electron app** (electron-builder `files`): `main.js`,
`preload.js`, `src/**`, `package.json`. Everything else (`scripts/`, `tests/`, `docs/`,
`dist/`, `build/`, `*.md`) is excluded.

**File ownership** (for the agent train, §7): app agent owns `main.js`, `preload.js`,
`src/**`; build agent owns `scripts/**`, `build/**`; test agent owns `tests/**`,
`playwright.config.js`; docs agent owns `README.md`, `ARCHITECTURE.md`, `docs/**`.
**Nobody edits `package.json`, `PRD.md`, `.gitignore`** without the orchestrator's say-so.

---

## 2. Electron implementation

### 2.1 `main.js` — window creation, verbatim intent

```js
// Before app.ready: tests/dev can point userData somewhere disposable.
if (process.env.EPISODE_TIMER_USER_DATA) app.setPath('userData', process.env.EPISODE_TIMER_USER_DATA);

// macOS: hide the dock icon. Required for visibleOnFullScreen to actually work over
// another app's fullscreen Space, and we're a widget anyway. (Quit via the × button.)
if (process.platform === 'darwin') app.dock.hide();

const config = require('./src/main/config'); config.load();          // never throws (§2.4)
const settings = config.get('settings');                             // defaults merged in
const bounds = windowState.restoreBounds(config, { width: 240, height: 130 }); // clamped on-screen (D15)

const win = new BrowserWindow({
  ...bounds,                               // x, y, width, height (x/y omitted → OS default)
  minWidth: 140, minHeight: 80,
  frame: false,                            // no OS chrome, ever
  transparent: true,                       // rounded dark pill, see-through corners
  hasShadow: false,
  resizable: true,                         // native edge resize where the OS allows it (D10)
  maximizable: false, fullscreenable: false, minimizable: false,
  alwaysOnTop: settings.alwaysOnTop,       // default true; the setting exists so a UI can toggle it later
  skipTaskbar: true,
  title: 'Overtime',
  show: false,                             // show on ready-to-show to avoid a white flash
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,           // keep ticking when occluded/unfocused
  },
});
if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');       // top-most level
if (process.platform !== 'win32') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
win.setAspectRatio(240 / 130);                                            // D11
// DELIBERATELY ABSENT: win.setContentProtection(true). OBS must see us. (A test greps for this.)
win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
win.once('ready-to-show', () => win.show());
```

Other main-process responsibilities:

- `windowState.trackBounds(win, config)` — on `moved`/`resized` (debounced ~300 ms) write
  `config.window = win.getBounds()` (position **and** size).
- `app.on('before-quit')` → `config.flushSync()` (write whatever the renderer last pushed).
- `config:set-settings` handler re-applies main-side settings live (`alwaysOnTop` →
  `win.setAlwaysOnTop(flag, 'screen-saver')`) and broadcasts `settings:changed` to the
  renderer. This is the whole "settings UI later is trivial" promise, kept in main.
- `app.on('window-all-closed', () => app.quit())` on **all** platforms (a widget with no
  window is pointless; overrides the macOS stay-alive default).
- Single-instance lock (`app.requestSingleInstanceLock()`); second launch focuses the
  first. Two floating clocks is a bug, not a feature.
- A minimal application menu with just `role: 'quit'` so **Cmd/Ctrl+Q** works when the
  widget is focused (the × button remains the guaranteed path, D12).
- Dev nicety: `--devtools` CLI flag opens detached DevTools (note: window goes opaque
  while DevTools is open — documented Electron limitation).

### 2.2 Hard-requirement → API map

| PRD requirement | Delivered by |
|---|---|
| Frameless, no chrome when idle | `frame: false`; we draw our own controls only on hover |
| Transparent / rounded pill | `transparent: true`, `hasShadow: false`; CSS `html,body{background:transparent}` and `#app{border-radius; background: rgba(0,0,0,.55)}` |
| Always on top, incl. over fullscreen & Spaces | `alwaysOnTop: true` + `setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `app.dock.hide()` (macOS) |
| Draggable by the face | CSS `#face { -webkit-app-region: drag }`; every `button`, the grip, and `#controls` get `-webkit-app-region: no-drag` |
| Resizable, content scales | `resizable: true` + custom grip (D10); all type/spacing in `vmin`/`em` units; aspect lock (D11) |
| Hover reveals controls | renderer `mouseenter`/`mouseleave` on `document.documentElement` → `#app[data-hover]`; CSS transitions (§2.6 has the fallback) |
| OBS can capture it | never call `setContentProtection(true)` |
| Position/size persist, never off-screen | `window-state.js` (main) + `config.js`; clamp via `screen.getDisplayMatching` (D15) |
| Elapsed persists | renderer pushes `timer` state via IPC; `config.js` writes it; renderer reads it back at startup |
| Config tolerant of missing/corrupt file | `config.load()` catches `ENOENT`/`SyntaxError`/wrong type → `DEFAULT_CONFIG` (and renames a corrupt file to `config.json.corrupt-<ts>` so nothing is silently lost) |
| Settings plumbing (no UI yet) | `config-schema.js` defaults + `config:get-settings`/`config:set-settings` IPC + `settings-apply.js` in the renderer |

### 2.3 Preload / IPC design (contextIsolation on, sandbox on)

`preload.js` exposes exactly one object, `window.episodeTimer`:

```ts
interface EpisodeTimerBridge {
  isElectron: true;
  platform: 'darwin' | 'win32' | 'linux';
  getTimer(): Promise<PersistedTimer | null>;      // ipcRenderer.invoke('timer:get')
  pushTimer(t: PersistedTimer): void;              // ipcRenderer.send('timer:push', t)  (fire-and-forget)
  getSettings(): Promise<Settings>;                // ipcRenderer.invoke('config:get-settings') — always complete (defaults merged)
  setSettings(partial: Partial<Settings>): Promise<Settings>; // ipcRenderer.invoke('config:set-settings', partial) → normalized result
  onSettingsChanged(cb: (s: Settings) => void): () => void;   // ipcRenderer.on('settings:changed') — returns unsubscribe
  resizeBy(dx: number, dy: number): void;          // ipcRenderer.send('window:resize-by', {dx, dy}) — grip
  quit(): void;                                    // ipcRenderer.send('app:quit')
}
```

**IPC channels (frozen names):**

| Channel | Direction | Payload | Main does |
|---|---|---|---|
| `timer:get` | renderer → main (invoke) | — | returns `config.get('timer')` (already normalized; `null` only if never saved) |
| `timer:push` | renderer → main (send) | `PersistedTimer` | validate → `config.set('timer', t)` (debounced disk write ≤ 1/sec; always flushed on quit) |
| `config:get-settings` | renderer → main (invoke) | — | returns `config.get('settings')` |
| `config:set-settings` | renderer → main (invoke) | `Partial<Settings>` | `normalizeConfig` the merge → persist → apply main-side effects (`alwaysOnTop`) → broadcast `settings:changed` → return full settings |
| `settings:changed` | main → renderer (send) | `Settings` | (renderer calls `applySettings`) |
| `window:resize-by` | renderer → main (send) | `{dx, dy}` | `win.setSize(w+dx, h+dy, false)` clamped to min size; aspect lock keeps shape |
| `app:quit` | renderer → main (send) | — | `app.quit()` |

Rules: main validates every payload through the shared schema (numbers finite, enums
exact, unknown keys dropped) before storing — never trust the renderer blindly even though
it's ours. No `remote`, no `nodeIntegration`, no `sendSync`.

`bridge.js` (renderer) normalizes the two environments:

```js
// window.EpisodeTimerBridge  (global, D2)
//   env: 'electron' | 'browser'
//   getTimer()/pushTimer(t)        → Electron: window.episodeTimer.*; browser: localStorage['episode-timer.config.v1'].timer
//   getSettings()/setSettings(p)   → Electron: window.episodeTimer.*; browser: same localStorage blob, run through normalizeConfig()
//   onSettingsChanged(cb)          → Electron: forwards; browser: fires after setSettings()
//   resizeBy()                     → Electron only (browser: no-op; grip hidden)
//   quit()                         → Electron only (browser: no-op; × hidden)
```

### 2.4 Config & persistence module (required feature)

**One JSON file, `config.json`, in `app.getPath('userData')`**, owned by main:

- macOS: `~/Library/Application Support/Overtime/config.json`
- Windows: `%APPDATA%\Overtime\config.json`
- Tests/dev override the folder with `EPISODE_TIMER_USER_DATA=<dir>`.
- Browser mode keeps the identical object in `localStorage['episode-timer.config.v1']`
  (minus `window`, which is meaningless in a tab).

**Schema (frozen — `src/shared/config-schema.js` is the single source of truth):**

```jsonc
{
  "schemaVersion": 1,
  "window":   { "x": 1480, "y": 60, "width": 240, "height": 130 },        // all four persisted; x/y may be absent on first run
  "timer":    { "status": "paused", "accumulatedMs": 5400000, "runningSince": null },
  "settings": {                                                            // v1: no UI, but fully wired
    "font":        "system",      // 'system' | 'mono' | any CSS font-family string
    "theme":       "dark",        // 'dark' | 'light'   (the "look")
    "opacity":     0.55,          // pill background alpha, 0..1
    "showSeconds": false,         // wall clock HH:MM:SS instead of HH:MM
    "hour12":      true,          // false → 24-hour, meridiem hidden
    "alwaysOnTop": true           // main-side: window level
  }
}
```

`config-schema.js` exports `DEFAULT_CONFIG`, `SCHEMA_VERSION`, `SETTINGS_KEYS`, and
`normalizeConfig(raw)` → always returns a complete, valid config: deep-merge over defaults,
per-field validation (`opacity` clamped to `[0,1]`, enums checked, bounds must be finite
integers, `timer` via `stopwatch.fromPersisted`), unknown keys dropped, `migrate(raw)` is a
`switch (raw.schemaVersion)` that is a no-op today but exists so v2 has somewhere to go.

`src/main/config.js` behaviours:
- `load()` — reads + `JSON.parse` + `normalizeConfig`. On `ENOENT` → defaults. On parse
  error or non-object → defaults **and** renames the bad file to `config.json.corrupt-<timestamp>`
  (never crash, never silently destroy). Logs one line either way.
- `get(path)` / `set(path, value)` / `update(partial)` — in-memory first, then a
  **debounced (~500 ms) atomic write**: `writeFileSync(config.json.tmp)` → `renameSync` →
  done. `flushSync()` writes immediately (used in `before-quit`).
- `settings` are always written back complete (defaults filled in), so the host can open
  `config.json` and see every knob — editing it by hand while the app is closed **is** the
  v1 settings UI, and the README says so.

**Window-bounds restore (`window-state.js`, D15):** take saved `{x,y,width,height}`;
`width/height` always honored (clamped to `minWidth/minHeight` and to the target display's
`workArea`). For position: `display = screen.getDisplayMatching(saved)`; if the saved rect
intersects `display.workArea` by less than ~50 % (or `x/y` absent/non-finite), slide it
fully inside that work area (or, if no display matched, drop `x/y` so the OS centers it on
the primary display). Result: the widget comes back exactly where it was when the monitors
are the same, and visibly on-screen when they aren't.

**Settings application (renderer, `settings-apply.js`):** `applySettings(s)` sets
`document.documentElement.style.setProperty('--pill-opacity', s.opacity)`, `--font`
(`system` → the system stack, `mono` → `"SF Mono", Menlo, Consolas, monospace`, else the
string verbatim), `#app[data-theme]`, and hands `hour12`/`showSeconds` to the tick's
`formatClock()`. Called once at startup and on every `settings:changed`. Nothing else in
the renderer reads settings directly.

Write cadence while running: the renderer calls `pushTimer()` on every transition and
once per second tick while `running` (cheap IPC; main debounces disk I/O to ~1 write/sec
at most — tiny file, fine). Worst-case data loss on a hard kill: ≤ 1 s.

### 2.5 Renderer DOM contract (frozen — tests depend on these)

```html
<div id="app" data-env="electron|browser" data-status="stopped|running|paused" data-hover="false|true" data-theme="dark|light">
  <div id="face">                         <!-- drag region -->
    <div id="clock">
      <span id="clock-time">10:42</span>
      <span id="clock-meridiem">AM</span>
    </div>
    <div id="stopwatch">00:00:00</div>
  </div>
  <div id="controls">                     <!-- no-drag; hidden unless data-hover="true" -->
    <button id="btn-play"  aria-label="Play">▶</button>
    <button id="btn-pause" aria-label="Pause">⏸</button>
    <button id="btn-stop"  aria-label="Stop">⏹</button>
    <button id="btn-reset" aria-label="Reset">↺</button>
    <button id="btn-quit"  aria-label="Quit">×</button>   <!-- hidden when data-env="browser" -->
  </div>
  <div id="grip" aria-hidden="true"></div> <!-- resize grip; hidden in browser mode -->
</div>
```

- Buttons carry the `disabled` attribute exactly where the PRD table says "—".
- `#clock-meridiem` is empty/hidden when `settings.hour12 === false`; `#clock-time` shows
  `HH:MM:SS` when `settings.showSeconds === true`.
- `window.__episodeTimer` (read-only debug/test hook): `{ getState(), elapsedMs(), getSettings(), env }`.
- `?nohover` / nothing else: no query-string config. Keep it minimal.

### 2.6 Hover reveal + scaling (CSS sketch, not code)

- `html, body { margin:0; height:100%; background: transparent; overflow: hidden; user-select: none }`
- `:root { --pill-opacity: .55; --font: -apple-system, "SF Pro Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }` (overwritten by `applySettings`)
- `#app { position:fixed; inset:0; border-radius: 6vmin; background: rgba(0,0,0,var(--pill-opacity)); display:flex; flex-direction:column; justify-content:center; align-items:center; font-family: var(--font); font-variant-numeric: tabular-nums; color:#fff; }`; `#app[data-theme="light"] { background: rgba(255,255,255,var(--pill-opacity)); color:#111 }`
- `#clock-time { font-size: 30vmin; line-height: 1 }`, `#clock-meridiem { font-size: 10vmin; margin-left: .3em; opacity:.8 }`, `#stopwatch { font-size: 20vmin; opacity:.9 }`.
- `#face { transition: transform 150ms ease } ; #app[data-hover="true"] #face { transform: scale(.8) translateY(-8%) }`
- `#controls { opacity:0; pointer-events:none; transition: opacity 150ms } ; #app[data-hover="true"] #controls { opacity:1; pointer-events:auto }`
- Buttons: `font-size: 9vmin`, round, translucent white; `:disabled { opacity:.3 }`; `-webkit-app-region: no-drag`.
- `#grip`: bottom-right, `8vmin` square, diagonal lines, `cursor: nwse-resize`, visible only on hover, `-webkit-app-region: no-drag`.
- `@media (prefers-reduced-motion: reduce)` → transitions off.

**Hover detection:** `mouseenter`/`mouseleave` on `document.documentElement` toggle
`data-hover`. Known Electron quirk: elements under `-webkit-app-region: drag` swallow
`mousemove`/`click`, but enter/leave on the document still fire in practice. **Fallback
if it proves flaky on either OS** (Risk R4): main polls `screen.getCursorScreenPoint()`
against `win.getBounds()` at ~100 ms *only while the window is visible* and sends a
`hover:change` event through preload. Don't build the fallback unless needed; leave a
`// FALLBACK:` comment pointing here.

**Resize grip:** `pointerdown` on `#grip` → capture pointer, on `pointermove` send
`resizeBy(dx, dy)` using `screenX/screenY` deltas (window moves under the cursor, so
client coords are useless), `pointerup` releases. Because of the aspect lock, main only
needs to honor the larger delta.

**Wall clock tick:** `setTimeout(tick, 1000 - (Date.now() % 1000) + 5)` re-armed each
tick, so minute flips land on the second boundary. Same tick re-renders the stopwatch
(computed from anchor, D4). `visibilitychange` → immediate re-render.

---

## 3. Stopwatch state machine

### 3.1 State shape

```js
{ status: 'stopped' | 'running' | 'paused', accumulatedMs: number, runningSince: number | null }
```

`accumulatedMs` is time banked from previous running stretches. `runningSince` is the
anchor timestamp of the current stretch (non-null iff `status === 'running'`).
"Stopped (0)" vs "Stopped (value)" in the PRD are the same `status` with
`accumulatedMs === 0` vs `> 0` — the table collapses cleanly.

### 3.2 Transitions (pure functions `(state, now) → state`)

| from \ action | `play(s, now)` | `pause(s, now)` | `stop(s, now)` | `reset(s)` |
|---|---|---|---|---|
| **stopped, 0** | `running`, `runningSince = now` | no-op (disabled) | no-op (disabled) | no-op (disabled) |
| **running** | no-op (disabled) | `paused`, bank `now - runningSince` | `stopped`, bank value | `stopped`, `accumulatedMs = 0` |
| **paused** | `running`, `runningSince = now` (resume) | no-op (disabled) | `stopped`, keep value | `stopped`, `accumulatedMs = 0` |
| **stopped, >0** | `running`, `runningSince = now` (resume) | no-op (disabled) | no-op (disabled) | `stopped`, `accumulatedMs = 0` |

- "bank" = `accumulatedMs += max(0, now - runningSince); runningSince = null`.
- No-ops return the **same object** (identity), so the UI can skip re-render/persist.
- `elapsedMs(s, now) = s.accumulatedMs + (s.status === 'running' ? max(0, now - s.runningSince) : 0)`.
- `canPlay/canPause/canStop/canReset(s)` helpers drive button `disabled` state — one
  source of truth for both the table and the UI.
- `fromPersisted(obj)` → validates, and applies D6: `running` → `paused` with
  `runningSince = null` (offline time dropped). Garbage → `createInitial()`.
- `toPersisted(s)` → the same shape (it already is JSON-safe).

Difference between Pause and Stop is *purely* which buttons light up next (Stop disables
Pause/Stop; Pause keeps Stop enabled) and the semantics the host sees ("frozen" vs "done").
Both keep the value. Reset is the only destructive action — no confirm dialog (minimal), but
it's hover-only so you can't fat-finger it while recording.

### 3.3 Accurate timing

- **Never** `elapsed += 1000` per tick. Always recompute from the anchor (D4). A missed
  or late tick (throttled tab, busy CPU) therefore costs display latency only, never drift.
- Anchor clock = `Date.now()` (D5). Negative deltas (NTP step backwards, manual clock
  change) clamp to 0 for that stretch — we'd rather under-count by a second than show a
  negative or wildly wrong value. **Flag for the human (R6):** if they'd prefer the
  stopwatch *not* count laptop-sleep while running, swap the anchor to `performance.now()`
  + `performance.timeOrigin` — one-line change in `stopwatch.js`, nothing else moves.
- Render every second, aligned to the second boundary (§2.6), so `HH:MM:SS` increments
  look crisp rather than skipping.
- `backgroundThrottling: false` in webPreferences so an occluded/unfocused widget keeps
  ticking at 1 Hz (Chromium otherwise throttles timers in hidden pages).

### 3.4 Formatting (`format.js`)

- `formatClock(date, { hour12, showSeconds })` → `{ time: 'HH:MM' | 'HH:MM:SS', meridiem: 'AM'|'PM'|'' }`,
  built by hand (`getHours()` etc.), zero-padded, 12-hour with `12` not `0`; `hour12:false`
  gives `00`–`23` and an empty meridiem. Not `toLocaleTimeString` — predictable across OS
  locales, and trivially testable. Defaults come from `DEFAULT_CONFIG.settings`.
- `formatElapsed(ms)` → `HH:MM:SS`, floors to whole seconds, hours can exceed 99 (3-digit
  if it comes to that — Episode 001 was 2.5 h, don't tempt fate).

---

## 4. Build pipeline

### 4.1 Common plumbing (`scripts/lib/`)

- `paths.js`:
  `ROOT = overtime`, `DIST = ROOT/dist`, `SCRATCH = path.join(os.tmpdir(), 'overtime-build-scratch')`
  (override: `EPISODE_TIMER_SCRATCH=…`), `VERSION` and `PRODUCT_NAME` read from `package.json`,
  artifact names:
  - `Overtime-mac-<arch>-v<version>.zip`
  - `Overtime-windows-x64-v<version>.zip`
  - `overtime-source-v<version>.zip`
- Every build script: `mkdir -p` its scratch + dist subfolder, **empties its own dist
  subfolder first** (so old versions don't pile up in git), prints a final absolute path +
  size, exits non-zero on any failure. `build-all.js` runs the four in sequence (single
  and source first — they're fast and can't fail for network reasons — then mac, then win)
  and prints a summary table; it stops at the first failure.
- Scripts are plain Node + `child_process` + electron-builder's **programmatic API**
  (`require('electron-builder').build({ targets, config })`), no CLI string munging.
- `zip.js`: on macOS `ditto -c -k --sequesterRsrc --keepParent <staging> <out.zip>` (the
  only tool that preserves `.app` symlinks, exec bits, and resource forks correctly);
  elsewhere `tar -a -cf`. Windows zips are also made with `ditto` — plain files, fine.
- `stage.js`: builds `<SCRATCH>/stage/<StagingName>/` containing the app + the usage doc
  renamed `README.txt` (+ `LICENSE` if present), then zips it so unzipping yields one tidy
  folder, not loose files.

### 4.2 electron-builder config (`scripts/lib/electron-builder.config.js`)

```js
module.exports = {
  appId: 'com.bakercode.episode-timer',
  productName: 'Overtime',
  directories: { output: path.join(SCRATCH, 'electron-builder'), buildResources: 'build' },
  files: ['main.js', 'preload.js', 'src/**/*', 'package.json'],
  asar: true,
  npmRebuild: false,                 // no native deps, skip the slow step
  compression: 'normal',
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],   // + 'x64' when --x64. NO dmg/pkg.
    category: 'public.app-category.utilities',
    identity: null,                  // unsigned on purpose (no Developer ID, no notarization)
    hardenedRuntime: false, gatekeeperAssess: false,
    extendInfo: { LSUIElement: true } // accessory app: no dock icon, no menubar (pairs with app.dock.hide)
  },
  win: {
    target: [{ target: 'dir', arch: ['x64'] }],     // win-unpacked folder. NO nsis/portable exe.
    signAndEditExecutable: false,    // skip rcedit entirely → no Wine/mono ever needed on macOS.
                                     // Cost: the .exe keeps Electron's stock icon/version info. Fine for v1.
  },
};
```

Env set by the scripts: `CSC_IDENTITY_AUTO_DISCOVERY=false` (don't go hunting the keychain
for a cert and don't accidentally sign with one), `ELECTRON_BUILDER_CACHE` left default
(`~/Library/Caches/electron-builder`). First build needs network to fetch the Electron
prebuilt for each platform (~100 MB each). **No installers, no signing, no notarization:**
if anyone is tempted to add `dmg`, `pkg`, `nsis`, or `portable` targets later, that is the
moment Wine/mono and certificates enter the picture — keep it out of v1.

### 4.3 Per-script behaviour

**`build:mac` (`build-mac.js`)** — `.app` in a zip, nothing fancier
1. electron-builder `Platform.MAC.createTarget(['dir'], Arch.arm64)` (+ `Arch.x64` with `--x64`) → `<SCRATCH>/electron-builder/mac-arm64/Overtime.app`.
2. `stage.js` → `Overtime (macOS arm64)/{Overtime.app, README.txt}` → `dist/mac/Overtime-mac-arm64-v0.1.0.zip` (zipped with `ditto` so the bundle survives intact).
3. Sanity: zip listing contains `Overtime.app/Contents/MacOS/Overtime`.
4. Not done, on purpose: no `.dmg`, no `.pkg`, no Developer ID, no notarization. The
   only signing-adjacent thing permitted is a **one-line, best-effort ad-hoc**
   `codesign --force --deep --sign - "<app>"` *if and only if* the host reports the built
   app being killed on launch ("Killed: 9" — Apple Silicon refuses binaries with no
   signature at all). electron-builder normally ad-hoc signs arm64 by itself; the script
   just prints the relevant electron-builder log line so the host can tell. Don't
   pre-engineer it.

**`build:win` (`build-win.js`)** — the cross-build, deliberately boring
1. electron-builder `Platform.WINDOWS.createTarget(['dir'], Arch.x64)` → `<SCRATCH>/electron-builder/win-unpacked/` — a folder with `Overtime.exe` + the Electron runtime. This is the one Windows target that cross-builds from macOS with **no Wine, no mono, no certificates** (confirmed working on this host before). `signAndEditExecutable: false` guarantees electron-builder never reaches for `rcedit`.
2. `stage.js` → `Overtime (Windows x64)/{Overtime/  ← win-unpacked renamed, README.txt}` → `dist/windows/Overtime-windows-x64-v0.1.0.zip`.
3. Sanity: `Overtime/Overtime.exe` present in the zip listing.
4. Honest caveat printed at the end: "built on macOS, **not run** — smoke-test on a Windows machine before telling viewers it's great."
5. Not done, on purpose: no NSIS, no `portable` single-exe target, no icon/version-info patching. (Those are exactly the steps that drag Wine/mono in.)

**`build:single` (`build-single-file.js`)**
- Reads `src/renderer/index.html`; for every `<link rel="stylesheet" href="…">` and
  `<script src="…">` with a **relative** path, replaces it with the inlined `<style>`/
  `<script>` contents, in document order. Escapes any `</script` inside inlined JS as
  `<\/script`. Prepends an HTML comment banner: what it is, version, build date, and the
  browser-mode limitations. Fails loudly on any absolute/`http` reference (none allowed).
- Writes `dist/single-file/index.html` by default; `--out <path>` writes elsewhere (used by
  the test suite's global setup so tests never dirty `dist/`).
- The inliner itself is a pure function in `scripts/lib/inline-html.js` → unit-tested.
- Browser-mode limitations (documented in the banner, README, and the page's `<title>`):
  no always-on-top, no frameless OS window, no drag-to-move (it's a tab), persistence via
  `localStorage` (per-browser, per-origin — `file://` origins are fine in Chrome/Safari/
  Firefox), × and grip hidden. Clock, stopwatch, hover controls all work. Tip in README:
  open it in a tiny "picture-in-picture-ish" browser window and set the browser window to
  float with a third-party tool if you must — or just use the Electron build.

**`build:source` (`build-source-zip.js`)**
- Walks `overtime/` with an explicit ignore list (`node_modules`, `dist`, `test-results`,
  `playwright-report`, `.DS_Store`, `*.log`) — **not** `git archive` (uncommitted files must
  be included while the project is young). Zips into `dist/source/overtime-source-v0.1.0.zip`
  with a top-level folder `overtime-source/`.

**`clean` (`clean.js`)**
- `rm -rf <SCRATCH>` and `rm -rf dist/*` (keeps `dist/` itself + a `.gitkeep`? No — just
  recreate `dist/` empty; the next build repopulates). Prints what it removed. Refuses to run
  if `SCRATCH` somehow resolves to something outside `os.tmpdir()` (paranoia guard).

### 4.4 Inliner contract with the renderer (binding on the app agent)

- `index.html` references assets **only** via `<link rel="stylesheet" href="./styles.css">`
  and `<script src="./…js">` / `<script src="../shared/…js">` — relative, no `type="module"`,
  no `defer`/`async` reliance beyond document order, no `<img src>`/fonts/external URLs.
- Scripts in order: `../shared/format.js`, `../shared/stopwatch.js`, `./bridge.js`, `./app.js`.
- No literal `</script>` strings inside JS (the inliner escapes anyway, but don't).

### 4.5 Host runbook (goes in README; summarized here)

```bash
cd overtime
npm install                 # first time (Electron prebuilt + Playwright + electron-builder)
npx playwright install chromium   # once, for the single-file tests
npm start                   # try it
npm test                    # unit + single-file + electron projects
npm run build               # → dist/{mac,windows,single-file,source}/
git add dist && git commit  # the PRD wants dist/ committed (see R1 before you do)
```

---

## 5. Test plan (`npm test` = `playwright test`)

### 5.1 `playwright.config.js`

```js
module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  fullyParallel: false,            // Electron project launches real windows; keep it serial
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/helpers/global-setup.js',   // builds single-file → <SCRATCH>/test/index.html
  projects: [
    { name: 'unit',        testMatch: /.*\.unit\.spec\.js/ },                     // pure Node, no browser
    { name: 'single-file', testMatch: /widget\.browser\.spec\.js/, use: { ...devices['Desktop Chrome'], headless: true } },
    { name: 'electron',    testMatch: /widget\.electron\.spec\.js/ },             // uses _electron; host only
  ],
});
```

- `EPISODE_TIMER_SKIP_ELECTRON=1` makes the electron spec `test.skip()` itself with a clear
  message — so the suite is still green in the VM (which has Node 26 and cached Playwright
  Chromium, so **unit + single-file projects can run inside the VM** — the verifier agent
  should do exactly that, see §7).
- Deterministic time via **`page.clock`** (Playwright ≥ 1.45; we have 1.64): `page.clock.install({ time: '2026-10-31T10:42:00' })` before load → assert `10:42 AM`; `page.clock.runFor(60_000)` → `10:43 AM`; `page.clock.runFor(3_661_000)` while running → stopwatch `01:01:01`. `page.clock` fakes `Date`, timers, and `performance` consistently, so D4/D5 are directly testable. In Electron, `firstWindow()` is already loaded, so: `install` then `page.reload()`.

### 5.2 Test matrix → PRD acceptance checklist

| PRD acceptance item | Test | Project |
|---|---|---|
| Transition table (Play/Pause/Stop/Reset) | `stopwatch.unit.spec.js`: table-driven over all 4×4 cells incl. identity no-ops, `elapsedMs` math, `fromPersisted` running→paused, clamp of negative deltas, garbage input | unit |
| Formatting | `format.unit.spec.js`: 00:xx→12:xx AM, noon→12 PM, 23:59→11:59 PM; `hour12:false` → `23:59` + empty meridiem; `showSeconds` → `HH:MM:SS`; `formatElapsed` 0, 59 999 ms, 3 599 999, 100 h | unit |
| Config tolerant / schema / defaults | `config-schema.unit.spec.js`: `normalizeConfig(undefined/null/'junk'/[]/{})` → `DEFAULT_CONFIG`; partial file gets defaults filled; `opacity: 7` → `1`; `theme: 'neon'` → `'dark'`; unknown keys dropped; `timer.status:'running'` → `paused`; `schemaVersion: 99` → defaults | unit |
| Config file I/O (atomic, corrupt-safe) | Electron: launch with a `config.json` containing `{not json` → app starts with defaults **and** `config.json.corrupt-*` exists next to it; after a transition, `config.json` parses, has `schemaVersion`, `window`, `timer`, and a complete `settings` object with all six keys; no `.tmp` left behind | electron |
| Settings are wired (no UI) | Electron + single-file: pre-seed `settings: { hour12:false, showSeconds:true, opacity:0.9, theme:'light', font:'mono' }` (config file / localStorage) → `#clock-time` matches `/^\d{2}:\d{2}:\d{2}$/`, `#clock-meridiem` hidden, `#app[data-theme="light"]`, `--pill-opacity` computed `0.9`, `#app` font-family contains `Menlo`/`monospace`. Electron: `setSettings({alwaysOnTop:false})` via `page.evaluate(window.__episodeTimer…)` → `win.isAlwaysOnTop()===false`, then `true` again; `settings:changed` round-trip updates the DOM | single-file + electron |
| Never opens off-screen | Electron: pre-seed `window: {x: 99999, y: 99999, width: 300, height: 163}` → launched `getBounds()` lies fully inside some `screen.getAllDisplays()[i].workArea` and `width===300` (size kept, position fixed) | electron |
| Single-file build correctness | `inline-html.unit.spec.js`: tags replaced in order, no `src=`/`href=` left, `</script` escaped, absolute URL → throws | unit |
| Wall clock renders & ticks | `#clock-time`/`#clock-meridiem` text under `page.clock`; `runFor(60s)` increments minute | single-file + electron |
| Stopwatch Play/Pause/Stop/Reset in the DOM | click buttons; assert `data-status`, button `disabled` pattern per state, `#stopwatch` text after `runFor` | single-file + electron |
| Controls appear on hover, hide on mouse-out | `page.hover('#face')` → `data-hover="true"` and `#controls` opacity 1; `page.dispatchEvent('html','mouseleave')` → `false`, opacity 0 (use `toHaveCSS` with Playwright's auto-wait so the 150 ms transition settles) | single-file + electron |
| Resize scales content | measure `#clock-time` computed `font-size` at 240×130 vs 480×260 (`page.setViewportSize` in browser; `win.setSize` via `app.evaluate` in Electron) → ratio ≈ 2 ± 5 % | single-file + electron |
| Persistence restores elapsed | browser: run 5 s, pause, `page.reload()` → `00:00:05`, status `paused`. Electron: run, **close app**, relaunch with same `EPISODE_TIMER_USER_DATA` → value restored, status `paused` (D6); also close *while running* → relaunch shows the value frozen, `paused`, and no offline time added (advance `page.clock` doesn't matter — assert equality with the value at close ±1 s) | single-file + electron |
| Remembers window position AND size | Electron: `win.setBounds({x:300,y:200,width:300,height:163})`, close, relaunch → `getBounds()` matches (±1 px for aspect rounding) | electron |
| Frameless / transparent / always-on-top / resizable / no taskbar | Electron `app.evaluate`: `win.isAlwaysOnTop()`, `win.isResizable()`, `win.isMaximizable()===false`, `win.isVisibleOnAllWorkspaces()` (mac), `BrowserWindow` created with `transparent` (check `win.getBackgroundColor()`/`webContents` background is transparent or just assert `document.body` computed background is `rgba(0,0,0,0)`), window has no menu bar; `data-env="electron"` | electron |
| OBS can capture (content protection off) | static assertion: read `main.js`, assert `/setContentProtection\(\s*true/` does **not** match; plus a comment-presence check for the `DELIBERATELY ABSENT` note | unit |
| Draggable by the face | static/DOM: `getComputedStyle(#face)['-webkit-app-region']==='drag'`, each `button` and `#grip` `=== 'no-drag'` (Chromium exposes the property) | single-file + electron |
| Resize grip works | Electron: pointer-drag `#grip` by (+60,+32) → `getBounds()` grew (aspect-locked) | electron |
| Quit button | Electron: click `#btn-quit` → `app.waitForEvent('close')` resolves | electron |
| Browser-mode hides Electron-only affordances | `#btn-quit`, `#grip` hidden when `data-env="browser"` | single-file |

### 5.3 Test helper contract

`tests/helpers/launch-electron.js` → `launch({ userData, seedConfig })`: creates/uses a temp
dir, optionally writes `seedConfig` (object **or raw string**, for the corrupt-file test) to
`<userData>/config.json` first, then calls
`_electron.launch({ args: [path.join(ROOT)], env: { ...process.env, EPISODE_TIMER_USER_DATA: userData, EPISODE_TIMER_TEST: '1' } })`,
waits for `firstWindow()`, returns `{ app, page, win: (fn) => app.evaluate(({BrowserWindow}, …) => …) , close() }`.
`EPISODE_TIMER_TEST=1` makes main skip the single-instance lock (parallel test launches)
and skip `app.dock.hide()` (harmless, but keeps the host's dock calm during a test run).

Note for the host: the Electron project **opens real windows** on screen while it runs —
"headless" here means "unattended", not invisible. ~10–20 s total.

---

## 6. Docs plan

Voice: the channel's — informal, a bit cheeky, zero corporate gloss. Short paragraphs,
real commands. The reader is the host (and curious viewers).

### 6.1 `README.md`
1. What it is (two sentences + the "10-minute episode took 90" origin gag).
2. **Host-runs banner**: "the VM wrote this; your Mac runs it."
3. Quick start: `npm install`, `npm start`. One screenshot-free ASCII sketch of the widget.
4. Using it: hover → controls; Play/Pause/Stop/Reset meanings (one line each); drag by the
   face; resize by the corner grip; × to quit.
4b. **Config file** (`config.json`, both OS paths): what's in it, that it's safe to delete,
   and the honest line: "there's no settings window yet — `settings` in this file *is* the
   settings UI for v1. Quit the app, edit, relaunch." Table of the six settings with
   allowed values and defaults.
5. OBS tip: use **Display Capture** (or add the widget as its own Window Capture source);
   Window Capture of the app you're recording won't include the overlay.
6. Scripts table (all 8 scripts, one line each) and the `dist/` layout.
7. Building: what each target produces (`.app` zip, `win-unpacked` zip, single file,
   source zip — **no installers, unsigned, by design**), the arm64/x64 flag, "Windows build
   is cross-compiled and the exe wears Electron's stock icon", "dist/ is committed on
   purpose — mind the repo size".
8. Testing: how to run all / one project / in the VM (`EPISODE_TIMER_SKIP_ELECTRON=1`).
9. Single-file mode: what works, what can't.
10. Gatekeeper + SmartScreen: one line each (right-click → Open; on macOS 15+ it's System
    Settings → Privacy & Security → Open Anyway. Windows: More info → Run anyway).
11. Troubleshooting: window went opaque (DevTools open), not above a fullscreen app (dock
    icon/LSUIElement + `visibleOnFullScreen`), lost state (file path), two clocks (single
    instance).
12. Out of scope list (from PRD) so nobody files feature requests for themes.

### 6.2 `ARCHITECTURE.md`
1. Process model diagram (ASCII): main ⇄ preload ⇄ renderer; browser mode = renderer alone
   with `localStorage`.
2. File map with one-line responsibilities (mirror §1).
3. Window configuration, flag by flag, *why* (mirror §2.1/2.2) — including the deliberate
   absence of content protection and the dock-hide trick.
4. IPC contract table (§2.3) + security posture (contextIsolation, sandbox, validation).
5. Stopwatch state machine: the table, the anchor math, why not `setInterval +=`, the
   `Date.now()` vs `performance.now()` trade-off.
6. Config & persistence: the full schema incl. `settings`, paths, atomic write + corrupt-file
   rename, restore-as-paused, off-screen clamp, write cadence, and **"how to add a settings
   UI later"** (new BrowserWindow → `config:set-settings` → `settings:changed` → `applySettings`;
   that's the entire recipe).
7. Rendering/scaling: `vmin` + aspect lock, hover state attributes, the grip.
8. Build pipeline: flow diagram scratch→stage→zip→dist; electron-builder config; why `dir`
   for both (no installers, no Wine, no signing); the inliner; naming.
9. Test strategy: projects, `page.clock`, what runs where (VM vs host).
10. Decisions log (copy §0) + known limitations.

### 6.3 Bundled READMEs (`docs/usage-mac.txt`, `docs/usage-windows.txt` → `README.txt` in each zip)
Plain text, ~30 lines, no Markdown rendering assumed:
- What this is (3 lines) + link to the channel/repo.
- **Launch — macOS:** unzip; put `Overtime.app` wherever; double-click. **One-line
  Gatekeeper note:** "It's unsigned (on purpose). If macOS balks: right-click → Open; on
  macOS 15+ go System Settings → Privacy & Security → Open Anyway." That's it — no essay.
- **Launch — Windows:** **unzip fully first** (don't run from inside the zip viewer),
  open the `Overtime` folder, run `Overtime.exe`. SmartScreen: "More info" →
  "Run anyway". Built on a Mac, lightly tested — holler if something's off.
- Controls: hover to reveal; ▶ ⏸ ⏹ ↺ one line each; drag by the face; corner grip to
  resize; × quits. Cmd/Ctrl+Q also works when the widget is focused.
- It remembers position/size/elapsed between launches; `config.json` path; "the `settings`
  block in there is the settings panel until we build one."
- OBS: use Display Capture.

---

## 7. RECOMMENDED BUILDER-AGENT TRAIN

Total app is small (~600–900 lines of app code, ~400 of scripts, ~500 of tests, ~400 of
docs). Five agents, three phases, two fix-up loops. All agents get **this PLAN.md + PRD.md
+ CLAUDE.md** as required reading and the ownership table from §1. No worktrees needed —
files are disjoint and all new — but every agent must be told: *touch only your owned
files; do not run `npm install`, `npm test`, or any build; do not edit `package.json`.*

### Phase 1 — three agents **in parallel**

| Agent | Scope / owned files | Depends on | Model |
|---|---|---|---|
| **A · app-implementer** | `main.js`, `preload.js`, `src/main/*`, `src/shared/*`, `src/renderer/*`. Must honor the frozen DOM contract (§2.5), IPC names (§2.3), **config schema + settings plumbing + off-screen clamp (§2.4, D14/D15)**, inliner contract (§4.4), env vars (`EPISODE_TIMER_USER_DATA`, `EPISODE_TIMER_TEST`), the `--devtools` flag, and the "well-commented, human-organized" requirement. Must *not* call `setContentProtection`. Should self-check with `node --check` on every file and `node -e "require('./src/shared/stopwatch.js'); require('./src/shared/config-schema.js')"` smokes, including feeding `normalizeConfig` garbage. | PLAN only | **Opus-class** (Electron quirks, transparent-window details, taste in comments) |
| **B · build-pipeline-implementer** | `scripts/**`, `build/` (optional icon). Programmatic electron-builder with `dir` targets only, `signAndEditExecutable:false`, `identity:null`, scratch dir, staging+zip with `README.txt`, `--out` for single, `--x64` for mac, clean guard. **Explicitly forbidden:** dmg/pkg/nsis/portable targets, any signing/notarization env, any Wine/mono dependency, retries/fallbacks around signing. B self-checks with `node --check` and by running `build-single-file.js --out <scratch>` **once A's renderer exists** (write against the §4.4 contract; run the real inline in Phase 2 fix-up). | PLAN (§4.4 contract); A for a live smoke | **Sonnet-class at high effort is sufficient** now that the pipeline is deliberately boring; Opus if budget is loose |
| **C · test-writer** | `tests/**`, `playwright.config.js`. Writes against §2.5/§5 contracts; unit tests `require()` the shared modules and the inliner directly. | PLAN (contracts) | **Sonnet-class** is fine (contracts are explicit); Opus if budget allows for the Electron spec's `app.evaluate` plumbing |

Why not split A further: main/preload/renderer share the IPC + config contract and total
maybe 900 lines (the config module added ~200); one brain avoids seam bugs. **If the
orchestrator wants more parallelism**, the clean split is A1 = `src/shared/*` +
`src/renderer/*` + `preload.js` (browser-first, testable with localStorage) and A2 =
`main.js` + `src/main/*` (config file I/O, window state/clamp, IPC handlers); the contract
between them is exactly §2.3–2.5, and `config-schema.js` belongs to A1 (A2 only consumes
it). Not recommended by default; acceptable if wall-clock time matters more than seams.

### Phase 2 — after A and B report (C can still be finishing)

| Agent | Scope | Depends on | Model |
|---|---|---|---|
| **D · docs-writer** | `README.md`, `ARCHITECTURE.md`, `docs/usage-mac.txt`, `docs/usage-windows.txt`. Reads the *actual* code from A and B so nothing in the docs is aspirational; channel voice per CLAUDE.md. | A, B done | **Opus-class** (voice matters; it's part of the show) — Sonnet acceptable |
| **E · adversarial verifier** | Read-only review of A+B+C against PRD acceptance list + this plan's frozen contracts; **and actually runs what the VM can run**: `node --check` on every JS file, `node -e require()` of the shared modules, `node scripts/build-single-file.js --out <scratch>`, then — using the repo-root `node_modules/playwright` (1.64.1, Chromium already cached) — a throwaway script that loads the built single-file in headless Chromium and exercises hover/play/pause/reset/persistence. (The `overtime` `@playwright/test` isn't installed in the VM, so it drives `playwright` directly rather than running `npm test`.) Reports a numbered findings list with severity and the owning agent. Specifically hunts: contract drift between A/C (IDs, attrs), IPC payload validation, **config: non-atomic writes, a crash path on corrupt JSON, settings not actually applied (e.g. `hour12:false` still showing AM), missing off-screen clamp, `alwaysOnTop` setting ignored by main**, **build: any installer target / signing / Wine creeping back in**, the `</script>` escape, `files` glob missing `src/**`, scratch path outside tmp, aspect-lock vs min-size conflicts, `mouseleave` never firing, anything that would make `npm test` red on the host. | A, B, C done | **Opus-class** (adversarial, needs judgment) — give it the code, *not* the authors' conclusions |

D and E run **in parallel** with each other.

### Phase 3 — fix-up loops

1. Orchestrator routes E's findings back to **the same A/B/C agents via `SendMessage`**
   (they keep context; cheaper and less drift than fresh agents). D patches docs for
   anything that changed.
2. E re-verifies the touched items (second `SendMessage` to E).
3. Orchestrator hands the host a one-screen runbook (§4.5) and the list of things only
   the host can verify: Electron tests, `npm run build` for mac/win, OBS capture, over-
   fullscreen behaviour, Windows smoke test on a real PC.
4. **Expect one more loop after the host runs it** — real Electron on real macOS will
   surface something (R2–R5). Plan the session for it; it's good footage anyway.

### Phase ordering summary

```
PLAN ──► [A app] ─┐
     ──► [B build]├──► [D docs] ─┐
     ──► [C tests]┘──► [E verify]┴──► fix-ups via SendMessage ──► host runs ──► fix-ups
```

---

## 8. Risks / unknowns for the human

| # | Risk | Severity | Mitigation / decision needed |
|---|---|---|---|
| **R1** | **Committing `dist/` bloats git forever.** Each mac zip ≈ 100 MB, each win zip ≈ 100 MB, *per version*, in history. Ten rebuilds ≈ 2 GB clone. The PRD asks for it; this plan honours it but builds every script to *empty its dist subfolder first* so at least the working tree stays single-version. | High (long-term) | Decide: (a) keep as-is; (b) commit only `single-file/` + `source/` and attach the two Electron zips to a GitHub Release; (c) Git LFS for `dist/**/*.zip`. Recommendation: **(b)**. Scripts don't change either way. |
| **R2** | **Windows `.exe` wears Electron's stock icon and "Electron" version info.** We set `signAndEditExecutable: false` so the cross-build never needs Wine/mono (patching the exe is the *only* step that would — confirmed in electron-builder's source). Also: the build is never *run* on Windows by us. | Low (cosmetic) + needs a smoke test | Accept for v1. Someone with a Windows PC should launch the zip once before it's advertised. If a custom exe icon ever matters, that's a Windows-CI job, not a macOS one. |
| **R3** | **Unsigned on both platforms, by design.** macOS: Gatekeeper warns; on macOS 15+ right-click→Open no longer bypasses it (it's Privacy & Security → "Open Anyway"). Windows: SmartScreen "unknown publisher". | Low (one-line notes in the READMEs) | Documented in one line each. Not v1: a $99 Developer ID + notarization would remove the mac friction entirely — the host's call, later. |
| **R4** | **Transparent + frameless window quirks**: Electron docs still say transparent windows "are not resizable" and may break on some platforms (in practice macOS copes; Windows is flakier). Also possible: `mouseenter`/`mouseleave` oddities over `-webkit-app-region: drag`; window turns opaque with DevTools open; no native shadow. | Medium | D10 grip makes resize OS-independent; §2.6 names the main-process cursor-poll fallback for hover; aspect lock + min size keep geometry sane. Host validates on first `npm start`. |
| **R5** | **Over-fullscreen on macOS** depends on the dock-hide / `LSUIElement` + `visibleOnFullScreen` combo and the `'screen-saver'` level; behaviour has shifted across macOS releases. OBS Display Capture should see it regardless. | Medium | Test on the host over a fullscreen app *and* over OBS's own preview. If it fails, try level `'floating'` + `app.dock.hide()` ordering (hide → setVisibleOnAllWorkspaces → show window). |
| **R6** | **Sleep semantics** (D5): with `Date.now()`, closing the lid mid-`running` counts the nap as episode time. | Low — a taste call | One-line swap to `performance.now()` if the host prefers "only count while awake". Ask. |
| **R7** | **Toolchain versions**: Electron ^34 + electron-builder ^25.1.8 + Node 26 on the host is a combination nobody has blessed; electron-builder 25 predates Node 26. Playwright 1.64 `_electron` with Electron 34 should be fine. | Medium | If `npm install`/build chokes, bump `electron-builder` to `^26` (one line, orchestrator approval since `package.json` is frozen for agents). Keep the Electron major pinned once it works. |
| **R8** | **Apple Silicon refuses arm64 binaries with *no* signature at all** ("Killed: 9"). electron-builder normally applies a free *ad-hoc* signature when `identity: null` (not a certificate; nothing to buy or configure) — visible only in its log. | Low | `build-mac.js` surfaces that log line. If the host's first launch is killed, the one-line fix is `codesign --force --deep --sign - "Overtime.app"` in the script. Not pre-added (keep signing out of the pipeline unless proven necessary). |
| **R12** | **Config schema is a public-ish contract now** (the host may hand-edit `config.json`; the README tells them to). A future field rename needs a `migrate()` case, not a silent default. | Low | `SCHEMA_VERSION` + `migrate()` hook exist from day one; the unit test pins the default shape so accidental drift fails CI. |
| **R9** | **`dist/` zips and the single file are built from whatever is on disk**, not from a commit — a dirty tree ships. | Low | `build-all.js` prints `git status --porcelain overtime` as a warning if non-empty. |
| **R10** | **The VM can't prove the Electron half.** Everything Electron-specific (always-on-top, transparency, drag, bounds persistence, the Electron Playwright project) is unverifiable until the host runs it. | Inherent | Phase 3 loop is budgeted; E verifies the browser half for real in the VM. |
| **R11** | **Icon**: none planned for v1 → stock Electron atom icon in Finder/dock-less-but-Cmd-Tab. | Cosmetic | Stretch S1: a 1024² PNG rendered from a tiny HTML card with the repo's existing `scripts/render-cards.js` approach; drop it in `build/icon.png` and electron-builder does the rest. |

### Stretch (explicitly not v1, listed so nobody improvises them)
- **S1** App icon via the title-card renderer (mac only; the Windows exe icon needs a
  Windows/Wine build and stays stock). **S2** `--x64` mac build and/or `universal`.
- **S3** A settings window — the plumbing is done (D14); the UI is deliberately not v1.
  **S4** Installers (dmg / NSIS) from a Windows or CI box, if ever.
- Anything in the PRD's out-of-scope list stays out.
