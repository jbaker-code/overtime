# CLAUDE.md — Overtime

Orientation for a future Claude/AI session. Read this once and you know what the app is,
where things live, how the team works, and what will bite you.

## What it is

**Overtime** is a tiny always-on-top desktop widget: a frameless, transparent, rounded
**pill** showing a **wall clock** (`HH:MM` + AM/PM, or 24h) and a **recording stopwatch**
(`HH:MM:SS`) with **Play / Pause / Reset**. It floats over a screencast so you (and viewers)
watch the "10-minute" episode run long. Electron app; also builds to a **single-file HTML**
that runs in any browser (no always-on-top/frameless there). Born on camera for the BakerCode
YouTube series, as *Episode Timer*, now its own app.

Author: **Claude (Anthropic)**. Direction: **Jason Baker <jason@bakercode.org>**. Channel
`https://www.youtube.com/@bakercode` is a **provisional, unconfirmed placeholder** — don't
present it as live.

## Repo map

```
source/
  electron/   main.js, preload.js, config.js, window-state.js, build/ (icons, tray PNG)
  app/
    renderer/ index.html, settings.html, styles.css, app.js, bridge.js,
              settings-apply.js, settings-panel.js, settings-window.js
    shared/   format.js, stopwatch.js, config-schema.js  (pure, UMD, no DOM/Node)
  scripts/    build-*.js  (+ lib/: paths, inline-html, electron-builder.config, stage, zip…)
docs/
  ARCHITECTURE.md   how it's wired (process model, IPC, schema, build)
  GUIDE.md          user + build + test guide
  dev/  PRD.md (historical spec + Current-state addendum) · TECHNICAL.md (the WHY behind
        every non-obvious choice — READ THIS before ripping anything out) ·
        DECISIONS.md · HISTORY.md (passes A–O) · HANDOFF.md · PLAN.md (historical)
tests/        Playwright: *.unit.spec.js, widget.browser.spec.js, widget.electron.spec.js, helpers/
tmp/          build output + releases (GITIGNORED — never commit)
```

Start with **docs/dev/TECHNICAL.md** for the ins-and-outs; **ARCHITECTURE.md** for the map.

## House workflow rule (standing)

**Every change = a builder subagent, then an adversarial-verifier subagent.** Implement with
one subagent; then have a *separate* subagent try to break it before the change is "done."
This isn't ceremony — it has caught real bugs that a single pass would have shipped
(proportional-font clipping, a font-cache false-fallback, the invalid-CSS cutout). Keep it.

## Hard constraints

- **NO `git`.** The human drives git through **SourceTree**. Don't commit, branch, push, or
  stage. (If asked to prepare a commit message, end it with the attribution lines the session
  provides.)
- **NO `rm`.** To delete, **`mv`** the target into
  `/Volumes/My Shared Files/claude/bakercode-youtube/tmp/safe-to-delete/`. Leave no scratch
  files in the repo.
- **Binaries live in a SEPARATE repo.** Built apps ship from **`overtime-releases`**
  (`github.com/jbaker-code/overtime-releases`) to dodge GitHub's 100 MB-per-file limit.
  **Never commit binaries here**; `tmp/` (build output + `tmp/releases/`) is gitignored.
- **Frozen identifiers — do not rename** (Episode-Timer origin, kept for backward-compat /
  to avoid churn): `window.episodeTimer` / `window.__episodeTimer`; `EPISODE_TIMER_*` env
  vars; localStorage key `episode-timer.config.v1`; the `EpisodeTimer*` UMD globals; test
  prefix `episode-timer-ud-`. Full table in TECHNICAL.md §0.
- **Don't break the capture guarantee:** never add `setContentProtection(true)` — OBS must be
  able to record the pill (a unit test greps for it).
- **Preserve the two validation disciplines** in `config-schema.js`: a full `normalizeSettings`
  coerces garbage to defaults; a `normalizeSettingsPatch` *drops* an invalid supplied value
  (never coerces). See TECHNICAL.md §4.

## Build & test

```bash
npm start                 # run the widget (electron .)
npm run build             # mac arm64+x64, win (cross-built), single-file, source zip
npm run build:mac|:win|:single|:source
npm run clean             # wipe scratch + every tmp/overtime-build-*

# tests (Playwright, serial, workers:1)
npx playwright test --project=unit --workers=1 --config tests/playwright.config.js   # VM-safe
npx playwright test --project=single-file --config tests/playwright.config.js
EPISODE_TIMER_SKIP_ELECTRON=1 npm test    # skip the real-Electron project
```

- **The VM is severely memory-starved** (siblings get OOM-killed). On the VM run **unit
  only**; single-file/electron risk OOM. Electron end-to-end is a **host-confirm** step, not
  a VM gate.
- **Real-Electron tests need a binary** the VM can't get from `node_modules` (the shared
  folder can't store the `.app`'s symlinks): extract one to **`~/et-electron`**, or point
  `EPISODE_TIMER_ELECTRON_PATH` at it.
- **Known VM flakes (NOT real failures):** `afterEach` `close()` teardown timeouts; the
  single-file `clock.pauseAt` fake-timer desync; page-setup timeouts under memory pressure.
  See TECHNICAL.md §11.
- Build scratch stays in the **OS temp dir** (symlink safety), not in `tmp/`.

## Current facts (verified against the schema + tests)

`SETTINGS_KEYS` = **16**. Catalogs: **10 layouts**, **9 curated fonts** (+ a system-font
browser for any installed family), **9 bg + 9 text** preset swatches (colors are now **any
`#rrggbb`** via a dependency-free picker; the 10th grid cell is the picker). Plus **Cutout**
mode (canvas `destination-out` knockout), two opacity sliders, and tray toggles for
show-clock / show-stopwatch.

## Pointers

PRD → `docs/dev/PRD.md` · TECHNICAL → `docs/dev/TECHNICAL.md` · ARCHITECTURE →
`docs/ARCHITECTURE.md` · DECISIONS → `docs/dev/DECISIONS.md` · HISTORY → `docs/dev/HISTORY.md`.
