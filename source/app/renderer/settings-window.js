// source/app/renderer/settings-window.js
// -----------------------------------------------------------------------------
// The renderer glue for the SEPARATE settings window (Electron only; settings.html).
//
// It is the Electron counterpart of the pill's in-page panel: it reuses the SAME
// tabbed panel (settings-panel.js), the SAME applier (settings-apply.js) and the
// SAME shared modules (format/stopwatch/config-schema) — this file only wires them
// to fill this window and keep the live preview ticking. The browser/single-file
// build does NOT use this file; it keeps the in-page #settings-panel overlay from
// index.html/app.js exactly as before.
//
// Live-update path (both directions):
//   * change here -> onSelect -> bridge.setSettings(patch) -> main persists +
//     broadcasts settings:changed to BOTH windows. The PILL re-applies (real clock
//     updates live over the wallpaper); THIS window re-applies to its own preview.
//   * change elsewhere (tray "Show clock", Float-on-top, etc.) -> settings:changed
//     reaches here too, so the preview + panel highlights stay in sync.
//
// Globals (loaded earlier in settings.html, in order):
//   EpisodeTimerFormat, EpisodeTimerStopwatch, EpisodeTimerConfigSchema,
//   EpisodeTimerBridge, EpisodeTimerSettings, EpisodeTimerSettingsPanel.
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  var fmt = root.EpisodeTimerFormat;
  var sw = root.EpisodeTimerStopwatch;
  var bridge = root.EpisodeTimerBridge;
  var settingsMod = root.EpisodeTimerSettings;
  var panelMod = root.EpisodeTimerSettingsPanel;

  var panel = null;
  var lastAppliedSettings = null; // for an onReapply (font-availability refresh)

  // Preview stopwatch state. We restore the saved timer (as paused, D6) purely so
  // the preview shows a representative value; the pill still OWNS the real state.
  var previewState = sw.createInitial();
  var tickHandle = null;

  var els = {};
  function cacheEls() {
    els.app = document.getElementById('app');
    els.grip = document.getElementById('settings-grip');
  }
  // The preview spans live INSIDE the panel, so they only exist after panelMod.init.
  function cachePreviewEls() {
    els.spTime = document.getElementById('sp-time');
    els.spMeridiem = document.getElementById('sp-meridiem');
    els.spStopwatch = document.getElementById('sp-stopwatch');
    els.spPreview = document.getElementById('settings-preview');
    els.spFace = els.spPreview ? els.spPreview.querySelector('.sp-face') : null;
  }

  // --- live preview render (the mini clock clone the panel shows) -------------
  function renderPreview() {
    var now = Date.now();
    var parts = fmt.formatClock(new Date(now), settingsMod.getClockOptions());
    if (els.spTime) els.spTime.textContent = parts.time;
    if (els.spMeridiem) {
      els.spMeridiem.textContent = parts.meridiem;
      els.spMeridiem.style.display = parts.meridiem ? '' : 'none';
    }
    if (els.spStopwatch) els.spStopwatch.textContent = fmt.formatElapsed(sw.elapsedMs(previewState, now));
    fitPreview();
    // Repaint the cutout knockout canvas for the preview (no-op when cutout is off). Runs
    // AFTER fitPreview so the measured face geometry is the just-settled one. In this window
    // the holes reveal the settings backdrop (host-only wallpaper see-through is on the pill).
    if (settingsMod.paintCutout && els.spPreview && els.spFace && lastAppliedSettings) {
      settingsMod.paintCutout(els.spPreview, els.spFace, lastAppliedSettings);
    }
  }

  // Fill the fixed preview box with the clock — the same measure-and-fill pass
  // app.js uses, scoped here. Idempotent, so per-tick / per-change calls are fine.
  var PREVIEW_BASE_FONT = 34; // px — must match #settings-preview { font-size } in styles.css
  var PREVIEW_PAD = 10;       // px — breathing room inside the fixed preview box
  function fitPreview() {
    var box = els.spPreview, face = els.spFace;
    if (!box || !face || !els.app) return;
    if (els.app.getAttribute('data-settings') !== 'open') return;
    box.style.fontSize = PREVIEW_BASE_FONT + 'px';
    var prevWidth = face.style.width;
    face.style.width = 'max-content';
    var natW = face.offsetWidth, natH = face.offsetHeight;
    face.style.width = prevWidth;
    var cw = box.clientWidth, ch = box.clientHeight;
    if (!natW || !natH || !cw || !ch) return;
    var availW = Math.max(1, cw - PREVIEW_PAD * 2);
    var availH = Math.max(1, ch - PREVIEW_PAD * 2);
    var scale = Math.min(availW / natW, availH / natH);
    if (!isFinite(scale) || scale <= 0) return;
    box.style.fontSize = (PREVIEW_BASE_FONT * scale) + 'px';
  }

  // Apply a full settings object to THIS window (its own :root vars + #app attrs +
  // the panel highlights + the preview). Mirrors app.js's applyAndRemember, minus the
  // real-pill fit machinery (there is no live #face here).
  function applyAndRemember(settings) {
    lastAppliedSettings = settings;
    settingsMod.applySettings(settings, document.documentElement, els.app);
    if (panel) panel.reflect(settings);
    renderPreview();
  }

  // Second-aligned tick so the preview clock lands on the second boundary.
  function scheduleTick() {
    if (tickHandle) clearTimeout(tickHandle);
    var delay = 1000 - (Date.now() % 1000) + 5;
    tickHandle = setTimeout(function () { renderPreview(); scheduleTick(); }, delay);
  }

  // --- resize grip ------------------------------------------------------------
  // Same screen-delta approach as the pill's grip: the window moves/resizes under the
  // cursor, so client coords are useless — we send screenX/screenY deltas and let main
  // resize THIS window (it resolves the sender's BrowserWindow from the IPC).
  function wireGrip() {
    if (!els.grip) return;
    var dragging = false, lastX = 0, lastY = 0;
    els.grip.addEventListener('pointerdown', function (e) {
      dragging = true; lastX = e.screenX; lastY = e.screenY;
      try { els.grip.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    els.grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.screenX - lastX, dy = e.screenY - lastY;
      lastX = e.screenX; lastY = e.screenY;
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

  // --- build the panel + wire everything --------------------------------------
  function setupPanel() {
    if (!panelMod) return; // defensive: panel script failed to load
    panel = panelMod.init({
      appEl: els.app,
      onSelect: function (key, value) {
        var patch = {};
        patch[key] = value;
        Promise.resolve(bridge.setSettings(patch)).then(function (settings) {
          applyAndRemember(settings);
        });
      },
      // Fill the preview box once the panel is visible (defer a frame for layout).
      onToggle: function (open) {
        if (open && root.requestAnimationFrame) root.requestAnimationFrame(fitPreview);
        else if (open) fitPreview();
      },
      onReapply: function () {
        if (lastAppliedSettings) applyAndRemember(lastAppliedSettings);
      }
    });

    cachePreviewEls();

    // The panel's × closes the WHOLE settings window (the pill keeps running). The
    // panel's own close handler also fires and hides the panel first — harmless, the
    // window is going away. (The panel is otherwise always "open" in this window.)
    var closeBtn = document.getElementById('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', function () {
      try { root.close(); } catch (e) {}
    });

    panel.open(); // show it immediately (this window IS the settings UI)
  }

  // --- boot -------------------------------------------------------------------
  function boot() {
    cacheEls();
    els.app.setAttribute('data-env', bridge.env); // 'electron'

    setupPanel();
    wireGrip();

    // Load current settings + reflect them; keep reflecting live broadcasts.
    Promise.resolve(bridge.getSettings()).then(function (settings) {
      applyAndRemember(settings);
    });
    bridge.onSettingsChanged(function (settings) {
      applyAndRemember(settings);
    });

    // Seed the preview stopwatch from the saved timer (restore-as-paused), then tick.
    Promise.resolve(bridge.getTimer()).then(function (persisted) {
      previewState = sw.fromPersisted(persisted);
      renderPreview();
    });

    renderPreview();
    scheduleTick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}(typeof self !== 'undefined' ? self : this));
