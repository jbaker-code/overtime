// source/app/renderer/settings-apply.js
// -----------------------------------------------------------------------------
// The ONE place that turns the `settings` object into DOM/CSS state. The tabbed
// settings panel changes settings (over IPC in Electron, localStorage in the
// browser); the change comes back here and nothing else in the renderer touches
// settings directly (app.js asks getClockOptions() for hour12/showSeconds).
//
// Exposes window.EpisodeTimerSettings { applySettings, getClockOptions,
// fontFamilyFor } — the panel reuses fontFamilyFor so its swatches render in
// the exact same stacks the widget will use.
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  // Font keyword -> CSS font-family stack. System / web-safe ONLY — no external
  // or CDN fonts, so the single-file build stays fully offline. Unknown keyword
  // falls back to the system stack (the schema should never hand us one).
  var FONT_STACKS = {
    system: '-apple-system, "SF Pro Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    mono: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    serif: 'Georgia, "Times New Roman", serif',
    helvetica: 'Helvetica, Arial, sans-serif',
    // (courier removed — Mono already covers monospace; see config-schema FONTS)
    times: '"Times New Roman", Times, serif',
    trebuchet: '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    palatino: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
    condensed: '"Arial Narrow", "Avenir Next Condensed", "Roboto Condensed", sans-serif'
  };

  function fontFamilyFor(font) {
    return FONT_STACKS[font] || FONT_STACKS.system;
  }

  // Quote a family name for use in a CSS font-family list, stripping any embedded
  // quotes so a hostile/odd name can't break out of the string.
  function cssQuote(family) {
    return '"' + String(family).replace(/"/g, '') + '"';
  }

  // --- custom (system-browser) font availability ----------------------------
  // customFont holds an arbitrary installed family name. Before we render in it we
  // MUST confirm it's actually present on THIS machine — otherwise the glyphs fall
  // back to an unknown face (or nothing), which is exactly the blank/broken clock
  // the user told us never to show. This check needs the DOM, so it lives here in
  // the renderer (the shared schema runs in main and can only keep the string
  // type-safe).
  //
  // WHY not document.fonts.check() alone: for a locally-installed (non-@font-face)
  // family, FontFaceSet.check() reports "ready" for ANY name — it returns true even
  // for a family that isn't installed — so it can't tell installed from bogus. We
  // use it only as a cheap gate (a pending web face would read false) and decide
  // the real question by MEASUREMENT: render a probe string in `"family", <generic>`
  // vs the generic alone; if the family is installed the metrics differ from the
  // generic fallback for at least one generic. If we've cached the queryLocalFonts()
  // family list (populated when the user opens the system-font browser), we trust
  // that as the authoritative answer and skip measuring.
  var knownFamilies = null; // Set<string> of installed families, or null if not yet enumerated

  // Called by the panel after a successful queryLocalFonts() enumeration so later
  // availability checks are an O(1) membership test instead of a measurement.
  function setKnownFamilies(families) {
    try {
      knownFamilies = new Set((families || []).map(function (f) { return String(f).toLowerCase(); }));
    } catch (e) {
      knownFamilies = null; // no Set? fall back to measurement forever
    }
  }

  var MEASURE_BASES = ['monospace', 'serif', 'sans-serif'];
  var MEASURE_STRING = 'mmmmmmmmmmlli1234567890'; // width-sensitive sample
  function measureInstalled(family) {
    if (!document.body) return false;
    var q = cssQuote(family);
    function dims(stack) {
      var s = document.createElement('span');
      s.setAttribute('aria-hidden', 'true');
      s.textContent = MEASURE_STRING;
      s.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        'white-space:nowrap;pointer-events:none;font-size:72px;font-family:' + stack;
      document.body.appendChild(s);
      // Sub-pixel metrics (getBoundingClientRect, like app.js's probeTabular) instead of
      // integer offsetWidth/Height — a tighter comparison that lowers the already-low risk
      // of a distinct family colliding with a generic's rounded box (false negative). The
      // probe node lives on document.body (no transform), so the rect is unscaled.
      var r = s.getBoundingClientRect();
      var d = { w: r.width, h: r.height };
      document.body.removeChild(s);
      return d;
    }
    for (var i = 0; i < MEASURE_BASES.length; i++) {
      var base = dims(MEASURE_BASES[i]);
      var test = dims(q + ',' + MEASURE_BASES[i]);
      if (test.w !== base.w || test.h !== base.h) return true; // rendered differently -> installed
    }
    return false;
  }

  function fontAvailable(family) {
    if (!family || typeof family !== 'string') return false;
    try {
      // POSITIVE-ONLY cache hint: a hit means "definitely installed" (authoritative),
      // but a MISS must NEVER by itself declare a font unavailable. queryLocalFonts()
      // enumerability != renderability, and the returned list can be partial (the user
      // shared only a subset) or empty — so on a miss we fall through to the same
      // cold-load path (document.fonts gate + width measurement) that ran before the
      // browser was ever opened. Otherwise opening the browser once would wrongly make
      // a genuinely-rendering family (e.g. Georgia) fall back for the rest of the session.
      if (knownFamilies && knownFamilies.has(family.toLowerCase())) return true;
      // Cheap gate: a pending/declared-but-unloaded web face reads false here. For a
      // plain system name this is always true, so measurement makes the real call.
      if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.check === 'function') {
        if (!document.fonts.check('16px ' + cssQuote(family))) return false;
      }
      return measureInstalled(family);
    } catch (e) {
      return false; // never let a probe failure mask the clock
    }
  }

  // Resolve the ACTIVE font for a settings object. The custom font wins ONLY when
  // the user has it switched ON (useCustomFont), its family is set, AND that family
  // is actually installed (with the curated stack appended as a last-ditch fallback);
  // in every other case the curated fontFamilyFor(font) rules. The three gates are
  // independent on purpose:
  //   * useCustomFont === false -> a curated pick is in effect; customFont is merely
  //     REMEMBERED (so the Custom tile can still restore it), not rendered.
  //   * useCustomFont === true but the family isn't installed -> fall back to the
  //     curated face (never a blank/missing glyph), and customActive stays false so
  //     the panel does NOT show the Custom tile selected.
  // customFont is kept-but-inactive in config in both those cases (see applySettings) —
  // we never silently rewrite the user's remembered choice. Returns the CSS family to
  // apply plus whether the custom font is the one actually rendering.
  function activeFontInfo(settings) {
    var curated = fontFamilyFor(settings && settings.font);
    var useCustom = !!(settings && settings.useCustomFont);
    var custom = settings && typeof settings.customFont === 'string' ? settings.customFont.trim() : '';
    if (useCustom && custom && fontAvailable(custom)) {
      return { family: cssQuote(custom) + ', ' + curated, customActive: true, customName: custom };
    }
    return { family: curated, customActive: false, customName: '' };
  }

  function activeFontFamily(settings) {
    return activeFontInfo(settings).family;
  }

  // '#rrggbb' -> 'r, g, b' so CSS can build rgba(var(--bg-rgb), var(--pill-opacity)).
  function hexToRgbTriplet(hex) {
    if (typeof hex !== 'string') return '0, 0, 0';
    var m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return '0, 0, 0';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255;
    var g = (n >> 8) & 255;
    var b = n & 255;
    return r + ', ' + g + ', ' + b;
  }

  // Rough perceived luminance (0..255) so we can auto-pick light/dark tinting
  // for the control buttons against whatever background was chosen.
  function luminance(hex) {
    var t = hexToRgbTriplet(hex).split(',').map(function (s) { return parseInt(s, 10); });
    return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  }

  // --- cutout (knockout) canvas ----------------------------------------------
  // The REAL hole-punch. CSS mix-blend-mode has no Porter-Duff operator, so it cannot
  // erase a pill's alpha into transparency; a <canvas> can (globalCompositeOperation =
  // 'destination-out'). In cutout mode we paint a canvas that COVERS the pill: fill it
  // with the configured background, then draw the numerals in destination-out so those
  // pixels go to alpha 0 — over the transparent Electron window, the desktop shows
  // through the glyph-shaped holes. --text-opacity is the erase STRENGTH (globalAlpha):
  // 1 = crisp full punch, lower = a fainter, partial cutout.
  //
  // We DON'T reimplement the 10 layouts' geometry: we MEASURE the live DOM (each text run's
  // rect + computed font) and redraw it on the canvas, so the holes auto-track every layout,
  // the chosen/custom font, and the fit scaling. The DOM #face is hidden (visibility:hidden,
  // kept in layout for measurement) and the #app background goes transparent (CSS, keyed on
  // data-cutout) so the canvas is the only visible pill surface. paintCutout is a no-op (just
  // hides the canvas) whenever cutout is off, so non-cutout rendering/fit is untouched.

  // The face may be scaled by a transform() mid-resize (the fit's live phase). In that phase
  // getBoundingClientRect is already post-transform (positions are correct) but computed
  // font-size is the un-scaled base, so multiply drawn glyph sizes by the live scale. At rest
  // (and in the preview, which scales via a baked font-size, not a transform) the scale is 1.
  function faceTransformScale(faceEl) {
    try {
      var t = (typeof root !== 'undefined' && root.getComputedStyle)
        ? root.getComputedStyle(faceEl).transform : '';
      if (!t || t === 'none') return 1;
      var m = /matrix\(([^)]+)\)/.exec(t);
      if (m) { var a = parseFloat(m[1].split(',')[0]); return (isFinite(a) && a > 0) ? a : 1; }
      return 1;
    } catch (e) { return 1; }
  }

  function fontString(cs, scale) {
    var sizePx = parseFloat(cs.fontSize) * scale;
    if (!isFinite(sizePx) || sizePx <= 0) return null;
    return (cs.fontStyle || 'normal') + ' ' + (cs.fontWeight || '400') + ' ' + sizePx + 'px ' + cs.fontFamily;
  }

  // Collect the drawable text runs inside the face: every LEAF element that directly holds
  // text (clock time, meridiem, stopwatch) PLUS any ::before glyph (the layout separators
  // "·"/"–", which are CSS content, not DOM text). Each run carries its post-transform rect,
  // its canvas font string, and how to anchor it.
  function collectRuns(faceEl, scale) {
    var runs = [];
    if (!faceEl || typeof root === 'undefined' || !root.getComputedStyle) return runs;
    var all = faceEl.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      var cs = root.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'collapse') continue;
      var rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      var hasEl = node.children && node.children.length > 0;
      if (!hasEl) {
        var txt = (node.textContent || '').trim();
        if (txt) {
          var f = fontString(cs, scale);
          if (f) runs.push({ text: txt, rect: rect, font: f, align: 'left' });
        }
      }
      // ::before content (e.g. the separator dot/dash). Centered in the node's box.
      var pseudo = root.getComputedStyle(node, '::before');
      var content = pseudo && pseudo.content;
      if (content && content !== 'none' && content !== 'normal') {
        var ch = content.replace(/^["']|["']$/g, '');
        if (ch) {
          var pf = fontString(pseudo, scale) || fontString(cs, scale);
          if (pf) runs.push({ text: ch, rect: rect, font: pf, align: 'center' });
        }
      }
    }
    return runs;
  }

  // Find the pill's OWN direct-child cutout canvas (never a descendant preview's canvas — in
  // the browser build the preview pill is nested inside #app, so a plain querySelector would
  // collide). Created lazily and inserted FIRST so it paints at the background layer.
  function directCutoutCanvas(hostEl, create) {
    var kids = hostEl.children, c = null, i;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].tagName === 'CANVAS' && kids[i].className.indexOf('et-cutout') !== -1) { c = kids[i]; break; }
    }
    if (!c && create) {
      c = document.createElement('canvas');
      c.className = 'et-cutout';
      c.setAttribute('aria-hidden', 'true');
      hostEl.insertBefore(c, hostEl.firstChild);
    }
    return c;
  }

  // Draw (or hide) the cutout canvas for a pill. hostEl is the pill (#app or #settings-preview),
  // faceEl is the readout container whose text we knock out. Safe to call every tick.
  function paintCutout(hostEl, faceEl, settings) {
    if (!hostEl || !faceEl || !settings) return;
    var on = settings.cutout === true;
    var existing = directCutoutCanvas(hostEl, false);
    if (!on) { if (existing) existing.style.display = 'none'; return; }

    var canvas = existing || directCutoutCanvas(hostEl, true);
    canvas.style.display = '';
    var w = hostEl.clientWidth, h = hostEl.clientHeight;
    if (!w || !h) return; // not laid out yet (e.g. a closed panel) -> try again next tick

    var dpr = (typeof root !== 'undefined' && root.devicePixelRatio) ? root.devicePixelRatio : 1;
    var bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 1) fill the whole pill with the configured background (rgba(bg, pill-opacity)).
    var op = (typeof settings.opacity === 'number' && isFinite(settings.opacity))
      ? Math.min(1, Math.max(0, settings.opacity)) : 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(' + hexToRgbTriplet(settings.bgColor) + ',' + op + ')';
    ctx.fillRect(0, 0, w, h);

    // 2) erase the glyphs -> holes. Strength = text-opacity (0 = no cutout, 1 = full punch).
    var strength = (typeof settings.textOpacity === 'number' && isFinite(settings.textOpacity))
      ? Math.min(1, Math.max(0, settings.textOpacity)) : 1;
    if (strength > 0) {
      var scale = faceTransformScale(faceEl);
      var runs = collectRuns(faceEl, scale);
      var hostRect = hostEl.getBoundingClientRect();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = strength;
      ctx.fillStyle = '#ffffff'; // opaque; destination-out uses only the source ALPHA
      ctx.textBaseline = 'middle';
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        ctx.font = run.font;
        ctx.textAlign = run.align === 'center' ? 'center' : 'left';
        var x = run.align === 'center'
          ? (run.rect.left + run.rect.width / 2 - hostRect.left)
          : (run.rect.left - hostRect.left);
        var y = run.rect.top + run.rect.height / 2 - hostRect.top;
        ctx.fillText(run.text, x, y);
      }
    }

    // reset so the 2D context isn't left in knockout mode
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Remember the last-applied settings so the tick can ask for clock options
  // without re-reading the config.
  var current = null;

  function applySettings(settings, docEl, appEl) {
    if (!settings) return;
    docEl = docEl || document.documentElement;
    appEl = appEl || document.getElementById('app');

    // Pill color + translucency (opacity owns the background alpha).
    docEl.style.setProperty('--bg-rgb', hexToRgbTriplet(settings.bgColor));
    docEl.style.setProperty('--pill-opacity', String(settings.opacity));

    // Text color + its OWN alpha. We split the text color into an rgb triplet plus a
    // separate --text-opacity so the CSS can render the numerals as
    // rgba(var(--text-rgb), var(--text-opacity)) — i.e. textOpacity fades the text
    // without touching the pill (mirrors how --pill-opacity fades the background).
    // --text-color is still published (the raw hex) because the panel docs + tests
    // read it as the chosen swatch; the alpha lives only in --text-opacity.
    docEl.style.setProperty('--text-color', settings.textColor);
    docEl.style.setProperty('--text-rgb', hexToRgbTriplet(settings.textColor));
    // Clamp defensively here too: a stray non-finite value (e.g. a hand-edited config
    // that slipped past normalize) must never become "NaN"/"undefined" in the CSS var,
    // which would drop the whole rgba() and flash the text to the fallback. isFinite
    // guards NaN/Infinity; Math.min/max pins it to [0,1].
    var textAlpha = (typeof settings.textOpacity === 'number' && isFinite(settings.textOpacity))
      ? Math.min(1, Math.max(0, settings.textOpacity))
      : 1;
    docEl.style.setProperty('--text-opacity', String(textAlpha));

    // Typeface. The ACTIVE font prefers an installed customFont over the curated
    // stack; an unavailable customFont silently falls back here (it stays in config,
    // just inactive) so the clock never renders a blank/missing face.
    docEl.style.setProperty('--font', activeFontFamily(settings));

    if (appEl) {
      // Arrangement of the two readouts.
      appEl.setAttribute('data-layout', settings.layout);
      // data-theme is now DERIVED from the background brightness (not a user
      // setting) purely so the hover control buttons keep sensible contrast.
      appEl.setAttribute('data-theme', luminance(settings.bgColor) > 140 ? 'light' : 'dark');
      // Per-readout visibility (toggled from the tray). CSS hides the readout (and
      // the separator) when off; with both off the pill is intentionally blank.
      appEl.setAttribute('data-show-clock', settings.showClock === false ? 'false' : 'true');
      appEl.setAttribute('data-show-stopwatch', settings.showStopwatch === false ? 'false' : 'true');
      // Cutout (knockout) mode. The attribute stages the canvas knockout: CSS makes the
      // pill background transparent + hides (but keeps-in-layout) the DOM face, and
      // paintCutout() draws the numerals onto a <canvas> with destination-out so they become
      // real transparent holes to the desktop (text color is ignored; --text-opacity is the
      // erase STRENGTH). This attribute drives the real pill; the settings-window preview sets
      // it on its own #app too (and paintCutout runs for the preview from the renderers).
      appEl.setAttribute('data-cutout', settings.cutout === true ? 'true' : 'false');
    }

    // hour12/showSeconds aren't CSS — they feed formatClock() on the next tick.
    current = settings;
  }

  // What the wall-clock tick needs. Falls back to sensible defaults before the
  // first applySettings() call.
  function getClockOptions() {
    return {
      hour12: current ? current.hour12 : true,
      showSeconds: current ? current.showSeconds : false
    };
  }

  root.EpisodeTimerSettings = {
    applySettings: applySettings,
    paintCutout: paintCutout, // canvas knockout renderer (cutout mode); no-op when cutout off
    getClockOptions: getClockOptions,
    fontFamilyFor: fontFamilyFor,
    // custom-font support (used by the Font tab's system-font browser + name bar)
    fontAvailable: fontAvailable,
    activeFontInfo: activeFontInfo,
    activeFontFamily: activeFontFamily,
    setKnownFamilies: setKnownFamilies
  };
}(typeof self !== 'undefined' ? self : this));
