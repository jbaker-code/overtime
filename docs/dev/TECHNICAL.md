# Overtime — Technical Design & Rationale

> **Read this before you delete something that looks pointless.** This document exists
> for the engineer (or AI) who opens Overtime cold two years from now, sees a canvas where
> they expected CSS, a cursor poll where they expected `mouseenter`, or a tray PNG that
> ships *out* of the bundle — and is about to "simplify" it. Almost every odd-looking choice
> here is load-bearing and was paid for with a real bug. Each section says **what** the
> mechanism is, **why** the obvious approach does *not* work, and **where** the code lives.
>
> Scope: the non-obvious engineering. For the plain "how it's wired" tour see
> [`../ARCHITECTURE.md`](../ARCHITECTURE.md); for user-facing behavior see
> [`../GUIDE.md`](../GUIDE.md). Everything below was verified against the source as it
> stands (post Round 1 + Round 2 + Pass N). Where a claim cites a function, that function
> was read.

---

## 0. The naming leftover (frozen identifiers) — read this first

The app was born as **"Episode Timer"** under `tools/clock/` in the BakerCode YouTube repo
before graduating into its own **Overtime** repo. A handful of identifiers still carry the
old name. **They are frozen on purpose** — renaming them buys nothing and risks breaking a
persisted config, a running test, or the bridge contract. Do not "tidy" them:

| Frozen identifier | Where | Why it's frozen |
|---|---|---|
| `window.episodeTimer` / `window.__episodeTimer` | `preload.js` (the contextBridge object) / `app.js` (`installDebugHook`) | The renderer↔preload contract and the test/debug hook. Renaming changes the IPC surface every test and the bridge key off. |
| `EPISODE_TIMER_*` env vars (`_USER_DATA`, `_TEST`, `_ELECTRON_PATH`, `_SKIP_ELECTRON`, `_SCRATCH`, `_BUILD_SLUG`) | `main.js`, `config.js`, `paths.js`, `tests/helpers/*` | The dev/test/build knobs. Scripts, CI and the host's muscle memory all pass these. |
| `localStorage['episode-timer.config.v1']` | `bridge.js` (`LS_KEY`) | Browser-mode persistence key. Renaming silently wipes every single-file user's saved config. |
| `EpisodeTimer*` UMD globals (`EpisodeTimerFormat`, `EpisodeTimerStopwatch`, `EpisodeTimerConfigSchema`, `EpisodeTimerBridge`, `EpisodeTimerSettings`, `EpisodeTimerSettingsPanel`) | the `source/app/**` modules' UMD wrappers + every `index.html`/`settings.html` consumer | The classic-`<script>` global names the whole renderer loads by. The single-file inliner concatenates these in order; renaming means touching every file at once. |
| test userData prefix `episode-timer-ud-` | `tests/helpers/launch-electron.js` (`makeUserData`) | Just a temp-dir prefix; harmless, kept for churn-avoidance. |

The product, the config folder (`Overtime/`), the window titles and everything a user sees
are **Overtime**. These are internal leftovers, documented so nobody "fixes" them.

---

## 1. The Cutout canvas knockout — *"why is this on a `<canvas>`?!"*

**The flagship gotcha.** Cutout mode turns the numerals into transparent **holes punched
through the opaque pill** so the desktop/wallpaper shows through the glyph shapes. It is
implemented on a `<canvas>`, not in CSS, and that is not an accident.

**Why the obvious CSS does NOT work.** The intuitive move is `mix-blend-mode:
destination-out` on the text layer. **`destination-out` is not a valid `mix-blend-mode`
value** — it's a Porter-Duff *compositing* operator, not a *blend* mode. Chromium silently
drops the invalid value (no error, no warning): the declaration is simply ignored and **no
holes appear**. There is no CSS property that erases a parent's alpha to transparency the
way a knockout needs. (This was the first implementation; the adversary caught it in Pass J.)

**What actually ships** (`settings-apply.js` → `paintCutout`):

1. A `<canvas>` is inserted as the pill's **first child** so it paints at the background
   layer (`directCutoutCanvas` — it finds the pill's *own direct-child* canvas, never a
   nested preview's, which matters in the browser build where the preview pill is nested
   inside `#app`).
2. The canvas is sized **DPR-aware**: backing store = `clientWidth/Height × devicePixelRatio`,
   then `ctx.setTransform(dpr, …)` so drawing happens in CSS px but rasterizes crisp on
   Retina.
3. **Fill** the whole canvas with `rgba(bgColor, opacity)` using `globalCompositeOperation =
   'source-over'` — this is the visible pill surface (the DOM `#face` is set
   `visibility:hidden` but kept in layout, and the `#app` background is made transparent via
   CSS keyed on `[data-cutout]`, so the canvas is the only pill you see).
4. **Erase** the glyphs: switch to `globalCompositeOperation = 'destination-out'`,
   `globalAlpha = textOpacity` (the cutout **strength** — 1 = crisp full punch, lower =
   fainter partial hole), `fillStyle = '#fff'` (destination-out uses only the *source
   alpha*, so the color is irrelevant), and `fillText` each run. Over the transparent
   Electron window those erased pixels become real alpha-0 holes.

**Why it measures the live DOM instead of re-deriving geometry.** There are **10 layouts**,
plus per-font metrics, plus the fit-to-fill scaling — re-implementing all that on the canvas
would be a second source of truth guaranteed to drift. Instead `collectRuns(faceEl, scale)`
walks the real `#face`, and for every leaf element that directly holds text (clock time,
meridiem, stopwatch) **and** every `::before` pseudo-glyph (the layout separator `·`/`–`,
which is CSS `content`, not DOM text) it captures the post-transform
`getBoundingClientRect()` and builds a canvas font string from the *computed* style
(`fontStyle/fontWeight/fontSize × scale + fontFamily`). The holes therefore auto-track
whatever the layout/font/scale produced.

**The transform-scale subtlety** (`faceTransformScale`): while the face is mid-resize it
carries a `transform: scale()` (see §6). `getBoundingClientRect` is already post-transform
(positions correct) but *computed font-size is the un-scaled base*, so drawn glyph sizes are
multiplied by the live scale read out of the CSS `matrix(...)`. At rest (and in the preview,
which bakes a font-size rather than transforming) the scale is 1.

**Redraw triggers** — `paintCutout` is cheap and idempotent (a no-op that just hides the
canvas when cutout is off), so it is called from every place the picture could change, via
`app.js → redrawCutout()`:

- **render()** — every tick (new time/stopwatch digits).
- **settleNow()** — the face just re-baked at a new crisp size/layout.
- **onContainerResize()** — track the live-resizing pill so holes don't lag the size.
- **applyAndRemember()** — any settings change (cutout toggled, bg/opacity/font/layout).

The settings-window preview drives its own copy from `settings-window.js → renderPreview()`
(there the holes reveal the panel backdrop; true wallpaper see-through is the pill's job).

> **Do not** try to replace this with CSS, SVG masks, or `background-clip: text`. None of
> them erase a parent's alpha across a transparent OS window. The canvas is the only way.

---

## 2. Main-process hover detection — *"why isn't hover just `mouseenter`?"*

The pill shows a 50%-black grab tint (and reveals the resize grip) on hover. In Electron
that hover state is driven **from the main process by polling the OS cursor**, not from DOM
events. Here's why that looks wrong but is right.

**Why DOM `mouseenter`/`mouseleave` can't drive it.** The *entire* pill is
`-webkit-app-region: drag` so the user can grab it anywhere to move the frameless window. In
a frameless window **that native drag region swallows the mouse events** the renderer's
`documentElement` listeners rely on — against a *real OS cursor* they never fire,
`data-hover` never flips, and the tint + grip never appear. (It looked fine under Playwright
because synthetic hover is injected *below* the OS drag region — a trap: the DOM path passes
tests and fails in the real app. The host hit exactly this: no visible pill to grab.)

**What ships** (`main.js`): main *can* see the cursor via `screen.getCursorScreenPoint()`,
so `pollHoverOnce` (every `HOVER_POLL_MS = 120`) compares it against `win.getBounds()`
(`cursorIsOverWindow` — both in screen space, no DPI math) and **sends `hover:changed` only
on a change**, so the renderer gets one message per enter and one per leave, never a stream.
The poll is scoped to while the window is visible (`startHoverPolling` on
`ready-to-show`/`show`/`restore`; `stopHoverPolling` on `hide`/`minimize`/**`close`**). It's
`unref()`'d so it never keeps the app alive, and the `send` is wrapped in try/catch because
during teardown the `webContents` can be destroyed while `win.isDestroyed()` still reports
false. `preload.js → onHoverChanged` relays it; `app.js → setHover` maps it to `data-hover`.

**Why the browser build uses the DOM path instead.** A plain browser tab has *no* drag
region, so `mouseenter`/`mouseleave` on `documentElement` fire normally — the browser
bridge's `onHoverChanged` is a no-op.

**Why exactly ONE driver per environment** (`app.js → wireHover`, see its long comment).
Wiring both in Electron is tempting but broken: the DOM path is *not* fully dead there —
`no-drag` children (the resize grip) **do** receive real pointer events, so moving the cursor
grip↔pill-body fires a spurious `documentElement` `mouseleave` that would clear the
poll-set hover mid-hover. Because the poll only re-sends on *change*, it wouldn't re-assert
until the cursor fully exits and re-enters — **tint + grip stuck hidden**. (This was the
Pass G adversary catch.) Gating to a single source per env removes the race entirely:
**Electron = IPC poll only; browser = DOM only.** Don't "add a DOM fallback" in Electron.

---

## 3. The separate live settings window — *"why a whole second window?"*

In Electron, Settings is its **own `BrowserWindow`** beside the pill (`settings.html` +
`settings-window.js`), not an overlay grown into the pill. This replaced an earlier "grow
the pill's window to fit an in-page panel" hack (the removed `growForSettings` /
`restoreFromSettings` / `window:settings-open`).

**Why a second window.** The whole point of the editor is to judge a look — a cutout, an
opacity, a color — **against your actual wallpaper**. If the pill grew into an editor, the
real pill would vanish behind the panel while you edit it. Keeping them separate means the
tiny always-on-top pill stays put over the desktop and **updates live** as you tweak the
editor beside it.

**The live-update wiring** (`main.js`):

- `createSettingsWindow()` is a second frameless/transparent window loading `settings.html`,
  which reuses the *same* panel (`settings-panel.js`), applier (`settings-apply.js`) and
  shared modules. `openSettingsWindow()` focuses it if already up (never duplicates).
- Any edit → `config:set-settings` → `applySettingsPatch()` → **`broadcastSettings(merged)`
  sends `settings:changed` to BOTH windows** (guarding each `webContents` isn't already
  gone — the Pass M hardening). The pill re-applies to the *real* clock; the settings window
  re-applies to its preview + tab highlights. The same broadcast is why a tray toggle
  ("Show clock", "Float on top") also updates an open settings window.
- **Sender resolution:** the resize grip sends `window:resize-by`; main does
  `BrowserWindow.fromWebContents(event.sender)` so the **same channel resizes whichever
  window sent it**, each clamped to its *own* minimums (pill `MIN_WIDTH/HEIGHT` vs
  `SETTINGS_MIN_WIDTH/HEIGHT`). `setSize` is given rounded, finite-guarded integers (see
  §8, the resize crash).
- The settings window persists its own bounds under the `settingsWindow` config key
  (`trackBounds(settingsWin, config, { key: 'settingsWindow' })`), opens at a default
  ~1262×975 run through `clampBounds` to fit the work area, positioned beside the pill the
  first time (`computeSettingsBounds`). Closing it leaves the pill running.

The **browser/single-file build is unaffected**: no second window, so it keeps the in-page
`#settings-panel` overlay. The split is purely on `bridge.env` (renderer) /
`BrowserWindow.fromWebContents` (main). `app.js → boot()` skips `setupPanel()` in Electron,
so the pill builds no panel and `openSettings()` defers to main.

---

## 4. The config model — one schema, two write disciplines, no race

Everything about the config's shape, defaults and validation lives in **one shared file**,
`source/app/shared/config-schema.js`, UMD-wrapped so main, the renderer's browser fallback,
and the unit tests all agree byte-for-byte. The golden rule: **`normalizeConfig(anything)`
always returns a complete, valid config** — missing file, half-written file, hand-edited
garbage, an array, a string, `null` all collapse to defaults; it never throws.

**`SETTINGS_KEYS` is 16** (verified against the schema *and* `config-schema.unit.spec.js`,
which pins the count). In order:

```
layout, font, customFont, useCustomFont,
bgColor, textColor, customBgColor, customTextColor,
opacity, textOpacity, cutout,
showSeconds, hour12, alwaysOnTop, showClock, showStopwatch
```

(Option catalogs, also verified & test-pinned: **`LAYOUTS` = 10**, **`FONTS` = 9** curated
keywords, **`BG_COLORS` = 9** preset swatches, **`TEXT_COLORS` = 9** preset swatches. See
§10 of ARCHITECTURE for how to add one.)

**Two validation disciplines — this distinction is deliberate and must be preserved:**

- **`normalizeSettings(raw)`** (used by a *full* normalize, e.g. loading the file) coerces
  *every* field to a valid value: a bad enum → the default, garbage opacity → the default,
  non-hex color → the default. The result is always complete.
- **`patchValueValid(key, value)` / `normalizeSettingsPatch(raw)`** (used by
  `config:set-settings`) is stricter: only *supplied* keys whose value is *actually valid*
  survive; an invalid value is **dropped, not coerced to the default**. Why: a partial patch
  comes from a live UI control, and silently snapping a garbage value back to the default
  would let a misbehaving caller reset a setting the user never touched. Example: a patch
  `{ bgColor: '#zzz' }` yields `{}` (dropped), whereas a full normalize of `{ bgColor:
  '#zzz' }` yields `bgColor: '#000000'` (the default).

**The any-hex relaxation + remembered-custom pattern** (Pass K). `bgColor`/`textColor` are
no longer enum-limited — they hold the **active** color, which is **any valid `#rrggbb`** (a
preset *or* a hex mixed in the picker), validated by shape (`isHexColor`), not membership.
`BG_COLORS`/`TEXT_COLORS` are now just the quick-pick preset palette, not an allow-list.
Alongside them, **`customBgColor`/`customTextColor` remember the last picker color** (a valid
hex or `''` = none) so the Colors-tab picker swatch keeps showing "what you'd switch back to"
even while a preset is active. This mirrors the font model's `customFont` + `useCustomFont`
(§7): active value in one field, remembered value in another, so picking a preset never
*forgets* the custom.

**Why there is no write-race despite two windows editing** (the Pass H verifier probe).
Both the settings window and the tray can change settings "at the same time", but **neither
touches the file** — they both send IPC to the *single* main process, which holds **one
in-memory `data` object** (`config.js`). Main's event loop is **serial**, so two
`config:set-settings` handlers never interleave; each does `Object.assign({}, current,
patch)` and writes the **whole object**. The disk write is **atomic**: `writeFileSync(.tmp)`
→ `renameSync` over the real file (atomic on one filesystem), debounced ~500 ms, with a
`flushSync()` on `before-quit`. So a reader never sees a half-written file, a crash
mid-write leaves the previous good file intact, and worst-case loss on a hard kill is ≤1 s
(the per-second timer push while running). Distinct bounds keys (`window` vs
`settingsWindow`) plus the whole-object atomic write mean there is nothing to race.

**Corrupt-file quarantine** (`config.js → load`): `ENOENT` → defaults; invalid JSON or a
valid-JSON-but-wrong-type file (array/string/null) → defaults **and** the bad file is renamed
to `config.json.corrupt-<timestamp>` so nothing is silently destroyed. `migrate()` discards
a file stamped with an unknown/newer `schemaVersion` (can't interpret the future safely);
an *unversioned* file is treated as current and just gets missing fields filled.

---

## 5. Window-state persistence & the off-screen clamp

`source/electron/window-state.js` owns "comes back exactly where it was, but never opens into
the void."

- **`trackBounds(win, config, { key })`** writes `{x, y, width, height}` back to the config
  key on debounced `moved`/`resized` (and on `close`). The pill uses key `window`; the
  settings window uses `settingsWindow`. (A known minor gap, logged in HISTORY: a bounds
  change made *only* at close time races `before-quit → flushSync` which runs first — but a
  real drag fires `moved`/`resized`, so normal use persists fine.)
- **`restoreBounds(config, defaults, opts)`**: size is *always* restored (clamped up to the
  per-window minimums). Position is kept **only if the saved rectangle still overlaps a
  *connected* display's work area by ≥ 50%** (`getDisplayMatching` + `intersectionArea`);
  otherwise it `slideInside`s fully onto that display, and if nothing matches, x/y are
  dropped so the OS centers it. Monitors come and go — a saved spot on a now-unplugged
  external screen would otherwise open the widget off-screen.
- **`clampBounds(rect)`** shrinks a rectangle to the work area if it's bigger than the screen
  and slides it inside. The settings window runs its computed default (~1262×975) through
  this so a large editor never lands partly off-screen on a small laptop display.

Minimums (mirrored into `BrowserWindow.minWidth/minHeight` and the grip clamp): pill
`MIN_WIDTH=100` / `MIN_HEIGHT=20` (the height floor was dropped from 60 → 20 so the pill can
be a thin one-line strip; macOS enforces its own small floor underneath). Settings window
`SETTINGS_MIN_WIDTH=420` / `SETTINGS_MIN_HEIGHT=360`.

---

## 6. Fit-to-fill font scaling — hybrid transform/bake + the tabular probe

The window resizes **freely** (no aspect lock), so the two readouts must **scale to fill**
whatever shape the pill has. Two mechanisms, both in `app.js`, both load-bearing:

**Hybrid transform-while-dragging, then bake-real-font-size-at-rest.** During an active
resize, `onContainerResize` → `applyLive(scale)` applies `transform: scale()` — a pure GPU
composite, no reflow — so dragging tracks instantly instead of the "dead frames then snap"
you'd get waiting on batched ResizeObserver/layout work. ~120 ms after the last size change
(`scheduleSettle` → `settleNow`), it **bakes** the scale into a real `font-size` and drops
the transform to `none`. Why bake: a transform just stretches a bitmap rasterized once at the
base size (soft/jaggy when small); a real font-size **re-rasterizes** the glyphs crisp at
their true pixel size. `measureFace()` always measures the natural box at a fixed `BASE_FONT
= 100px` so the scale math is font-independent and there's no feedback loop with the
ResizeObserver.

**The tabular-font probe keeps the per-second tick reflow-free** (`probeTabular`). The CSS
*requests* tabular figures, but that's only a request — several bundled fonts (Georgia/serif
most dramatically, also helvetica/condensed/palatino/times) **ignore it**, so same-length
times like `11:11:11` and `20:48:40` render at different widths. If the code assumed tabular
there, a tick that keeps the digit *length* but changes the *width* would never re-fit and
the face would overflow (clipped by `#app`'s `overflow:hidden` — the Pass A adversary caught
~28% clipping on proportional fonts). So on every settings change it *measures* a narrow vs a
wide same-length digit string at `BASE_FONT` on an off-screen probe node (appended to `#app`,
which carries no transform, so `getBoundingClientRect` is unscaled and sub-pixel). Equal
within ~0.5px → truly tabular (use the cheap "signature on digit *lengths*" path so the
once-a-second digit churn is a no-op); otherwise proportional (signature on the full digit
*strings* so every width-changing tick re-fits — one `offsetWidth` reflow at 1 Hz, fine). The
`__episodeTimer.fit()` debug hook exposes `measureCount` so a test can prove a plain tick
forces no reflow.

The settings preview is a **fixed-size box** with its *own* independent
measure-and-fill (`fitPreview`), decoupled from the pill's live transform.

---

## 7. System-font browser — `queryLocalFonts`, positive-only cache, apply-time fallback

The Font tab's "Custom" tile opens a browser of the fonts **actually installed on this
machine**, enumerated via **`queryLocalFonts()`** (`settings-panel.js → openFontBrowser`).
That API needs the **`local-fonts`** permission, granted in `main.js →
installLocalFontsPermission`, which grants *only* `local-fonts` and denies everything else
(a frameless clock needs no camera/mic/geolocation). The grant is installed on **both**
sessions — the pill and the settings window — because the browser lives in the settings
window now.

**The font model is two fields, not one** (Pass B/I, and see `config-schema.js`): `customFont`
**remembers** an arbitrary installed family name; `useCustomFont` is the independent on/off
switch. They're deliberately *not* folded into the curated `font` enum — `font` coerces any
unknown value back to the default, so an arbitrary family could never survive there. The
**active** font (`settings-apply.js → activeFontInfo`) is the custom one *only* when
`useCustomFont` is on **AND** `customFont` is set **AND** it's actually installed (curated
stack appended as a last-ditch fallback); otherwise the curated `fontFamilyFor(font)`. So
picking a curated preset flips `useCustomFont` off but **leaves `customFont` remembered**, and
a saved custom family that isn't installed on *this* machine falls back to the curated face
at apply time — **never a blank/missing glyph** (the host's hard rule).

**The positive-only availability cache + the bug that motivated it** (`fontAvailable` /
`setKnownFamilies`). Checking "is this family installed?" from the renderer is subtle:
`document.fonts.check()` reports `true` for *any* locally-installed (non-`@font-face`) name,
so it can't tell installed from bogus — it's used only as a cheap gate (a pending web face
reads false). The real answer is by **measurement**: render a probe string in `"family",
<generic>` vs the generic alone; if the metrics differ for at least one generic, it's
installed. When the user opens the font browser, the `queryLocalFonts()` result is cached as
a `Set` of installed families so later checks are O(1). **Critically the cache is
positive-only:** a *hit* means "definitely installed" (authoritative), but a *miss* must
**never** by itself declare a font unavailable — it falls through to the measurement path.
Why: `queryLocalFonts()` enumerability ≠ renderability, and the returned list can be partial
(the user shared only a subset) or empty. The Pass B adversary caught the bug where an
"authoritative" cache would *falsely drop an installed, actually-rendering font* (e.g.
Georgia) for the rest of the session the moment the browser was opened once. Positive-only
fixes it. Don't make the cache authoritative-on-miss.

(Selection in the browser is **deferred**: clicking a card live-updates only the preview;
**Back** reverts, **Save** commits via `onSelect('customFont', …)` + `onSelect('useCustomFont',
true)`. The same deferred-preview, commit-on-Save pattern drives the dependency-free color
picker — hue ring + SV square + hex, no libraries, no OS dialog — in the Colors tab.)

---

## 8. Gotchas & sharp edges

**The grip theme-flip bug (fixed in Pass N) — a documented cautionary example.**
`styles.css` has `#app[data-theme="light"] #grip { … }` that flips the *pill's* grip stripes
from light to dark, because the pill background follows the theme. The **settings window's**
grip (`#settings-grip`) deliberately has **no** `data-theme="light"` variant — and there's a
big comment forbidding one. Here's the trap: the settings panel background is
**theme-independent**, always near-black (`#settings-panel: rgba(18,18,22,.98)`), but the
settings *window* still derives `data-theme` from the user's **pill** color
(`settings-apply.js → luminance(bgColor) > 140 ? 'light' : 'dark'`). So if you "helpfully"
add a light-theme grip variant to match the pill's, then whenever the user picks a *light
pill color*, the settings-window grip flips to black-on-near-black and **vanishes** — it
looks like there's no grip at all. The fix is to keep `#settings-grip` always-light stripes,
fairly opaque and thick. Lesson that generalizes: **`data-theme` is derived from the pill
color and leaks onto the settings window even though that window's chrome is not themed.**
Anything you style under `data-theme` in the settings window must account for a theme that
has nothing to do with the panel it's painting.

**`data-theme` is derived, not a setting.** There is no `theme` key (it was dropped;
`config-schema.unit.spec.js` asserts it's gone). `data-theme` exists *only* to keep the hover
control buttons readable against whatever background was picked. Don't re-add a theme
setting.

**The `setSize` integer crash.** `window:resize-by` rounds `w`/`h` and finite-guards them
before `target.setSize(w, h, false)`. Electron's native `setSize` binding throws
"conversion failure" on a fractional or `Infinity`/`NaN` value, and grip deltas aren't whole
pixels. A permanent resize-stress test in the electron project covers fractional/NaN/Infinity
deltas. Don't remove the rounding or the guard.

**Content protection is DELIBERATELY ABSENT.** `main.js` never calls
`win.setContentProtection(true)` — OBS and any recorder *must* be able to capture the widget;
that's the entire point. A static unit test (`static.unit.spec.js`) greps the file to make
sure it never creeps back in. There's a marked comment in `createWindow`.

**Backward clock jumps clamp to 0.** The stopwatch computes elapsed from an anchor
(`accumulatedMs + max(0, now - runningSince)`), never `+= 1000` per tick, so a late/throttled
tick costs display latency, never drift. An NTP step or manual clock change backward clamps
that stretch to 0 (better to under-count a second than show a negative).

**DevTools makes the transparent window opaque.** `npm start -- --devtools` opens detached
DevTools and the window goes opaque while it's open — a documented Electron limitation for
transparent windows, not a CSS bug.

**The tray PNG ships *out* of the bundle on purpose** — see §9.

---

## 9. Activity Monitor / process naming

- **Packaged app:** the process name comes from electron-builder's `productName: 'Overtime'`
  (`electron-builder.config.js`), so Activity Monitor / Task Manager show "Overtime" with no
  help from the code.
- **Raw unpackaged dev run (`npm start`):** Electron would otherwise show the generic
  "Electron". `main.js` calls `app.setName('Overtime')` and `process.title = 'Overtime'` (in
  a try/catch — cosmetic only) **before app `ready`** so `ps`/Activity Monitor/the dev
  menu-bar entry read "Overtime". This only affects dev runs; it's harmless and was added in
  Pass M.

**The tray icon and its `⏱` fallback** (verified against both `main.js` and the build config
— this is a genuine deliberate choice, not an oversight). `createTray` loads a monochrome
`*Template` PNG from `source/electron/build/trayTemplate.png` (+`@2x`), which macOS
auto-inverts for light/dark menu bars. **But that folder is NOT packaged into the app.** The
electron-builder `files` globs (`electron-builder.config.js`) are explicit:

```
source/electron/main.js, preload.js, config.js, window-state.js,
source/app/**/*,
package.json
```

`source/electron/build/**` is **not** in that list, so the tray PNG is **not** in the asar at
runtime. (`buildResources: 'source/electron/build'` is a *different* knob — it's where
electron-builder looks for the app-bundle *icon* and installer resources, not files copied
into the app's runtime `files`.) So in the packaged app `fs.existsSync(path.join(__dirname,
'build', 'trayTemplate.png'))` is **false**, `trayImage()` returns an empty image, and macOS
shows the **`⏱` text title** fallback instead (`tray.setTitle('⏱')`). A tray failure is also
swallowed so it can never take the app down. If you ever *want* the PNG in the tray, you must
add `source/electron/build/**` (or the specific PNGs) to the `files` globs — it is excluded
today on purpose to keep the bundle lean, and the `⏱` fallback is the intended result.
(Pass L's adversary specifically confirmed this fallback is real.)

---

## 10. Build pipeline

Plain Node, no runtime deps, electron-builder's **programmatic API**
(`source/scripts/` + `lib/`). Full tour in ARCHITECTURE §"Build pipeline"; the non-obvious bits:

- **`files` / `buildResources` globs** — see §9. The exclusion of
  `source/electron/build/**` from `files` (→ the `⏱` tray fallback) is the one that fails
  *silently* if misunderstood; Pass L's adversary focused on exactly it and `paths.js` ROOT
  depth.
- **`paths.js` is the single source of paths + the delete guard.** `ROOT` is
  `source/scripts/lib → ../../..`. Each run gets a dated+random `SLUG`
  (`YYYYMMDD-HHMMSS-xxxxx`); `build-all` makes one and shares it with children via
  `EPISODE_TIMER_BUILD_SLUG`. Artifacts land in `ROOT/tmp/overtime-build-<slug>/dist/`
  (`tmp/` is **gitignored**; old builds accumulate until `clean`). `safeRemove` refuses to
  delete anything outside `SCRATCH` or a `tmp/overtime-build-*` folder.
- **Scratch stays on local disk** (`SCRATCH = <os-tmpdir>/overtime-build-scratch`, override
  `EPISODE_TIMER_SCRATCH`, enforced to stay inside the OS temp dir). Why: electron-builder's
  unpacked `.app` is full of **symlinks** a network/shared volume (the VM's shared folder)
  can't store; only the finished symlink-free zips are copied into `dist/`. `zip.js` uses
  `ditto` on macOS (preserves `.app` symlinks/exec bits), `tar` elsewhere.
- **The single-file inliner** (`lib/inline-html.js`) is a pure, unit-tested function that
  swaps each relative `<link>`/`<script>` for its contents in document order, escapes
  `</script`/`<!--`, and **throws on any absolute/`http(s)`/`//`/`data:` reference** — so the
  single-file build stays fully offline/self-contained. The renderer's contract (see the
  comment block in `index.html`): relative classic scripts only, no `type="module"`, no
  `defer`/`async`, in the fixed dependency order format → stopwatch → config-schema → bridge
  → settings-apply → settings-panel → app.
- **mac** builds **both** arm64 and x64 every time (`--x64` is now a no-op). **win**
  cross-builds the `win-unpacked` folder on macOS with `signAndEditExecutable: false` so it
  never reaches for `rcedit`/Wine — **the Windows zip is cross-built on macOS and never run
  here; smoke-test it on real Windows before trusting it.** **source** is a file-walk (not
  `git archive`, so uncommitted files are included). No installers, no signing, no
  notarization — adding a `dmg`/`pkg`/`nsis` target is the moment all of that re-enters, so
  it stays out.

---

## 11. Testing — three projects, the knobs, and the KNOWN VM flakes

`npm test` = Playwright, three projects (`tests/playwright.config.js`, all serial,
`workers: 1`):

- **unit** — pure Node. `require()`s the shared modules + the inliner directly: the stopwatch
  transition table, the config schema tolerance (it pins `SETTINGS_KEYS=16` and the 10/9/9/9
  catalog counts), the formatters, the inliner, and the static "no `setContentProtection`"
  grep. No browser. **Runs fine in the VM** (115 tests, ~6 s, no OOM as of this writing).
- **single-file** — the built single-file page in headless Chromium, 240×130 viewport,
  deterministic time via `page.clock`.
- **electron** — the real app via Playwright's `_electron`. **Host-only in practice.** It
  skips itself cleanly when `EPISODE_TIMER_SKIP_ELECTRON=1` or no Electron binary is found.

**The `EPISODE_TIMER_*` test knobs** (`tests/helpers/launch-electron.js`, `main.js`):

- `EPISODE_TIMER_ELECTRON_PATH` — point at a specific Electron binary. Resolution order:
  this override → `~/et-electron/Electron.app/.../Electron` (the VM-local extraction, because
  the shared folder can't hold the `.app`'s symlinks) → `require('electron')` (the host's npm
  binary).
- `EPISODE_TIMER_SKIP_ELECTRON` — skip the electron project entirely.
- `EPISODE_TIMER_USER_DATA` — isolate `userData` to a disposable dir (honored via
  `app.setPath` before anything loads). Test temp dirs use the `episode-timer-ud-` prefix.
- `EPISODE_TIMER_TEST=1` — set by the launcher: skips the single-instance lock and
  `app.dock.hide()` so parallel launches behave, skips the hover poll (Playwright drives
  hover synthetically / via the IPC directly), and exposes `global.__overtimeMenuTemplate`
  for asserting the shared tray/right-click menu labels.

**KNOWN VM flakes — do NOT mistake these for real failures** (they're VM artifacts; the test
*bodies* pass, and the same behavior passes under single-file):

- **`afterEach` `close()` teardown timeouts** in the electron project — the VM is
  memory-constrained; the window's `close()` can hang in teardown even though the test body
  asserted green.
- **single-file `clock.pauseAt` fake-timer desync** — under memory pressure the fake clock
  and the render loop can drift, tripping a time-sensitive assertion.
- **page-setup timeouts under memory pressure** — a launch/`domcontentloaded` wait can
  exceed its budget on a starved VM.

The VM is **severely memory-starved** (sibling processes get OOM-killed), so on the VM run
**unit only**; Electron end-to-end is a **host-confirm** step (window flags, always-on-top,
on-disk config, resize/quit), not a VM gate. (Logged in DECISIONS/HISTORY as "⚠️ Electron
e2e = host-confirm.")

---

## 12. Where to go next

- **How it's wired (plain tour):** [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- **What it is / every setting / build & test:** [`../GUIDE.md`](../GUIDE.md)
- **Why the product is shaped this way:** [`PRD.md`](./PRD.md) (historical spec + a
  "Current state" addendum)
- **Durable design calls:** [`DECISIONS.md`](./DECISIONS.md)
- **The blow-by-blow of how it got here (passes A–O):** [`HISTORY.md`](./HISTORY.md)
- **Dev-doc map + build-env gotchas:** [`HANDOFF.md`](./HANDOFF.md)

---

*Author: Claude (Anthropic). Direction: Jason Baker <jason@bakercode.org>. Built on camera
for the BakerCode YouTube series (channel URL provisional/unconfirmed).*
