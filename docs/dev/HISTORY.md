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

## ✅ Round 2 — polish + live-settings round (ALL DONE — builder-then-adversary each)

The big move this round: **Settings stopped growing the clock window and became its own
window** (Electron), so the real pill stays small over your wallpaper and updates live.
Seven passes (G–M) plus a full rebuild; every one built by a subagent and attacked by an
adversarial-verifier subagent before being called done.

- **Pass G — Electron hover-tint fix + control polish. [DONE ✅]** The 50%-black hover
  tint (Pass C) wasn't firing in the *real Electron app* because the frameless pill's
  `-webkit-app-region: drag` region **swallows DOM `mouseenter`/`mouseleave`**. Fixed by
  detecting hover in the **main process** — a `screen.getCursorScreenPoint()` poll that
  sends a `hover:changed` IPC (started/stopped with show/hide, test-gated). Also added a
  **two-tone inset outline** (`inset 0 0 0 1px rgba(255,255,255,.6)` over
  `inset 0 0 0 2px rgba(0,0,0,.5)`) so the pill edge reads on *any* wallpaper; shifted the
  browser controls off the stopwatch readout; and flipped the control gate positive
  (`[data-env="browser"]`).
  - 🐞 **Adversary catch (fixed):** with both a DOM driver and the cursor-poll driver live,
    a grip↔body `mouseleave` cleared the poll-set `data-hover` → stuck state. Fixed by
    **env-gating one driver per environment** (Electron = IPC only; browser = DOM only).
- **Pass H — Settings becomes its OWN window (Electron) + live clock. [DONE ✅]** Settings
  now opens as a **separate frameless window beside the pill** instead of growing the
  clock's window; the pill stays small over the wallpaper and the **REAL clock updates
  LIVE** as you edit (so you can judge e.g. a cutout against your actual background). The
  window is **resizable with a bottom-right grip**, and its position + size **persist**
  under a new `settingsWindow` bounds key (~1262×975 default, clamped to the work-area minus
  the dock). `settings:changed` now **broadcasts to both windows**; the old grow/shrink hack
  (`growForSettings` / `restoreFromSettings`) was removed. The browser / single-file build
  keeps the **in-page overlay panel** — the separate-window trick is Electron-only.
  - 🔎 Verifier probed a config write-race (settings window + tray editing at once) and
    proved it's **not a defect** — serial event loop, distinct keys, atomic whole-object write.
- **Pass I — font-tab polish. [DONE ✅]** The Custom tile **remembers the last custom font**
  even after you pick a preset (the `useCustomFont` flag; `customFont` is no longer cleared
  when a curated tile is chosen). Opening the browser **pre-selects AND scrolls to** the
  active custom font (`scrollSelectedIntoView` — which was failing after an app restart
  because the grid had no scroll box until the overlay was shown). Curated card samples
  **scale to fit inside their cards** (some fonts were bleeding out), cards **grow
  responsively** with the panel, and there's **spacing between the tab bar and the cards.**
- **Pass J — Colors tab labels + cutout. [DONE ✅]** Gray **"Background Opacity" / "Text
  Opacity"** labels above each slider; and the new **"Cutout"** checkbox under the
  text-opacity slider that **punches the numerals through the opaque pill** to the
  desktop/wallpaper (text color ignored; `textOpacity` doubles as the cutout strength).
  - ⚠️ **Design error caught + fixed:** the first attempt used CSS `mix-blend-mode:
    destination-out`, which **is not a valid CSS value** — Chromium silently dropped it, so
    no holes appeared. Rebuilt as a real **`<canvas>` `globalCompositeOperation =
    'destination-out'` knockout**: it measures the DOM text runs (`getBoundingClientRect` +
    computed font) and re-erases on a DPR-aware canvas, re-running on every
    render/resize/settle. Adversary re-proved genuine alpha-0 glyph holes at 0% leak outside
    the measured boxes across all 10 layouts.
- **Pass K — Colors palette recut + dependency-free color picker. [DONE ✅]** `bgColor` /
  `textColor` were relaxed from a swatch enum to **any valid `#rrggbb`** (shape-validated —
  garbage coerces to default on a full normalize, is dropped from a patch), and two new
  remembered-custom keys **`customBgColor` / `customTextColor`** were added → **`SETTINGS_KEYS`
  is now 16.** The palettes were recut to **9 background + 9 text** swatches (beige dropped;
  two near-whites → a gray; the secondary gold → orange; the 10th cell in each grid is the
  picker swatch). The picker itself is a hand-rolled, **zero-dependency** takeover — a **hue
  ring + saturation/value square + hex field** (HSV↔hex math; no RGB sliders, no eyedropper)
  that is **preview-only until Save** (an inline var on `#settings-preview`, never `:root` or
  storage) and **remembers** the last custom color on the picker swatch even while a preset is
  active (mirrors how `customFont` is remembered beside the curated `font`). Works in both the
  Electron settings window and the browser panel.
  - 🔎 **Adversary verified:** the 16-key schema agrees across all four key lists; the hex box
    can't inject a non-hex that then commits; the live preview never writes storage before
    Save; clicking a preset doesn't clobber the remembered custom. No defects.
- **Pass L — repo reorg. [DONE ✅]** Source moved under **`source/{electron,app,scripts}`**
  (main / preload / config / window-state in `electron/`, with `build/`; renderer + shared in
  `app/`; the build pipeline in `scripts/` + `lib/`). Docs moved to **`docs/`**
  (`ARCHITECTURE.md`, `assets/`, these `dev/` archives); the Playwright config into
  **`tests/`**; and the committed binaries out of `releases/` into **`tmp/releases/`**
  (gitignored — they ship from the separate `overtime-releases` repo to dodge GitHub's
  100 MB-per-file limit). Every live path was repointed (`package.json` main + scripts,
  electron-builder `files` / `buildResources`, `paths.js` ROOT depth, the Playwright config +
  the spec requires, README + ARCHITECTURE links). The historical planning docs keep their
  original paths as an archived record.
  - 🔎 **Adversary focused on the two things that fail *silently*** — `paths.js` ROOT depth
    and the electron-builder `files` glob — and confirmed both correct: nothing the app loads
    at runtime falls outside the globs, and the tray-PNG `⏱` fallback is real. No breakage.
- **Pass M — cleanup nits + docs. [DONE ✅]** Hardened `broadcastSettings` to skip a window
  whose `webContents` is already gone before `.send()`; fixed the `scrollSelectedIntoView`
  catch-fallback to use offsetParent-independent `getBoundingClientRect` centering (the old
  `offsetTop` math measured from the wrong element and never centered); and added
  **`app.setName('Overtime')` + `process.title = 'Overtime'`** so the *unpackaged* dev process
  reads "Overtime" in Activity Monitor (the packaged app already takes its name from
  electron-builder `productName`). Docs: this file + `DECISIONS.md` got Round-2 entries,
  `ARCHITECTURE.md`'s stale key-count was corrected to **16** (plus the 9/9 palette facts), and
  the reorg's now-broken `GUIDE.md` / dev-doc links were repointed. *Left intentionally:* the
  `app:quit` channel (still wired through preload + bridge — not dead) and the theoretical
  Pass-D first-paint flip (needs a host-side eyeball; the real startup flash was already fixed
  back in Pass D).
- **Rebuild. [DONE ✅]** A full `npm run build` on the VM produced all five artifacts — mac
  arm64 (~98 MB), mac x64 (~103 MB), Windows x64 (~116 MB), the source zip, and the single-file
  HTML (now ~199 KB, grown by the picker + cutout) — and they were staged into `tmp/releases/`,
  replacing the stale pre-Round-1 set. ⚠️ The Windows zip was **cross-built on macOS and not
  run** — smoke-test on real Windows before calling it good.

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
- **✅ Release artifacts rebuilt (end of Round 2).** All five artifacts were rebuilt after
  Round 2 landed and staged into `tmp/releases/` (mac arm64 + x64, Windows x64, source zip,
  single-file HTML), replacing the stale pre-Round-1 set. They ship from the separate
  `overtime-releases` repo. *(The Windows zip is cross-built on macOS and not yet
  smoke-tested on real Windows.)*
- **📷 Demo GIF — deferred to a host session.** `docs/assets/overtime-demo.gif` is a hand-made
  screen-recording of the running app; there's **no headless/automated path**, so it can't be
  regenerated on this VM. A refresh (gray outline, varied sizes, varied colors/fonts) is parked
  for a host session.

## ✅ Round 2 — what actually landed

All seven passes (G–M) shipped plus a full rebuild — each one builder-then-adversary. The
headline changes:

- **Settings is its own live Electron window.** The pill no longer grows into a panel —
  "Settings…" opens a **separate frameless window beside the pill** (its own bounds persist
  under `settingsWindow`, ~1262×975 default, clamped on-screen). Editing it updates the
  **real** pill live over your wallpaper. The browser / single-file build keeps the in-page
  overlay panel.
- **Colors tab — any color, not just the swatches.** `bgColor` / `textColor` were relaxed
  from a fixed swatch enum to **any valid `#rrggbb`**, and two remembered-custom keys
  (`customBgColor` / `customTextColor`) were added — so **`SETTINGS_KEYS` is now 16.** The
  preset palettes were recut to **9 background + 9 text** swatches (beige dropped; the last
  bg cell is the picker swatch; two near-whites dropped for a gray, and the old secondary
  gold became orange).
- **Dependency-free color picker.** A hand-rolled **hue wheel + saturation/value square +
  hex field** (no libraries) mixes an arbitrary color. It's **preview-only until Save**, and
  the last custom color is **remembered** on the picker swatch even while a preset is active
  (mirrors how `customFont` is remembered beside the curated `font`).
- **Cutout mode (Pass J) shipped.** A Colors-tab checkbox that **punches the numerals through
  the opaque pill to the desktop** — a `<canvas>` **`destination-out`** knockout (text color
  ignored; `textOpacity` doubles as the cutout strength).
- **Repo reorg.** Source moved under **`source/{electron,app,scripts}`** (main / preload /
  config / window-state in `electron/`; renderer + shared in `app/`; build pipeline in
  `scripts/` + `lib/`); docs under `docs/` (with these archives in `docs/dev/`); tests under
  `tests/`; build scratch + releases under `tmp/`. Live path references were repointed; the
  historical planning docs keep their original paths as an archived record.
- **Polish + rebuild.** `broadcastSettings` hardened against a window that closed mid-send; the
  font-browser scroll-to-selected fallback fixed; and the unpackaged dev process now names
  itself **"Overtime"** in Activity Monitor. Docs squared up (key-count → 16, dead links
  repointed, this Round-2 log). Then **all five release artifacts were rebuilt** and staged into
  `tmp/releases/`.

## ✅ Round 2.1 — settings-panel polish (Pass N, builder-then-adversary)

A small follow-on train after Round 2, same workflow (builder subagent → adversarial verifier),
plus a capstone **documenter pass** (PRD addendum, a new `TECHNICAL.md`, a root `CLAUDE.md`,
README/GUIDE corrections).

- **Visible resize grip on the settings window.** The grip *element* had existed since Pass H
  but was effectively **invisible**: the settings-panel background is always near-black, yet the
  settings window derives its `data-theme` from the user's **pill** color — so a light pill
  flipped `#settings-grip` to a `data-theme="light"` **black** hatch painted on the near-black
  panel (≈1:1 contrast → gone). Fixed by **removing the theme-flip override** (the grip is now
  always light stripes) and making the hatch **bolder** (alpha 0.55 → 0.8, 2px stripes, box
  26 → 30px); added a regression test so the flip can't return.
  - 🐞 **Adversary catch:** the builder's first answer was "already present, no change needed" —
    which missed the user's actual *"I can't see it"* intent. The real defect was **contrast**,
    not existence. Caught, root-caused, and fixed.
- **Preview border → opaque gray.** The `#settings-preview` outline was semi-transparent
  `rgba(128,128,128,0.5)`, so it read as see-through over the preview's checkerboard backing.
  Now a solid, fully opaque **`#808080`**.
- **Styled settings scrollbar.** When the settings window is small enough to scroll, the
  scrollbar now has a **black track + gray thumb**, scoped to `#settings-panel` descendants so it
  can never paint a black track on the transparent pill (proven by a selector-scope test).

## 📚 Documentation (Pass O)

- Added **`docs/dev/TECHNICAL.md`** — the "why" behind the non-obvious engineering (canvas
  cutout knockout, main-process hover poll, the live settings window, the config model, fit-to-
  fill, the system-font browser, build/test internals, a gotchas section, and the frozen
  identifiers) — so a future engineer/AI doesn't rip something out thinking it's needless.
- Added a root **`CLAUDE.md`** (house rules + repo map for future AI sessions), a dated
  **"Current state" addendum** to the frozen `PRD.md`, and corrected stale bits in `GUIDE.md`
  (removed `courier`, old swatch hexes, the grow-the-window line) and `README.md` (the real
  10 layouts / 9 fonts / 9+9 swatches + any-hex picker + Cutout).
