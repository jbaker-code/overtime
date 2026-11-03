# Overtime — PRD

> **Developer archive.** This is the original product spec, written before any code
> existed and while the app was still called *Episode Timer* and lived at `tools/clock/`
> inside the BakerCode YouTube repo. It's kept for posterity — the shipped app is
> described in [`../GUIDE.md`](../GUIDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
> which win wherever they disagree with this. See "Current state" at the bottom for how
> the build diverged from this spec.

> A tiny always-on-top desktop widget that sits inside the recorded region of the
> screen and shows **(1) the current time** and **(2) how long the current episode
> has been recording**. Born from the meta-gag: planning that "10-minute" episode
> took ~90 minutes. Now we put the clock on screen so viewers watch the time burn.

---

## Framework decision: **Electron** ✅

Both of the "scary" requirements — **frameless/chromeless** and **always-on-top** —
are first-class, well-supported Electron features. Electron is NOT a limitation here;
it does everything on the list, with responsive HTML/CSS (which matches how the rest
of this repo already works — title cards, intro deck, etc.) and gives us Windows for
free as a bonus. The memory footprint is irrelevant for a widget this small.

**Native Swift (SwiftUI/AppKit) is the alternative** — a borderless `NSWindow` with
`.floating` level and `ignoresMouseEvents` toggling — and would be lighter and more
"Mac-native." But it's more work, macOS-only, and doesn't reuse our HTML skills. We'd
only reach for Swift if Electron's always-on-top ever proved flaky over OBS/fullscreen
(it won't for this use). **Recommendation: Electron.**

### The exact Electron settings that satisfy the requirements
```js
const win = new BrowserWindow({
  width: 240, height: 130, minWidth: 140, minHeight: 80,
  frame: false,            // ← no OS title bar / window chrome, ever
  transparent: true,       // ← chromeless look; rounded corners possible
  hasShadow: false,
  resizable: true,         // ← drag to resize; content scales (see below)
  alwaysOnTop: true,       // ← floats on top
  skipTaskbar: true,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
});
win.setAlwaysOnTop(true, 'screen-saver');                        // stays above most things
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // over Spaces/fullscreen
// IMPORTANT: do NOT call setContentProtection(true) — OBS must be able to capture it.
```
- **Frameless when idle, controls on hover:** since `frame:false` there's no OS chrome
  at all. We render our *own* control strip in HTML and reveal it on mouse-hover (see
  UI). This is exactly the "no chrome unless I mouse over it" behavior requested — and
  cleaner than relying on the OS title bar.
- **Dragging a frameless window:** CSS `-webkit-app-region: drag` on the clock face;
  `-webkit-app-region: no-drag` on every button so clicks still register.
- **Responsive scaling:** size all type/spacing in `vmin`/`vw` units (or a single
  `transform: scale()` tied to window size) so the whole widget scales smoothly as the
  window is dragged bigger/smaller. (Same trick as the title cards' container units.)

---

## Platforms
- **Primary:** macOS, Apple Silicon (host is an M2 Air).
- **Bonus:** Windows works too (Electron) — nice for viewers who want to use it.

---

## UI / layout

Two readouts, clean and legible, **big tabular numerals** (so digits don't jiggle):

1. **Wall clock** — current time, 2-digit `HH:MM`, with `AM`/`PM` in a **smaller font**
   beside/under it. (Seconds optional; default off to stay calm.)
2. **Episode stopwatch** — elapsed `HH:MM:SS`: how long this episode has been going.

**Idle (no hover):** just the two readouts on a subtle translucent rounded background
(transparent window enables rounded corners + a faint dark pill so it reads over any
screen content). Nothing else.

**Hover (mouseenter):** a control strip fades in (play / pause / stop / reset); the two
readouts shrink slightly to make room. **On mouseleave**, the strip hides and the
readouts return to full size. Smooth, quick transition.

Keep it **minimal — not very customizable** (host's call). One clear font, high
contrast, done.

---

## Controls & state machine

Four controls: **▶ Play · ⏸ Pause · ⏹ Stop · ↺ Reset** — acting on the **episode
stopwatch only** (the wall clock always just runs).

| State | ▶ Play | ⏸ Pause | ⏹ Stop | ↺ Reset |
|-------|--------|---------|--------|---------|
| **Stopped (0)** | → Running | — | — | — |
| **Running** | — | → Paused | → Stopped (keeps value) | → Stopped (0) |
| **Paused** | → Running (resume) | — | → Stopped (keeps value) | → Stopped (0) |
| **Stopped (value)** | → Running (resume) | — | — | → Stopped (0) |

- **Pause** = temporary freeze, keep value. **Stop** = "done for now," halt and keep the
  final value frozen on screen. **Reset** = back to `00:00:00`.
- Builder has latitude on the exact button affordances (icons, enabled/disabled states).

### Config & persistence (required)
A single JSON config file in Electron's `userData` dir (hand-rolled or `electron-store`),
written atomically, holding:
- **Window bounds** — position (x, y) AND size (w, h) — so the widget reopens exactly
  where and how big it was. Clamp to the currently-visible screen on restore (displays
  may have changed), so it never opens off-screen.
- **Episode stopwatch** — `elapsedMs` + state, so closing/reopening restores the frozen
  value (only counts while Running; never back-fills closed time).
- **A `settings` object** — `layout`, `font`, `bgColor`, `textColor` (each a ~10-option
  catalog) plus `opacity`, `showSeconds`, `hour12`, `alwaysOnTop`. *(No `theme` key —
  `data-theme` is derived from `bgColor` luminance for control contrast.)* **v2 ships an
  in-app tabbed settings panel** (⚙ → Layout / Font / Colors, click-to-select) that edits
  the first four live; the other three remain config-file-only for now.
Config must tolerate a missing or corrupt file — fall back to sensible defaults, never
crash.

---

## Build, distribution & tests

**Claude writes; the host runs.** The VM can't run an Electron GUI or produce installers,
so subagents WRITE everything; the **host** runs `npm install`, `npm run build`,
`npm test`, `npm start`.

### Output layout — scratch stays out, `dist/` gets committed
- **Scratch / intermediate junk** (electron-builder's unpacked apps, caches): a temp dir
  OUTSIDE the repo — `<os-tmpdir>/overtime-build-scratch/`. Never committed, never clutters
  `overtime/`. *(If you'd rather it live in a repo-root `tmp/`, it's a one-line change.)*
- **Final distributables → `overtime/dist/` (committed to git as-is):**
  - `dist/mac/`         — macOS `.app` as TWO zips (arm64 + x64), README inside each
  - `dist/windows/`     — Windows app (unpacked: `.exe` + runtime), zipped, + README inside
  - `dist/single-file/` — one self-contained `index.html`
  - `dist/source/`      — a source zip of the app

### npm scripts (scaffolded in package.json)
- `npm start`          — run the widget (host, for dev)
- `npm run build`      — build EVERYTHING: mac + windows + single-file + source → `dist/`
- `npm run build:mac` / `:win` / `:single` / `:source` — individual targets
- `npm test`           — headless Playwright acceptance suite
- `npm run clean`      — wipe the scratch temp + `dist/`

### Targets — notes that matter
**No installers.** Ship the raw built binary + a README in a zip — nothing fancier.
- **macOS:** the `.app` bundle, zipped with a README (no `.dmg`, no `.pkg`). Unsigned for
  v1 → users right-click → Open past Gatekeeper (document this in the README).
- **Windows:** the built app via electron-builder's **`dir` (win-unpacked)** target — a
  folder containing `Overtime.exe` + the Electron runtime — zipped with a README.
  **No NSIS installer.** The `dir` target cross-builds from the Mac host without wine/mono
  (this is the part that's worked here before; the installer targets are what need wine).
- **Single-file HTML:** everything (HTML/CSS/JS) inlined into one `index.html` that runs
  in any browser. ⚠️ Browser mode can't do always-on-top or a frameless OS window (those
  are Electron-only); clock + stopwatch + hover controls still work.

### Documentation (required)
- Code **well-commented and human-organized** (the host wants to read it).
- `README.md` (what it is, how to run/build/test) + `ARCHITECTURE.md` (how Electron is
  wired — main/preload/renderer/IPC — and how the build pipeline works).
- A concise **usage doc bundled inside each Electron zip** (mac & windows): what it is,
  how to launch, how the controls work, the Gatekeeper/SmartScreen note.

### Tests — headless acceptance suite
- **Playwright** (dev dependency) drives a headless acceptance suite via `npm test`:
  launch the Electron app with Playwright's `_electron` and/or load the single-file in
  headless Chromium, and assert the acceptance checklist — wall clock renders & ticks,
  stopwatch Play/Pause/Stop/Reset transitions, hover reveals/hides controls, resize scales,
  persistence restores state.

---

## Out of scope
Multiple/named timers, sound/notifications, cloud sync, auto-start-on-boot. *(v2 added the
look-&-feel settings panel.)* Keep it one small, sharp widget.

## Acceptance checklist
- [ ] Frameless, transparent, rounded; no OS chrome visible when idle.
- [ ] Always on top — stays visible over the app being recorded (and over fullscreen).
- [ ] Draggable by the clock face; resizable, and everything scales with the window.
- [ ] Wall clock `HH:MM` + small `AM/PM`, updating each second.
- [ ] Episode stopwatch `HH:MM:SS` with working Play/Pause/Stop/Reset.
- [ ] Controls appear on hover, hide on mouse-out.
- [ ] Remembers window position/size and the episode's elapsed value between launches.
- [ ] Is captured correctly by OBS (content protection OFF).

---

## Current state (as built — supersedes anything above that conflicts)

v1 shipped, then iterated heavily on camera. Deltas from the original spec:

- **Controls:** Play / Pause / Reset / ⚙ Settings / × Quit. **No Stop button** (redundant
  with Pause; `sw.stop()` stays in the state machine, unwired).
- **Window:** frameless + transparent + always-on-top. **Free resize** (no aspect lock).
  **Min 100×60.** Drag from anywhere on the pill or the settings title bar. The readouts
  **scale to fill** the window (min ~6px padding); controls overlay instead of reserving space.
- **macOS presence:** **menu-bar tray icon, NO Dock** (accessory app via `app.dock.hide()` +
  `LSUIElement`). Tray menu: Play · Pause · Reset · ✓ Show-clock · ✓ Show-stopwatch ·
  Settings… · Show/Bring-to-Front · ✓ Float-on-top · Quit; clicking the icon raises the
  window. **Show-clock / Show-stopwatch** are checkboxes that hide/show each readout (both
  off ⇒ a blank pill). Tray glyph
  `build/trayTemplate.png` (+`@2x`); app icon `build/icon.png`.
- **Settings panel:** 3 tabs — **Layout / Font / Colors** (Advanced tab removed; float-on-top
  moved to the tray). Title + × on the top row → ~3× **live preview** (on a checkerboard so
  transparency reads) → tabs → grids (Layout & Font 5-per-row, ~2×, centered). Opening
  Settings **grows the window** (~720×620) and restores the prior size on close (grown size
  never persisted).
- **Settings schema:** `layout`, `font`, `bgColor`, `textColor` (each ~10-option catalogs),
  `opacity` (slider in Colors; **default 1.0 = solid**), `showSeconds`, `hour12`,
  `alwaysOnTop`, `showClock`, `showStopwatch` (both default `true`, toggled from the tray).
  No `theme` (derived from `bgColor` luminance).
- **Layouts:** the horizontal one-line layouts (`one-line`, `side-by-side`) got a roomier
  gap (~a non-breaking space) so the two readouts don't crowd each other.
- **IPC adds:** `window:settings-open` (renderer→main, grow/restore), `timer:command` +
  `ui:open-settings` (main→renderer, tray).
- **Build output:** `overtime/tmp/overtime-build-<date>-<slug>/dist/…` (shared, gitignored,
  dated, accumulates). electron-builder **scratch stays in OS temp** (symlink safety).
  `npm run clean` wipes both. No longer committed to git.
- **Testing:** browser/single-file in headless Chromium; **real Electron now runnable in the
  VM** via Playwright `_electron` + a locally-extracted binary at `~/et-electron`. A
  resize-stress test covers the fixed `setSize` integer-conversion crash.

> The tests + docs are mid-catch-up to all of the above — see `HANDOFF.md` → "catch-up batch".

### Beyond this spec (post-extraction)

After the app graduated into its own repo, the look-&-feel work kept going well past
what this PRD scoped — a system-font browser (`queryLocalFonts`) with a `customFont` /
`useCustomFont` model, a second **text-opacity** slider (text now renders through
`--text-rgb` + `--text-opacity`), a native right-click menu replacing the on-pill icons
in Electron, and (in progress) a **separate live-updating settings window**. This PRD is
*not* kept current for that work — **`docs/dev/HISTORY.md` and `docs/dev/DECISIONS.md`
are the source of truth** for everything after extraction.

---

## Current state (as of Round 2 + Pass N) — supersedes the stale sections above

> **This addendum is the authoritative snapshot of the shipped app.** It was written after
> Round 1, Round 2 and the Pass-N polish, and it **supersedes** the two older "Current state
> (as built)" / "Beyond this spec" sections above wherever they conflict (those predate the
> separate settings window, the recut palettes, the color picker, and Cutout). For the full
> story see `HISTORY.md`; for durable decisions `DECISIONS.md`; for the engineering rationale
> `TECHNICAL.md`; for how it's wired `../ARCHITECTURE.md`. **Verified against the source.**

**Core.** Wall clock (`HH:MM` + small AM/PM, or 24-hour with the meridiem hidden) + an
episode stopwatch (`HH:MM:SS`) with **Play / Pause / Reset**. No Stop button (Pause covers
"halt and keep the value"; `sw.stop()` stays unwired in the state machine). The pill is
**frameless, transparent, always-on-top, free-resize** (no aspect lock); readouts **scale to
fill** the window down to **100×20** (min width 100, min **height 20** — a one-line strip;
was 60). Content protection stays **off** (OBS must capture it).

**Controls by environment.** *Electron:* no on-pill control icons — driven entirely by a
**menu-bar tray** (no Dock; accessory app) **and** a native **right-click context menu** that
shares one template with the tray: *Start / Pause / Reset Stopwatch · ✓ Show clock · ✓ Show
stopwatch · Settings… · Show / Bring to Front · ✓ Float on top · Quit*. Hover paints the
whole pill 50% black as a grab affordance, driven by a **main-process cursor poll** (the
frameless drag region swallows DOM `mouseenter`/`mouseleave`). *Browser/single-file:*
on-pill **Play / Pause / Reset / Settings** buttons (no Quit), gated on `data-env="browser"`;
hover uses the DOM path.

**The separate live settings window (Electron).** Settings is now its **own frameless
`BrowserWindow` beside the pill** — it no longer grows the pill (the old
`growForSettings`/`restoreFromSettings`/`window:settings-open` round-trip is gone). The real
pill stays small over the wallpaper and updates **live** as you edit (`settings:changed`
broadcasts to **both** windows). It's resizable (bottom-right grip → `window:resize-by`, main
resolving the sender window), and its position+size persist under a `settingsWindow` bounds
key (~1262×975 default, clamped to the work area). The **browser/single-file** build keeps the
in-page overlay panel.

**Settings panel — Layout / Font / Colors tabs:**
- **Layout:** **10** arrangements (`stack`, `stopwatch-top`, `clock-left`, `side-by-side`,
  `split`, `one-line`, `dash`, `clock-hero`, `stopwatch-hero`, `centered-gap`).
- **Font:** **9** curated web-safe stacks (`system, mono, serif, helvetica, times, trebuchet,
  verdana, palatino, condensed` — `courier` was dropped) **plus a system-font browser**
  (`queryLocalFonts`, `local-fonts` permission) to pick any installed family. The active font
  = a remembered `customFont` when `useCustomFont` is on **and** it's actually installed
  (checked at apply time, fallback to the curated face), else the curated `font`.
- **Colors:** **9** background + **9** text **preset swatches**, *plus* a **dependency-free
  custom color picker** (hue ring + saturation/value square + hex) — `bgColor`/`textColor`
  now accept **any valid `#rrggbb`**, not just the swatches; `customBgColor`/`customTextColor`
  remember the last picked hex. **Two opacity sliders** (background `opacity` and text
  `textOpacity`, each reaching 0). A **Cutout** checkbox: the numerals become **holes punched
  through the opaque pill to the desktop** (a `<canvas>` `destination-out` knockout — text
  color ignored; `textOpacity` becomes the cutout strength).

**Settings schema — `SETTINGS_KEYS` is 16** (was 14): `layout, font, customFont, useCustomFont,
bgColor, textColor, customBgColor, customTextColor, opacity, textOpacity, cutout, showSeconds,
hour12, alwaysOnTop, showClock, showStopwatch`. No `theme` key (`data-theme` is derived from
`bgColor` luminance). `showClock`/`showStopwatch` toggle each readout from the tray (both off =
a blank pill). `hour12`/`showSeconds` have no panel tile yet (config-file only); `alwaysOnTop`
is the tray's "Float on top".

**Persistence.** Window bounds (pill `window` + the new `settingsWindow`), the stopwatch value
(restore-as-paused), and the full `settings` object — one atomic JSON file in `userData`,
corrupt-safe, clamped on-screen on restore. Browser mode mirrors it in
`localStorage['episode-timer.config.v1']`.

**Build & distribution.** Unchanged in intent: **no installers, unsigned**, mac arm64+x64
zips + a cross-built Windows `win-unpacked` zip + a single-file HTML + a source zip, into a
dated **`tmp/overtime-build-<slug>/dist/`** (gitignored). The published binaries live in the
separate **`overtime-releases`** repo (GitHub's 100 MB-per-file limit). The tray PNG is
deliberately **not** packaged (the `⏱` title fallback); process naming via
`productName` (packaged) / `app.setName` + `process.title` (dev).

*Clauses in the earlier sections now superseded:* the "~10-option catalogs" and "10 fonts /
10 colors" counts (now 10 layouts / 9 fonts / 9+9 swatches + any-hex picker); "Settings grows
the window ~720×620 and restores on close" (now a separate window); the 14-key schema that
predated `customBgColor`/`customTextColor` (now 16 keys); and min height 60 (now 20).
