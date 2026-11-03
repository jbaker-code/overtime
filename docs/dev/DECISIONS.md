# Overtime — Decisions Log

> **Developer archive.** The decisions and open questions captured live while the app was
> being built autonomously on camera (then called *Episode Timer*). Historical — the
> shipped behaviour lives in [`../GUIDE.md`](../GUIDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

> A running log of calls I made while building autonomously, plus anything flagged for
> your later review. **Jason:** when you're back, skim the **⚑ For your review** section —
> everything else I just decided and moved on, per your "run it autonomously" call.

## ✅ Locked decisions (rationale in PRD.md)
- **Framework: Electron.** Frameless + always-on-top are both native; reuses our HTML/CSS
  workflow; Windows support is a bonus. (Native Swift was the alternative — not needed.)
- **No installers.** Mac = `.app` zipped + README. Windows = electron-builder `dir`
  (win-unpacked: `Overtime.exe` + runtime) zipped + README. The `dir` target
  cross-builds from this Mac box without wine. **Unsigned** (one-line Gatekeeper note only).
- **Single-file HTML** = browser version; no always-on-top/frameless (Electron-only) —
  it's the quick-look/embeddable build.
- **Build output:** scratch → OS temp (`<os-tmpdir>/overtime-build-scratch/`, out of the
  repo). Final `overtime/dist/{mac,windows,single-file,source}/` committed to git.
- **Config/persistence:** JSON in Electron `userData` — window bounds (pos + size, clamped
  to the visible screen), episode `elapsedMs` + state, and a forward-looking `settings`
  object (font/theme/opacity/show-seconds/12-24h/always-on-top) wired now, no settings UI
  in v1. Atomic writes, tolerant of a missing/corrupt file.
- **Tests:** headless Playwright acceptance suite via `npm test`.
- **Orchestration:** Fable plans → builder agents (app + build pipeline) → test-writer +
  docs-writer → adversarial reviewer vs. the PRD acceptance checklist. Models/parallelism
  tuned to the planner's recommendation.

## ⚑ For your review (when you're back — none of these block the build)
- **App name** — working name **"Overtime"** (folder `overtime`). Other ideas
  floated: *HowLong*, *ShotClock*, *StillRecording…*. Rename is trivial — pick one anytime.

**Decided autonomously from the planner's risk table (override any if you disagree):**
- **R1 — dist in git:** keeping your call to **commit `dist/` to git as-is** (you said so
  explicitly). Heads-up: it's ~200 MB per rebuild; if the repo gets heavy later, moving the
  Electron zips to **GitHub Releases** is a clean fix (build scripts wouldn't change).
- **R6 — sleep time:** stopwatch counts **real elapsed time while Running** (`Date.now()`,
  standard stopwatch behavior = "how long since I hit play," incl. any sleep). One-line swap
  to `performance.now()` if you'd rather it *not* count laptop-sleep.
- **R7 — build deps:** **pre-approved** — if your `npm run build` chokes on the Electron 34 /
  electron-builder 25 / Node 26 combo, bumping `electron-builder` to `^26` is OK (the one
  allowed `package.json` change).
- *(I'll append anything else that comes up here instead of blocking.)*

## 🔁 Post-extraction decisions (Overtime as its own repo)

*(Durable calls from the Round 1 / Round 2 feature work. The blow-by-blow lives in
`HISTORY.md`; only the decisions that outlive a single pass are kept here.)*

- **House workflow: builder + adversarial-verifier, every change.** Each change is
  implemented by a **builder** subagent and then independently attacked by an
  **adversarial-verifier** subagent before it's considered done. This is the standing
  workflow for this app — it caught real bugs (proportional-font clipping, a font-cache
  false-fallback) that a single pass would have shipped.
- **Settings becomes its own window (Electron).** Moving away from growing the clock's
  window into an in-panel editor toward a **separate, live-updating settings window** so
  the real pill stays small over the wallpaper and updates **live** while you tweak. The
  in-panel preview stays as a convenience; the browser/single-file build keeps the in-page
  overlay panel. Window is resizable and its position+size persist (like the clock's),
  default ~1262×975 clamped to the work-area.
- **Font model: `customFont` + `useCustomFont`.** The active font is determined by a
  remembered family (`customFont`) plus a `useCustomFont` flag — picking a curated preset
  no longer *clears* the remembered custom font. Availability is checked **at apply time**,
  with a fallback to the curated default when the saved family isn't installed on this
  machine. Installed fonts are enumerated via `queryLocalFonts()` (new `local-fonts`
  permission in main); the availability cache is **positive-only** (never authoritatively
  drops a rendering font).
- **Text rendering: alpha, not a fixed color.** Text now renders as
  `color: rgba(var(--text-rgb), var(--text-opacity))` so the Colors tab's **text-opacity**
  slider can fade the numerals (reaching 0). Paired with the existing background-opacity
  slider; both live under their respective swatch grids.
- **Dropped:** bundling Google fonts (the system-font browser supersedes it) and the
  transparent color swatch (replaced by the two opacity sliders + the forthcoming cutout
  checkbox).
- **Considered, deferred — Tauri port.** Would shrink binaries from ~100MB to single-digit
  MB (sidestepping GitHub's 100MB-per-file limit for committed binaries). All needed
  capabilities (OS transparency, tray, frameless, always-on-top, macOS menu-bar accessory)
  were confirmed available. **Not pursued now** — it means rewriting the main process in
  Rust. Parked, not rejected.
- **⚠️ Electron e2e = host-confirm.** The real-Electron Playwright suite is slow and the VM
  is memory-constrained, with intermittent `afterEach` `close()` teardown timeouts — a VM
  artifact (bodies pass; same tests pass under single-file). Electron end-to-end is a
  host-run confirmation step, not a VM gate.
- **Colors: the active color is any hex; the custom one is remembered.** `bgColor` /
  `textColor` hold the **active** color — a preset OR any `#rrggbb` mixed in the picker,
  validated by shape, not enum membership. New `customBgColor` / `customTextColor` keys
  **remember** the last picked hex so the picker swatch keeps showing it while a preset is
  active. This took **`SETTINGS_KEYS` to 16**; the quick-pick palettes were recut to **9 bg
  + 9 text** (beige removed). The picker is **dependency-free** (hand-rolled hue wheel + SV
  square + hex field) and **preview-only until Save**.
- **Cutout shipped** (was "forthcoming" above). The knockout checkbox landed: numerals are
  punched through the opaque pill to the desktop via a `<canvas>` **`destination-out`**
  composite — text color is ignored and `textOpacity` becomes the cutout strength.
- **Repo reorg to `source/{electron,app,scripts}`.** Code moved out of root/`src/` into
  `source/electron/` (main, preload, config, window-state), `source/app/{renderer,shared}`,
  and `source/scripts/` (+ `lib/`); docs to `docs/` (+ `docs/dev/`), tests to `tests/`, build
  scratch + releases to `tmp/`. The historical planning docs keep their original paths as an
  archived record; everything live was repointed to match.

## 🛠️ Build log / play-by-play
*(Ep 2 planning session — 2026-10-31. Appended as agents run.)*
- Fable **planner** ✅ delivered `PLAN.md` (~790 lines) + a recommended build train.
- **Phase 1 launched (parallel):** A·app-implementer (Opus), B·build-pipeline (Sonnet),
  C·test-writer (Sonnet). Then Phase 2: D·docs + E·adversarial-verifier. Then fix-up loops.
- B ✅ and C ✅ delivered; A (app) still running.
- **Mac ships TWO zips** (arm64 + x64) per host request — routed back to B.
- A ✅ (app) + D ✅ (docs) delivered; E (verifier) running.
- **Screenshots (single-file):** look is clean (dark rounded pill, big numerals, hover
  controls ▶⏸⏹↺). Two bugs found live: wall clock stuck at `--:--` and the stopwatch
  frozen — root cause = `formatClock` handed a non-Date → `date.getHours is not a
  function` throws every tick, killing the render loop. One fix clears both.
- **v2 feature (host):** a settings ⚙ icon by the controls opens a **TABBED panel** —
  3 tabs, ~10 click-to-select options each (visual swatches, NO typing):
    • **Layout** — ~10 arrangement presets (incl. current stacked + clock-left / timer-right
      with a · dot separator + ~8 more)
    • **Font** — ~10 fonts shown as live swatches, click to apply (not a named dropdown)
    • **Colors** — a **Background** swatch set (~10) + a **Text color** swatch set (~10)
  Options compose freely (any layout × font × bg × text), apply live, persist. Settings
  keys: `layout`, `font`, `bgColor`, `textColor` (+ existing opacity/showSeconds/hour12/
  alwaysOnTop).
- E (verifier) ✅: **1 real bug** (the clock crash, confirmed) + 4 small inter-agent
  contract nits (future-schemaVersion reset, stopwatch hard-reset on garbage, two static
  tests tripping on their own comments, an inliner test-signature mismatch). Everything
  structural verified SOLID: no installer/signing, atomic config, corrupt-file quarantine,
  off-screen clamp, timing math, source-zip, clean-guard. `npm test` red only due to those.
- **v2 launched:** app agent (A) = the 4 fixes + the tabbed settings panel. Then C (tests)
  + D (docs) realign to the new schema/DOM, then E re-verifies.
- v2 build-out ✅: A (fixes + panel), C (tests realigned — `theme` dropped, panel tests
  added), D (docs updated). Screenshots confirm the clock ticks + panel works (10 layouts /
  10 fonts / 10 bg / 10 text colors). **E re-verifying the suite now.**
- PRD reconciled to v2 (settings panel + no `theme`). `PLAN.md` is the original planning
  snapshot — superseded in parts; DECISIONS.md + PRD.md are the current source of truth.
- E re-verify ✅: 34 failures → 3 trivial (unit 84/1, single-file 53/2). Critical crash
  GONE, panel 14/14, no regressions, no installer/signing creep. **Functionally
  ship-ready.** Final tiny loop: A restores a `DELIBERATELY ABSENT` comment marker; C
  aligns 2 by-design ≤1s tick-timing assertions → full green. Then host runs the Electron
  smoke (host-only checks: window flags, always-on-top, on-disk config, resize/quit).
- Plan: fold the clock bugfix + the settings-panel feature + E's findings into ONE
  app-agent revision, then update tests + docs to match, then re-verify.
- **Final verify ✅ FULLY GREEN:** unit 85/85, single-file 55/55, zero failures. Clock tool
  is **SHIP-READY.** Build train complete (A, B, C, D, E all landed). Remaining = the host's
  in-person Electron smoke (the host-only Playwright project) + the runbook. 🎉
