// src/renderer/settings-apply.js
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

  // Resolve the ACTIVE font for a settings object. When customFont is set AND
  // installed, that family wins (with the curated stack appended as a last-ditch
  // fallback); otherwise the curated fontFamilyFor(font). Returns both the CSS
  // family string to apply AND whether the custom font is the one actually
  // rendering, so the panel's name bar can show the TRUE face (never a name for a
  // font that isn't installed). customFont is kept-but-inactive in config when
  // unavailable (see applySettings) — we never silently rewrite the user's choice.
  function activeFontInfo(settings) {
    var curated = fontFamilyFor(settings && settings.font);
    var custom = settings && typeof settings.customFont === 'string' ? settings.customFont.trim() : '';
    if (custom && fontAvailable(custom)) {
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
    getClockOptions: getClockOptions,
    fontFamilyFor: fontFamilyFor,
    // custom-font support (used by the Font tab's system-font browser + name bar)
    fontAvailable: fontAvailable,
    activeFontInfo: activeFontInfo,
    activeFontFamily: activeFontFamily,
    setKnownFamilies: setKnownFamilies
  };
}(typeof self !== 'undefined' ? self : this));
