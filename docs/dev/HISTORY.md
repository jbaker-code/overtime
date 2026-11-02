# Overtime — build history (informal)

> **Developer archive.** The informal build log from when the app was created on camera
> (as *Episode Timer*, under `tools/clock/`). Kept for the story of how it came together;
> for the app as it stands now see [`../GUIDE.md`](../GUIDE.md).

> A running, human-readable log of what we've built and fixed — newest stuff grouped at
> the bottom. Not a formal task ledger, just so we can both keep track as we move fast.
> (The planning rationale lives in `DECISIONS.md`; this is the "what changed" story.)

## What it is
An Electron desktop widget: a big **wall clock** (HH:MM + AM/PM) + an **episode stopwatch**
(HH:MM:SS), with **Play / Pause / Reset**. Frameless, transparent, always-on-top. Its
window position/size, the timer value, and all the look settings persist to disk. Builds to
**mac (arm64 + x64) + Windows zips + a single-file HTML + a source zip** — no installers.

## How it got built
Fable planned it, then a small agent train built it in parallel: **app** (Opus),
**build pipeline** (Sonnet), **tests** (Sonnet), **docs** (Opus), and an **adversarial
verifier** (Opus). Everything below is the live iteration after that.

## 🐞 Bugs squashed
- **Clock + stopwatch were frozen.** The render loop crashed on every tick — `formatClock`
  got a number instead of a `Date` (`"date.getHours is not a function"`), which killed the
  whole loop. Fixed → clock ticks, stopwatch runs, buttons work.
- **Resize crash** (the pop-up you hit). Dragging the window could throw
  *"TypeError: … conversion failure"* — a **fractional** width/height reached Electron's
  native `setSize()`, which only accepts **integers**. Fixed → round both dimensions +
  a finite guard. Now covered by an automated Electron test.
- **x64 build failed** (`Cannot read properties of null (reading 'from')`). electron-builder
  mutates the config object; we reused the same one for both Mac arches. Fixed → fresh
  config clone per build. Mac now builds arm64 **and** x64.
- **Build tripped on the shared folder** (`ENOTEMPTY`). Fixed → retry-tolerant dir reset.
- Minor test-contract nits: future config-version now resets to defaults; stopwatch hard-
  resets on garbage persisted data; two static tests no longer trip on their own comments.

## 🎨 Look & feel
- **Tabbed settings panel**: Layout / Font / Colors, ~10 click-to-select options each
  (10 layouts, 10 fonts, 10 background colors, 10 text colors) — all mix-and-match.
- Dropped the `theme` setting (now derived from the background color's brightness).
- **Live preview** of the real clock in the panel; made it **~3× bigger**; backed by a
  **checkerboard** so transparency is visible.
- **Solid pill by default** (opacity 1.0) — your chosen color shows true (was washing out).
- **Transparency slider** added (dial the see-through).
- **Panel restructured**: *Settings* title + **×** on the top row → preview → tabs; grids
  centered, Layout/Font **5-per-row and ~2× bigger**.
- **App icon**: the stopwatch-with-clock-hands (#6) → `build/icon.png`.

## 🪟 Behavior / window
- **Removed the Stop button** (redundant with Pause).
- **Free resize** — removed the aspect-ratio lock; edges resize one axis, corner both.
- **Lower minimum size** → 100×60.
- **Settings auto-grows** the window so it's editable, then **snaps back** on close (and
  never saves the grown size).
- **Drag from anywhere** on the pill (or the settings title bar).

## ✅ Landed (post-compaction session)
- **Font-fill** shipped: the face scales (CSS `transform`) to *fill* the pill (min ~6px
  padding); the hover controls overlay instead of squishing the readouts.
- **Menu-bar tray, no Dock** shipped: tray icon + menu, Advanced tab removed (float-on-top
  became a checkmark). New IPC: `timer:command`, `ui:open-settings`, `window:settings-open`.
- **Tests/docs catch-up batch — done.** Realigned every stale test to the app as it is now
  (Stop button gone; opacity default 1.0; 3 tabs; min 100×60; free resize; fit-to-fill
  measured by *rendered* size, not CSS font-size; pill solid-by-default + a translucency
  test). **The real Electron suite now runs in this VM** via the locally-extracted
  `~/et-electron` binary (and stays skippable with `EPISODE_TIMER_SKIP_ELECTRON`). Added
  coverage: a permanent **resize-stress** regression, **grow-on-settings**, **tray
  commands** (timer:command / ui:open-settings), the **settings-panel UI** (tabs + opacity
  slider + live preview), and **clock/stopwatch visibility**. Green across all three
  projects: unit + single-file (148) and electron (52).
- **New: Show clock / Show stopwatch** — two tray checkboxes (settings `showClock` /
  `showStopwatch`, default on) that hide/show each readout; turn both off for a blank pill.
- **One-line layouts roomier** — bumped the `one-line` and `side-by-side` gaps (~a
  non-breaking space) so the clock and stopwatch stop crowding each other.
- **Flaky noon test fixed** — it was grinding ~4,600 one-second ticks (slow under the
  per-tick fit-to-fill); now it *jumps* the fake clock with `setSystemTime` and pumps one
  tick. 626ms instead of a 30s timeout.

## ⚠️ Known minor gap (not a user-facing bug)
- Window bounds are persisted by `trackBounds` on the `moved`/`resized` events, which a real
  drag fires — so normal use remembers position fine. A bounds change made ONLY at close
  time races the `before-quit` `flushSync` (which runs first), so a position set purely
  programmatically right before quit may not persist. Noted here; left to agent A / a future
  pass since real-use persistence is unaffected.

## 🧪 Testing notes
- The **browser / single-file** build is driven in **headless Chromium** here — that's how
  the screenshots and most checks happen.
- **Headless Electron now works too.** The Electron binary lives at `~/et-electron` (VM local
  disk — the shared folder can't hold its symlinks), and Playwright's `_electron` launches
  the real app. Used it to prove the resize crash is gone (fired fractional/NaN/Infinity/huge
  resize deltas → window stayed alive with a valid integer size).

## 🧹 Repo housekeeping (outside the clock)
- `tools/` reorg: `transcribe` moved into `tools/transcribe/`.
- `.gitignore` consolidated into the repo root.

---

# Post-extraction life (Overtime as its own repo)

> Everything above happened while this was `tools/clock/` inside the YouTube repo. Below
> is the work after Overtime graduated into its own repo. **The workflow here hardened
> into a house rule:** every change is built by a **builder** subagent and then
> independently attacked by an **adversarial-verifier** subagent before it's called done.
> That caught several real bugs (see below) that a single pass would have shipped.

## ✅ Round 1 — the post-extraction feature round (all DONE)

Six passes (A–F), each builder-then-adversary. All landed.

- **Pass A — resize responsiveness + font crispness.** Fit-to-fill is now a **hybrid**:
  a cheap `transform: scale` keeps the type filling the pill *while you're actively
  dragging the resize*, then ~120ms after the resize stops we **bake a real `font-size`**
  so the text is genuinely crisp at rest (scaled text goes a little soft). The per-second
  tick stays reflow-free via a per-font *"is this font tabular?"* probe plus a shape
  signature, so a ticking digit never triggers a relayout. Added `-webkit-font-smoothing`
  for good measure.
  - 🐞 **Adversary catch (fixed):** proportional fonts (serif/Georgia) were clipping ~28%
    because the fit math assumed *same string length ⇒ same width* — false for anything
    non-monospace. Fixed with the tabular probe + a proven regression test.
- **Pass B — system-font browser + missing-font fallback.** You can now browse the
  fonts **actually installed on your machine** via `queryLocalFonts()` (new `local-fonts`
  permission wired in main), pick one into a `customFont` setting (deferred selection),
  with availability detection (a **positive-only** `queryLocalFonts` cache + a
  width-measurement check) and a graceful fallback to a curated default when a saved
  custom font isn't installed on this machine.
  - 🐞 **Adversary catch (fixed):** an "authoritative cache" bug that could *falsely drop
    an installed, actually-rendering font* mid-session. Fixed (cache is positive-only).
- **Pass C — pill chrome, menus, stopwatch, min-height.** Ripped the **5 on-pill control
  icons** out of the Electron build — it now drives entirely from the **tray + a NEW
  native right-click context menu** that shares one template with the tray menu. Stopwatch
  menu items renamed to **"Start / Pause / Reset Stopwatch."** Hover now paints the whole
  pill **50% black** as a grab affordance. Min window **height 60 → 20.** And **Reset
  while the stopwatch is RUNNING** now zeroes but *keeps running* (it used to pause).
- **Pass D — font-tab redesign + preview.** A **"Custom" tile** (always labeled
  "Custom") replaced the old name-bar + Edit button as the way into the system-font
  browser (retitled **"Choose system font"**). Clicking a system card **live-updates the
  preview only**; **Back** reverts, **Save** commits — and then the Custom tile itself
  renders in the chosen font. Dropped the redundant **"courier"** preset (9 curated fonts
  now). The settings preview became a **fixed size with its OWN scale-to-fit**
  (independent of the widget window), fixed a **1px jaggy fringe** on its rounded corners,
  nudged the "Settings" title, and killed a **startup background flash** by moving the
  hover tint onto a non-animating `#app::after` overlay.
- **Pass E — Colors tab dual opacity sliders.** Two sliders now: **background opacity**
  (the existing `opacity`, moved under the bg swatches, reaches 0 = fully clear) and a
  **NEW `textOpacity`** under the text swatches (text alpha, also reaches 0). Swatch grids
  centered; each slider sized to its own swatch section. *(This replaced the earlier
  "transparent color swatch/card" idea — sliders won.)*
- **Pass F — browser-only controls.** Restored the on-pill **Play / Pause / Reset /
  Settings** controls (NO Quit) for the **single-file / browser build ONLY**, gated on
  `data-env`. The Electron build stays controls-free (tray + right-click, per Pass C).

## 🚧 Round 2 — polish + live-settings round (QUEUED / IN PROGRESS)

The big move this round: **Settings stops growing the clock window and becomes its own
window** (Electron), so the real pill stays small over your wallpaper and updates live.

- **Pass G — Electron hover-tint fix + control polish. [IN PROGRESS]** The 50%-black
  hover tint (Pass C) isn't actually showing up in the *real Electron app*. Suspects: the
  frameless pill's drag region swallowing the `mouseenter`/`mouseleave` that toggles
  `data-hover`, and/or the `z-index:-1` tint overlay not compositing over a transparent
  window. Also on this pass: shift the browser controls so they don't overlap the
  stopwatch readout on hover, and flip the control-visibility gate to be **positive**
  (`[data-env="browser"]`).
- **Pass H — Settings becomes its OWN window (Electron) + live clock. [QUEUED]** Instead
  of growing the clock's window into a panel, Settings opens as a **separate window beside
  the pill**; the pill stays small over the wallpaper and the **REAL clock updates LIVE**
  as you change settings (so you can judge e.g. a cutout against your actual background).
  The settings window is **resizable**, and its position + size **persist** (like the
  clock's), opening at **~1262×975** by default (clamped to the screen work-area minus the
  dock). The browser / single-file build keeps the **in-page overlay panel**.
- **Pass I — font-tab polish. [QUEUED]** The Custom tile **remembers the last custom
  font** even after you pick a preset (new **`useCustomFont`** flag; `customFont` is no
  longer cleared when a curated tile is chosen). Opening the browser **pre-selects AND
  scrolls to** the active custom font (this was failing after an app restart). Curated
  card samples **scale to fit inside their cards** (some fonts were bleeding out), cards
  **grow responsively** with the panel, and there's **spacing between the tab bar and the
  cards.**
- **Pass J — Colors tab labels + cutout. [QUEUED]** Gray **"Background Opacity" / "Text
  Opacity"** labels above each slider; and a new **"cutout" mode** (a checkbox under the
  text-opacity slider) that **punches the numerals through the opaque pill** to the
  desktop/wallpaper (text color ignored). Exact name + how it interacts with the
  text-opacity slider are still being finalized with the host.

## 📝 Round 2 decisions & notes

- **The workflow is the house rule now.** Builder subagent → adversarial-verifier
  subagent, every change. It's not ceremony — it caught the proportional-font clipping
  (Pass A) and the cache false-fallback (Pass B) *before* they shipped. (Also logged in
  `DECISIONS.md`.)
- **Settings architecture is moving** from an in-window grown panel to a **separate,
  live-updating settings window** (Electron). The in-panel preview stays as a convenience,
  but the *real* pill is now the thing you watch update. The browser build keeps the
  overlay panel. (Logged in `DECISIONS.md`.)
- **Font model:** the active font is determined by **`customFont`** (the remembered
  family) **+ a `useCustomFont` flag**; availability is checked **at apply time**, with a
  fallback to the curated default if the saved family isn't installed here.
- **Dropped ideas:** bundling Google fonts (the system-font browser supersedes it); and
  the transparent color swatch (replaced by the opacity sliders + the cutout checkbox).
- **Considered, deferred — a Tauri port.** Binaries would drop from ~100MB to single-digit
  MB, which would sidestep GitHub's 100MB-per-file limit for committing binaries. We
  confirmed every capability we need is available in Tauri — OS transparency, tray,
  frameless, always-on-top, macOS menu-bar accessory — so it's *viable*. **Not pursued now**
  because it means rewriting the main process in Rust. Parked.
- **⚠️ Known issue — Electron e2e is "host-confirm."** The real-Electron Playwright suite is
  slow and the VM is memory-constrained; we get intermittent `afterEach` window-`close()`
  teardown timeouts. It's a **VM artifact** — the test *bodies* pass and the same tests pass
  under single-file — so Electron end-to-end stays a host-confirm step.
- **⚠️ Release artifacts are STALE.** The committed binaries + single-file predate Round 1,
  and must be **rebuilt** (binaries + single-file) after Round 2 lands.
