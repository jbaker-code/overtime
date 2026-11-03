// source/app/renderer/app.js
// -----------------------------------------------------------------------------
// The renderer's UI wiring. Pulls together:
//   * the shared stopwatch state machine + formatters
//   * the environment bridge (Electron IPC or browser localStorage)
//   * the settings applier
// and drives the DOM: the wall clock, the episode stopwatch, the hover background,
// the resize grip, persistence pushes, and a small test/debug hook. (The on-pill
// control cluster — Play/Pause/Reset/Settings — is restored for BROWSER MODE ONLY,
// since a plain tab has no Electron tray/right-click menu to drive the timer; in the
// Electron build those buttons are hidden by CSS and the tray/menu stays in charge.)
//
// Globals it relies on (loaded earlier in index.html, in this order):
//   EpisodeTimerFormat, EpisodeTimerStopwatch, EpisodeTimerConfigSchema,
//   EpisodeTimerBridge, EpisodeTimerSettings.
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  var fmt = root.EpisodeTimerFormat;
  var sw = root.EpisodeTimerStopwatch;
  var bridge = root.EpisodeTimerBridge;
  var settingsMod = root.EpisodeTimerSettings;
  var panelMod = root.EpisodeTimerSettingsPanel;

  // The settings-panel controller (set up in boot()).
  var panel = null;
  // The last fully-applied settings, so the panel can ask us to RE-APPLY them
  // (without a persistence round-trip) once it learns new font availability.
  var lastAppliedSettings = null;

  // --- DOM references (frozen ids, PLAN §2.5) --------------------------------
  var els = {};
  function cacheEls() {
    els.app = document.getElementById('app');
    els.face = document.getElementById('face');
    els.clockTime = document.getElementById('clock-time');
    els.clockMeridiem = document.getElementById('clock-meridiem');
    els.stopwatch = document.getElementById('stopwatch');
    els.grip = document.getElementById('grip');
    // On-pill controls — present in the DOM in BOTH builds, but CSS shows them only in
    // browser mode (display:none in Electron). We still cache + wire them unconditionally;
    // the handlers are harmless where the cluster is hidden.
    els.controls = document.getElementById('controls');
    els.btnPlay = document.getElementById('btn-play');
    els.btnPause = document.getElementById('btn-pause');
    els.btnReset = document.getElementById('btn-reset');
    els.btnSettings = document.getElementById('btn-settings');
  }

  // --- stopwatch state (the renderer owns it; main only persists) ------------
  var state = sw.createInitial();
  var tickHandle = null;

  // Push the current timer to persistence (snapshotted + JSON-safe).
  function persistTimer() {
    bridge.pushTimer(sw.toPersisted(state, Date.now()));
  }

  // --- rendering --------------------------------------------------------------

  function renderClock(now) {
    // Pass a real Date (now is an epoch-ms number from Date.now()). formatClock
    // also coerces defensively, but this keeps the intent obvious.
    var parts = fmt.formatClock(new Date(now), settingsMod.getClockOptions());
    els.clockTime.textContent = parts.time;
    els.clockMeridiem.textContent = parts.meridiem;
    // Empty meridiem (24-hour mode) is hidden via CSS :empty, but hide it
    // explicitly too so there's zero chance of a stray gap.
    els.clockMeridiem.style.display = parts.meridiem ? '' : 'none';

    // Mirror into the settings-panel live preview (present once it's built).
    if (els.spTime) {
      els.spTime.textContent = parts.time;
      els.spMeridiem.textContent = parts.meridiem;
      els.spMeridiem.style.display = parts.meridiem ? '' : 'none';
    }
  }

  function renderStopwatch(now) {
    var text = fmt.formatElapsed(sw.elapsedMs(state, now));
    els.stopwatch.textContent = text;
    if (els.spStopwatch) els.spStopwatch.textContent = text; // live preview
  }

  // Paint the on-pill Play/Pause/Reset disabled state from the stopwatch model (one
  // source of truth: sw.canPlay/canPause/canReset — the same predicates the Electron
  // tray menu reads). This matters only for the browser build, where the buttons are
  // visible, but it runs unconditionally: setDisabled no-ops safely on a missing node,
  // and toggling `disabled` on the (hidden) buttons in Electron is a harmless no-op.
  // Settings has no disabled state (you can always open settings).
  function setDisabled(btn, disabled) {
    if (!btn) return; // defensive: markup could omit the cluster
    btn.disabled = !!disabled;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
  function renderButtons() {
    setDisabled(els.btnPlay, !sw.canPlay(state));   // Play off while running
    setDisabled(els.btnPause, !sw.canPause(state)); // Pause off unless running
    setDisabled(els.btnReset, !sw.canReset(state)); // Reset off at a clean zero/stop
  }

  // Full render: clock, stopwatch, status attribute, and the control buttons' enabled
  // state (browser build; a no-op where the cluster is hidden/absent).
  function render() {
    var now = Date.now();
    renderClock(now);
    renderStopwatch(now);
    els.app.setAttribute('data-status', state.status);
    renderButtons();
    // Decide whether the face's natural width might have changed, cheaply, so a
    // plain tick that didn't change the width does NO layout work. What counts as
    // a width change depends on the font:
    //   * TABULAR font: every digit has the same advance, so only the *length* of
    //     the digit runs matters (12/24h, seconds on/off, stopwatch 99h->100h).
    //     We signature on lengths -> the once-a-second digit churn is a no-op.
    //   * PROPORTIONAL font (tabular-nums ignored, e.g. Georgia): same-length
    //     times differ in width, so ANY change to the displayed digits can change
    //     the width -> signature on the full digit strings so every such tick
    //     re-fits (one offsetWidth reflow at 1 Hz, which is fine).
    // The meridiem is ALWAYS compared by content: AM/PM are letters, never
    // tabular, and the flip is rare, so it costs nothing to catch it everywhere.
    var digTime = fit.tabular ? els.clockTime.textContent.length : els.clockTime.textContent;
    var digSw = fit.tabular ? els.stopwatch.textContent.length : els.stopwatch.textContent;
    var sig = digTime + '|' + els.clockMeridiem.textContent + '|' + digSw;
    if (sig !== fit.sig) { fit.sig = sig; fit.dirty = true; }
    fitFace();
    fitPreview(); // keep the settings preview clock filling its fixed box (no-op when closed)
    redrawCutout(); // refresh the knockout holes from the new time/stopwatch (no-op off-cutout)
  }

  // --- fit-to-fill (hybrid: transform while resizing, font-size at rest) ------
  // The face is laid out at a fixed design base (#face { font-size: BASE_FONT }),
  // with every readout sized in `em`, so its natural geometry scales linearly
  // with the base. We make it FILL the pill (minus a small margin) along whichever
  // axis is the binding constraint — that's what lets a short-wide window show a
  // big wide clock instead of tiny vmin-collapsed text.
  //
  // WHY two mechanisms:
  //   * DURING an active resize we apply `transform: scale()`. That's a pure GPU
  //     composite — no reflow, no re-layout — so dragging the window edge tracks
  //     instantly instead of waiting on batched ResizeObserver/paint work (the
  //     "dead frames then snap" the host saw during macOS native live-resize).
  //   * AT REST (a short debounce after the last size change) we "settle": bake
  //     the scale into a real `font-size` and drop the transform back to none.
  //     A real font-size re-rasterizes (and re-hints/re-antialiases) the glyphs at
  //     their true pixel size, so the text is crisp — a transform only stretches a
  //     bitmap rasterized once at the base size, which looks soft/jaggy small.
  //
  // offsetWidth/Height report the UNSCALED layout size (transforms don't affect
  // them), measured at BASE_FONT so the natural box is a stable, font-independent
  // reference; there's no feedback loop with the ResizeObserver on #app.
  var MIN_PAD = 6;          // px — text never touches the edges
  var BASE_FONT = 100;      // px — must match #face { font-size } in styles.css
  var SETTLE_MS = 120;      // ms of quiet after the last resize before we bake

  // Cached fit state. cw/ch come from the ResizeObserver's contentRect (free);
  // natW/natH are the face's natural box AT BASE_FONT (re-measured only when the
  // readout content that matters for this font changes). `settled` means a real
  // font-size is currently baked in (transform is none); `dirty` means natW/natH
  // need re-measuring. `tabular` is the per-font verdict from probeTabular().
  var fit = {
    cw: 0, ch: 0, natW: 0, natH: 0,
    dirty: true, settled: false, sig: '', tabular: true,
    timer: null, measureCount: 0, settleCount: 0, probe: null
  };

  // Is the ACTIVE font actually fixed-width for digits? We ask for tabular figures
  // in CSS (font-variant-numeric + font-feature-settings), but that's only a
  // REQUEST — several bundled fonts (Georgia/serif most dramatically, also
  // helvetica/condensed/palatino/times) ignore it, so same-length times like
  // "11:11:11" and "20:48:40" render at different widths. If we assumed tabular
  // there, a tick that keeps the length but grows the width would never re-fit and
  // the face would overflow the pill (clipped by #app's overflow:hidden). So we
  // probe: measure a narrow vs a wide same-length digit string at BASE_FONT on an
  // off-screen node that inherits the live --font + figure settings (appended to
  // #app, which carries NO transform, so getBoundingClientRect is unscaled and
  // sub-pixel). Equal within ~0.5px -> truly tabular (keep the cheap length path);
  // otherwise proportional (re-fit whenever the DISPLAYED digits change).
  function ensureProbeEl() {
    if (fit.probe) return fit.probe;
    var p = document.createElement('span');
    p.setAttribute('aria-hidden', 'true');
    p.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
                      'white-space:nowrap;pointer-events:none;font-size:' + BASE_FONT + 'px';
    els.app.appendChild(p); // inherits --font + tabular-nums/tnum; #app has no transform
    fit.probe = p;
    return p;
  }
  function probeTabular() {
    if (!els.app) return true;
    var p = ensureProbeEl();
    p.textContent = '11:11:11';            // all-1s: the narrowest digits
    var narrow = p.getBoundingClientRect().width;
    p.textContent = '20:48:40';            // a wide digit mix, same length
    var wide = p.getBoundingClientRect().width;
    if (!narrow || !wide) return true;     // not measurable yet -> assume tabular
    return Math.abs(wide - narrow) <= 0.5;
  }

  // Re-measure natural geometry. ALWAYS at BASE_FONT: the ratio natW/BASE is
  // font-independent, so measuring at a fixed base keeps the scale math precise
  // no matter what font-size happens to be baked in right now. This is the only
  // place in the fit path that forces a reflow, and it runs only on a real shape
  // change — never on a plain tick.
  function measureFace() {
    if (els.face.style.fontSize !== BASE_FONT + 'px') {
      els.face.style.fontSize = BASE_FONT + 'px';
    }
    fit.natW = els.face.offsetWidth;  // forced reflow, at BASE_FONT
    fit.natH = els.face.offsetHeight;
    fit.settled = false;              // we're back at the base size now
    fit.dirty = false;
    fit.measureCount++;
  }

  // The scale that makes the natural box fill the pill minus padding. 0 when we
  // can't fit anything yet (zero-sized container, or both readouts hidden -> a
  // blank pill; must never throw or set a NaN font-size).
  function computeScale() {
    if (!fit.natW || !fit.natH || !fit.cw || !fit.ch) return 0;
    var pad = Math.max(MIN_PAD, Math.round(Math.min(fit.cw, fit.ch) * 0.06));
    var availW = Math.max(1, fit.cw - pad * 2);
    var availH = Math.max(1, fit.ch - pad * 2);
    var scale = Math.min(availW / fit.natW, availH / fit.natH);
    return (isFinite(scale) && scale > 0) ? scale : 0;
  }

  // Live, cheap feedback during an active resize: just a transform. The transform
  // is relative to BASE_FONT, so if we're currently settled (a baked font-size),
  // first drop back to BASE_FONT — one reflow at the START of the gesture, after
  // which continuous dragging is pure GPU composite.
  function applyLive(scale) {
    if (fit.settled) {
      els.face.style.fontSize = BASE_FONT + 'px';
      fit.settled = false;
    }
    els.face.style.transform = 'scale(' + scale + ')';
  }

  // Settle: bake the scale into a real font-size and drop the transform, so the
  // glyphs re-rasterize crisply at their true size.
  function settleNow() {
    if (fit.dirty) measureFace();
    var scale = computeScale();
    if (!scale) return;
    els.face.style.fontSize = (BASE_FONT * scale) + 'px';
    els.face.style.transform = 'none';
    fit.settled = true;
    fit.settleCount++;
    redrawCutout(); // the face just re-settled at a new size/layout -> redraw the holes crisp
  }

  function scheduleSettle() {
    if (fit.timer) clearTimeout(fit.timer);
    fit.timer = setTimeout(function () { fit.timer = null; settleNow(); }, SETTLE_MS);
  }

  // Called from render() (every tick) and on first paint. Steady state must be
  // free: if nothing about the shape changed, there's nothing to do and we touch
  // no layout. A real shape change goes straight to a crisp baked font-size (the
  // text isn't resizing, so there's no reason to route through the transform).
  function fitFace() {
    if (!els.face || !els.app) return;
    // The ResizeObserver owns cw/ch (free, from contentRect); seed them once on
    // the very first fit, before any RO callback has run.
    if (!fit.cw || !fit.ch) {
      fit.cw = els.app.clientWidth;
      fit.ch = els.app.clientHeight;
    }
    if (!fit.dirty) return; // steady-state tick: no reflow, no re-fit
    settleNow();
  }

  // The ResizeObserver path: the pill actually changed size. Give instant
  // transform feedback now, then bake a crisp font-size once the drag goes quiet.
  function onContainerResize(cw, ch) {
    if (!cw || !ch) return;
    if (cw === fit.cw && ch === fit.ch) return; // no real change
    fit.cw = cw;
    fit.ch = ch;
    if (fit.dirty) measureFace();  // keep natW/natH fresh (rare during a drag)
    var scale = computeScale();
    if (scale) applyLive(scale);
    scheduleSettle();
    redrawCutout(); // track the live-resizing pill so the holes don't lag the size (cheap)
  }

  // --- preview fit-to-box (the settings-panel live clock) --------------------
  // The settings preview is a FIXED-size box (styles.css gives #settings-preview a plain
  // px width, never vmin) so it doesn't track the real widget window. Its clock still needs
  // to FILL that box, so we give the preview its OWN measure-and-fill pass — the same idea
  // app.js uses to fill the pill, but scoped to the preview and decoupled from the widget's
  // live #face transform/scale. We measure the preview face's natural box at a base font-
  // size, then bake a scaled font-size onto #settings-preview; every preview readout is
  // sized in em, so they scale together. Runs only while the panel is open (cheap no-op
  // otherwise) and is idempotent, so calling it per tick / per settings change is fine.
  var PREVIEW_BASE_FONT = 34; // px — must match #settings-preview { font-size } in styles.css
  var PREVIEW_PAD = 10;       // px — breathing room inside the fixed preview box
  function fitPreview() {
    var box = els.spPreview, face = els.spFace;
    if (!box || !face || !els.app) return;
    if (els.app.getAttribute('data-settings') !== 'open') return; // only when visible
    // Natural content size at the stable base. width:max-content defeats the face's
    // width:100% so we read the INTRINSIC content width, not the box width.
    box.style.fontSize = PREVIEW_BASE_FONT + 'px';
    var prevWidth = face.style.width;
    face.style.width = 'max-content';
    var natW = face.offsetWidth, natH = face.offsetHeight; // forced reflow (only while open)
    face.style.width = prevWidth; // restore CSS width:100%
    var cw = box.clientWidth, ch = box.clientHeight;
    if (!natW || !natH || !cw || !ch) return; // blank pill / not laid out yet -> leave base
    var availW = Math.max(1, cw - PREVIEW_PAD * 2);
    var availH = Math.max(1, ch - PREVIEW_PAD * 2);
    var scale = Math.min(availW / natW, availH / natH);
    if (!isFinite(scale) || scale <= 0) return;
    box.style.fontSize = (PREVIEW_BASE_FONT * scale) + 'px';
  }

  // --- cutout (knockout) canvas redraw ---------------------------------------
  // Repaint the knockout canvas(es) from the current DOM + settings. paintCutout is a cheap
  // no-op whenever cutout is off (it just hides the canvas), so this is safe to call on every
  // tick and after every size/layout/settings change. It must run AFTER fitFace/fitPreview so
  // the face geometry it measures is the just-settled one. Covers the real pill and — in the
  // browser build — the in-page preview (the Electron settings window drives its own preview
  // from settings-window.js). Guarded on lastAppliedSettings so it never runs pre-first-apply.
  function redrawCutout() {
    if (!lastAppliedSettings || !settingsMod.paintCutout) return;
    settingsMod.paintCutout(els.app, els.face, lastAppliedSettings);
    if (els.spPreview && els.spFace) settingsMod.paintCutout(els.spPreview, els.spFace, lastAppliedSettings);
  }

  // --- the second-aligned tick -----------------------------------------------
  // Re-arm each tick so minute flips (and HH:MM:SS seconds) land right on the
  // second boundary rather than drifting. Elapsed is always recomputed from the
  // anchor, so a late/throttled tick costs display latency only, never drift.
  function scheduleTick() {
    if (tickHandle) clearTimeout(tickHandle);
    var delay = 1000 - (Date.now() % 1000) + 5;
    tickHandle = setTimeout(function () {
      render();
      // While running, keep the saved value fresh (<=1s stale on a hard kill).
      if (state.status === 'running') persistTimer();
      scheduleTick();
    }, delay);
  }

  // --- transitions (button handlers) -----------------------------------------
  // Each applies a pure transition; if the state object actually changed we
  // re-render and persist. No-ops (same object) are cheaply skipped.
  function applyTransition(next) {
    if (next === state) return; // identity -> nothing changed
    state = next;
    render();
    persistTimer();
  }

  // Run a stopwatch command by name. This is the ONE place a play/pause/reset
  // transition is applied; the Electron tray + right-click menu both route here
  // (via the bridge's onTimerCommand), and the test/debug hook exposes it so the
  // suite can drive the timer now that the on-pill buttons are gone.
  function runTimerCommand(action) {
    var now = Date.now();
    if (action === 'play') applyTransition(sw.play(state, now));
    else if (action === 'pause') applyTransition(sw.pause(state, now));
    else if (action === 'reset') applyTransition(sw.reset(state, now));
  }

  // --- hover background -------------------------------------------------------
  // data-hover toggles a 50%-black OVERLAY (#app::after) so the user has a visible grab/drag
  // target even when the configured background is fully transparent. It's an overlay (not a
  // background swap) so the configured background never animates (no startup flash). The same
  // attribute also fades in the browser-build control cluster + the resize grip.
  //
  // ONE driver per environment feeds the ONE data-hover attribute — and ONLY one, on purpose:
  //   * BROWSER: mouseenter/mouseleave on the document element. A plain tab has no drag region,
  //     so these fire normally; there's no cursor poll (the browser bridge's onHoverChanged is
  //     a no-op), so the DOM path is the sole driver.
  //   * ELECTRON: the main-process cursor poll pushed over IPC (bridge.onHoverChanged). This is
  //     the fix for the bug where the tint never appeared: the ENTIRE pill is
  //     -webkit-app-region: drag, and in a frameless window that native drag region SWALLOWS the
  //     mouse events the document listeners rely on — so against a real OS cursor
  //     mouseenter/mouseleave never fire and data-hover never flipped. (It LOOKED fine under
  //     Playwright because synthetic hover is injected below the OS drag region.) main polls
  //     screen.getCursorScreenPoint() vs the window bounds and sends the hover state here.
  //
  // WHY NOT wire BOTH in Electron: the DOM path is NOT fully dead there — no-drag children (the
  // resize grip) DO receive real pointer events, so moving the cursor grip<->pill-body fires a
  // spurious documentElement `mouseleave` that would clear a poll-set hover MID-hover. Since the
  // poll only re-sends on CHANGE, it wouldn't re-assert until the cursor fully exits and
  // re-enters the window — tint + grip stuck hidden. Gating to a single source per env (instead
  // of last-writer-wins between two) removes that race entirely.
  function setHover(on) { els.app.setAttribute('data-hover', on ? 'true' : 'false'); }
  function wireHover() {
    if (bridge.env === 'electron') {
      // Sole driver: main's cursor poll -> IPC. (Do NOT also wire DOM enter/leave — see above.)
      if (bridge.onHoverChanged) bridge.onHoverChanged(function (hover) { setHover(hover); });
    } else {
      // Sole driver: DOM enter/leave on the document element (no drag region in a browser tab).
      var docEl = document.documentElement;
      docEl.addEventListener('mouseenter', function () { setHover(true); });
      docEl.addEventListener('mouseleave', function () { setHover(false); });
    }
  }

  // --- resize grip ------------------------------------------------------------
  // Electron only. Because the window moves under the cursor as it grows, client
  // coordinates are useless — we use screenX/screenY deltas and let main honor
  // the larger delta against the aspect lock.
  function wireGrip() {
    if (bridge.env !== 'electron') return; // hidden in browser mode anyway
    var dragging = false;
    var lastX = 0;
    var lastY = 0;

    els.grip.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      try { els.grip.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    els.grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.screenX - lastX;
      var dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      if (dx || dy) bridge.resizeBy(dx, dy);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { els.grip.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    els.grip.addEventListener('pointerup', endDrag);
    els.grip.addEventListener('pointercancel', endDrag);
  }

  // --- on-pill controls (browser build) --------------------------------------
  // Wire the restored Play/Pause/Reset/Settings cluster. Play/Pause/Reset route through
  // the SAME runTimerCommand path the Electron tray + right-click menu use, so the
  // reset-keeps-running semantics are identical no matter who triggers them. Settings
  // opens the panel via panel.open() (Pass C made the panel open programmatically only;
  // this re-wires a direct click to it, rather than threading a gear element back through
  // panelMod.init). The buttons exist in both builds (CSS hides them in Electron), so we
  // wire unconditionally but guard each node — no listeners attach to a missing element.
  function wireControls() {
    if (els.btnPlay) els.btnPlay.addEventListener('click', function () { runTimerCommand('play'); });
    if (els.btnPause) els.btnPause.addEventListener('click', function () { runTimerCommand('pause'); });
    if (els.btnReset) els.btnReset.addEventListener('click', function () { runTimerCommand('reset'); });
    if (els.btnSettings) els.btnSettings.addEventListener('click', function () { openSettings(); });
  }

  // Open settings, the right way for THIS environment:
  //   * browser  -> the IN-PAGE overlay panel (panel.open()); the single-file build
  //                 has no second window, so this is the only settings UI there.
  //   * electron -> ask main to open/focus the SEPARATE settings window
  //                 (bridge.openSettings()); the pill builds no in-page panel.
  // Routing on `panel` (built only in browser mode, see setupPanel) keeps the split
  // clean: if the in-page panel exists we're the browser build; otherwise defer to main.
  function openSettings() {
    if (panel) { panel.open(); return; }
    if (bridge.openSettings) bridge.openSettings();
  }

  // --- settings ---------------------------------------------------------------
  function applyAndRemember(settings) {
    lastAppliedSettings = settings; // remember for an onReapply (font-availability refresh)
    settingsMod.applySettings(settings, document.documentElement, els.app);
    if (panel) panel.reflect(settings); // keep the panel's highlights in sync
    // The typeface may have changed, so re-detect whether digits are tabular (this
    // picks the per-tick signature strategy in render()). Layout, font and
    // per-readout visibility also change the face's natural box WITHOUT moving the
    // text lengths (hiding a readout, a wider typeface), which render()'s signature
    // wouldn't catch — so force a re-measure too.
    fit.tabular = probeTabular();
    fit.dirty = true;
    render(); // hour12/showSeconds may have changed -> redraw the clock
    fitPreview(); // layout/font/visibility changes resize the preview face -> refill its box
    redrawCutout(); // a settings change (cutout toggled, bg/opacity/font/layout) -> repaint holes
  }

  // Build + wire the tabbed settings panel. A click on any option persists the
  // single changed key through the SAME settings path (Electron IPC or browser
  // localStorage); the normalized result comes back and we apply it live.
  function setupPanel() {
    if (!panelMod) return; // defensive: panel script failed to load
    // BROWSER-ONLY now (boot() skips this in Electron, where settings live in a
    // separate window). No gearEl: the on-pill gear is gone; the panel opens
    // programmatically via openSettings() (the browser gear button, or the
    // __episodeTimer debug hook). panelMod.init tolerates a missing gear element.
    panel = panelMod.init({
      appEl: els.app,
      onSelect: function (key, value) {
        var patch = {};
        patch[key] = value;
        Promise.resolve(bridge.setSettings(patch)).then(function (settings) {
          applyAndRemember(settings);
        });
      },
      // Browser build: there's no OS window to grow (setSettingsOpen is a no-op), so
      // this just fills the preview box on open. Defer a frame so the panel has
      // flipped to display:flex and the preview box has laid out.
      onToggle: function (open) {
        if (bridge.setSettingsOpen) bridge.setSettingsOpen(open);
        if (open && root.requestAnimationFrame) root.requestAnimationFrame(fitPreview);
        else if (open) fitPreview();
      },
      // Re-apply the current settings live (no persistence) after the panel caches a
      // fresh queryLocalFonts list, so a customFont that had been falling back but is
      // now confirmed installed gets applied immediately.
      onReapply: function () {
        if (lastAppliedSettings) applyAndRemember(lastAppliedSettings);
      }
    });

    // The panel built its live-preview clone; cache its spans so render() can
    // keep them ticking with the real clock + stopwatch values, plus the preview
    // pill + face so fitPreview() can scale the clock to fill the fixed preview box.
    els.spTime = document.getElementById('sp-time');
    els.spMeridiem = document.getElementById('sp-meridiem');
    els.spStopwatch = document.getElementById('sp-stopwatch');
    els.spPreview = document.getElementById('settings-preview');
    els.spFace = els.spPreview ? els.spPreview.querySelector('.sp-face') : null;
    render(); // paint the preview immediately with the current values
  }

  // Tray / right-click-menu -> renderer wiring (Electron only; browser bridge
  // no-ops). The menu's Start/Pause/Reset Stopwatch run through runTimerCommand
  // (the renderer owns the stopwatch state). This is the primary timer-control path —
  // the on-pill buttons are gone. "Settings…" is NO LONGER routed through the renderer:
  // main opens the SEPARATE settings window directly (there's no in-page panel to open
  // in the Electron pill), so there's nothing to wire here for it.
  function wireTray() {
    if (bridge.onTimerCommand) {
      bridge.onTimerCommand(function (action) { runTimerCommand(action); });
    }
  }

  // Refit whenever the pill changes size (user drag-resize, grip, settings grow,
  // display scaling). ResizeObserver is ideal; fall back to window 'resize'.
  function wireFit() {
    if (typeof root.ResizeObserver === 'function') {
      var ro = new root.ResizeObserver(function (entries) {
        // contentRect is already measured by the observer, so reading it is free
        // (no forced reflow). #app is border-box with no padding/border, so its
        // content box == clientWidth/Height. Fall back to clientWidth if a browser
        // ever hands us an entry without contentRect.
        var e = entries && entries[0];
        var r = e && e.contentRect;
        onContainerResize(r ? r.width : els.app.clientWidth, r ? r.height : els.app.clientHeight);
      });
      ro.observe(els.app);
    } else if (root.addEventListener) {
      root.addEventListener('resize', function () {
        onContainerResize(els.app.clientWidth, els.app.clientHeight);
      });
    }
    fitFace();
  }

  // --- test / debug hook, PLAN §2.5 ------------------------------------------
  // Mostly read-only; also carries a tiny test-only control surface (command /
  // openSettings) since the on-pill buttons that tests used to click are gone.
  function installDebugHook() {
    root.__episodeTimer = {
      getState: function () { return { status: state.status, accumulatedMs: state.accumulatedMs, runningSince: state.runningSince }; },
      elapsedMs: function () { return sw.elapsedMs(state, Date.now()); },
      getSettings: function () { return settingsMod.getClockOptions(); },
      env: bridge.env,
      // Test-only control surface. The on-pill Play/Pause/Reset/Settings buttons
      // were removed (control moved to the Electron tray + native right-click
      // menu), so the suite drives the widget through these — exercising the SAME
      // runTimerCommand / panel.open() code paths the real menu uses.
      command: function (action) { runTimerCommand(action); },
      // Browser -> opens the in-page panel; Electron -> asks main for the separate
      // settings window (the same path the tray/right-click "Settings…" takes).
      openSettings: function () { openSettings(); },
      // Read-only window into the fit machinery so tests can lock the hybrid
      // behavior: `settled` + an explicit fontSize / 'none' transform at rest, a
      // 'scale(...)' transform mid-resize, and measureCount to prove the per-tick
      // path forces no reflow (the count must not climb as the clock ticks).
      fit: function () {
        return {
          settled: fit.settled,
          tabular: fit.tabular,
          fontSize: els.face.style.fontSize,
          transform: els.face.style.transform,
          measureCount: fit.measureCount,
          settleCount: fit.settleCount,
          natW: fit.natW, natH: fit.natH, cw: fit.cw, ch: fit.ch
        };
      }
    };
  }

  // --- boot -------------------------------------------------------------------
  function boot() {
    cacheEls();

    // Mark the environment so CSS can hide the Electron-only grip in browser mode.
    els.app.setAttribute('data-env', bridge.env);

    wireHover();
    wireGrip();
    // The IN-PAGE settings panel is BROWSER-ONLY now. In Electron, settings live in a
    // SEPARATE window (settings.html / settings-window.js), so the pill builds no panel
    // and `panel` stays null — openSettings() then defers to main (bridge.openSettings()).
    // Every preview/panel reference elsewhere is guarded on `panel`/the #sp-* nodes, so
    // skipping setup here is inert in Electron.
    if (bridge.env !== 'electron') setupPanel();
    wireControls(); // after setupPanel so the gear's click can reach panel.open() (browser)
    wireTray();
    installDebugHook();
    wireFit();

    // Re-render immediately when the tab/window becomes visible again (a hidden
    // page may have been throttled; backgroundThrottling:false covers Electron).
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) render();
    });

    // Load persisted settings + timer, then start ticking.
    Promise.resolve(bridge.getSettings()).then(function (settings) {
      applyAndRemember(settings);
    });

    bridge.onSettingsChanged(function (settings) {
      applyAndRemember(settings);
    });

    Promise.resolve(bridge.getTimer()).then(function (persisted) {
      state = sw.fromPersisted(persisted); // restore-as-paused (D6)
      render();
      scheduleTick();
    });

    // First paint even before the async settings/timer resolve.
    render();
    scheduleTick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}(typeof self !== 'undefined' ? self : this));
