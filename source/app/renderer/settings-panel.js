// source/app/renderer/settings-panel.js
// -----------------------------------------------------------------------------
// The tabbed, click-to-select settings panel (v2 feature). Builds its own DOM
// from the shared option catalogs (EpisodeTimerConfigSchema.LAYOUTS/FONTS/
// BG_COLORS/TEXT_COLORS), so the UI can never drift from what the schema will
// accept. No text inputs, no named dropdowns — every choice is a clickable
// visual tile. Works identically in Electron and in the browser single-file
// build (it only talks to the app via the onSelect callback).
//
// Exposes window.EpisodeTimerSettingsPanel.init(...) -> a small controller.
// Depends on EpisodeTimerConfigSchema (catalogs) and EpisodeTimerSettings
// (fontFamilyFor, so swatches render in the real stacks). Load after both.
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  var schema = root.EpisodeTimerConfigSchema;
  var settingsMod = root.EpisodeTimerSettings;

  // Human-friendly captions.
  var FONT_LABELS = {
    system: 'System', mono: 'Mono', serif: 'Serif', helvetica: 'Helvetica',
    times: 'Times', trebuchet: 'Trebuchet', verdana: 'Verdana',
    palatino: 'Palatino', condensed: 'Condensed'
  };
  var LAYOUT_LABELS = {
    'stack': 'Stacked', 'stopwatch-top': 'Timer top', 'clock-left': 'Clock · Timer',
    'side-by-side': 'Side by side', 'split': 'Split', 'one-line': 'One line',
    'dash': 'Dash', 'clock-hero': 'Big clock', 'stopwatch-hero': 'Big timer',
    'centered-gap': 'Roomy'
  };

  var TABS = [
    { id: 'layout', label: 'Layout' },
    { id: 'font', label: 'Font' },
    { id: 'colors', label: 'Colors' }
  ];
  var TAB_IDS = TABS.map(function (t) { return t.id; });

  // Tiny DOM builder. el('button', {id:'x', class:'y', 'data-value':'z'}, [kids|text]).
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  // One selectable option tile. All options share the same contract:
  //   <button class="option" data-setting="<key>" data-value="<value>">
  // "selected" is marked with aria-pressed="true" + the is-selected class.
  function option(settingKey, value, extraClass, inner) {
    return el('button', {
      type: 'button',
      class: 'option' + (extraClass ? ' ' + extraClass : ''),
      'data-setting': settingKey,
      'data-value': value,
      'aria-pressed': 'false',
      title: value
    }, inner);
  }

  // A mini arrangement preview: two bars (+ an optional separator) laid out by
  // the same data-layout attribute the real #face uses (CSS handles both).
  function layoutPreview(layout) {
    return el('span', { class: 'layout-preview arrange', 'data-layout': layout, 'aria-hidden': 'true' }, [
      el('i', { class: 'pv pv-clock' }),
      el('i', { class: 'pv pv-sep', 'aria-hidden': 'true' }),
      el('i', { class: 'pv pv-sw' })
    ]);
  }

  function buildLayoutPanel() {
    var grid = el('div', { class: 'option-grid grid-5' });
    schema.LAYOUTS.forEach(function (layout) {
      grid.appendChild(option('layout', layout, 'option-layout', [
        layoutPreview(layout),
        el('span', { class: 'option-caption', text: LAYOUT_LABELS[layout] || layout })
      ]));
    });
    return el('div', { id: 'panel-layout', class: 'tab-panel is-active', role: 'tabpanel', 'aria-labelledby': 'tab-layout' }, grid);
  }

  function buildFontPanel() {
    var grid = el('div', { class: 'option-grid grid-5' });

    // FIRST tile (top-left) = "Custom": the entry point to the system-font browser
    // (it replaces the old name bar + Edit button). It is NOT a curated enum tile — it
    // carries no data-setting/data-value, so the normal option-selection delegation
    // skips it and a separate handler opens the browser. Its caption is ALWAYS literally
    // "Custom" (never the chosen family's name); its swatch renders in the active custom
    // font when one is set, or a neutral system stack otherwise (filled in by reflect()).
    var customSwatch = el('span', { class: 'font-swatch', id: 'font-custom-swatch', text: '10:42' });
    customSwatch.style.fontFamily = settingsMod.fontFamilyFor('system'); // neutral until reflect()
    var customTile = el('button', {
      type: 'button', id: 'font-custom-tile', class: 'option option-font option-custom',
      'aria-pressed': 'false', title: 'Custom system font…'
    }, [customSwatch, el('span', { class: 'option-caption', text: 'Custom' })]);
    grid.appendChild(customTile);

    // Then the 9 curated presets.
    schema.FONTS.forEach(function (font) {
      var swatch = el('span', { class: 'font-swatch', text: '10:42' });
      swatch.style.fontFamily = settingsMod.fontFamilyFor(font); // live preview
      grid.appendChild(option('font', font, 'option-font', [
        swatch,
        el('span', { class: 'option-caption', text: FONT_LABELS[font] || font })
      ]));
    });

    return el('div', { id: 'panel-font', class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-font' }, [grid]);
  }

  // The "Choose system font" overlay: a 3-part header ([← Back] · "Choose system font" ·
  // [Save]) and a scrollable grid of system-font cards. It's built empty here and filled
  // from queryLocalFonts() when the Custom tile is clicked; CSS shows it (and hides the
  // tabs / tiles) while #app[data-fontbrowser="open"].
  function buildFontBrowser() {
    var back = el('button', { type: 'button', id: 'fb-back', class: 'fb-btn fb-back', 'aria-label': 'Back', html: '&#8592; Back' });
    var title = el('span', { class: 'fb-title', text: 'Choose system font' });
    var save = el('button', { type: 'button', id: 'fb-save', class: 'fb-btn fb-save', text: 'Save' });
    var hdr = el('div', { class: 'fb-header' }, [back, title, save]);
    // The grid is the ONLY scrolling region (its own overflow-y), so scrolling the
    // font list never scrolls the whole settings panel; the header stays put.
    var grid = el('div', { id: 'fb-grid', class: 'fb-grid', role: 'listbox', 'aria-label': 'System fonts' });
    return el('div', { id: 'font-browser' }, [hdr, grid]);
  }

  // --- the custom color picker (hue wheel + saturation/value square + hex) -----------------
  // A self-contained, dependency-free picker (canvas + vanilla JS; no OS color dialog, no CDN).
  // Built empty here; the Colors tab's picker swatch opens it as a TAKEOVER (same pattern as the
  // Font tab's Custom -> #font-browser): a 3-part header ([← Back] · title · [Save]) over a hue
  // ring on the LEFT, a saturation/value square on the RIGHT, and a hex box + current-color
  // swatch below. CSS shows it (and hides the tabs / tab panels) while #app[data-colorpicker="open"].
  function buildColorPicker() {
    var back = el('button', { type: 'button', id: 'cp-back', class: 'fb-btn fb-back', 'aria-label': 'Back', html: '&#8592; Back' });
    var title = el('span', { class: 'fb-title', id: 'cp-title', text: 'Choose color' });
    var save = el('button', { type: 'button', id: 'cp-save', class: 'fb-btn fb-save', text: 'Save' });
    var hdr = el('div', { class: 'fb-header cp-header' }, [back, title, save]);

    // Hue ring (LEFT). The canvas carries a fixed internal resolution; CSS scales it. The
    // marker is a positioned overlay (percent of the box) so a test can read its placement.
    var hueCanvas = el('canvas', { id: 'cp-hue', class: 'cp-hue', width: '240', height: '240', 'aria-hidden': 'true' });
    var hueMarker = el('span', { class: 'cp-hue-marker', 'aria-hidden': 'true' });
    var wheelWrap = el('div', { class: 'cp-wheel-wrap' }, [hueCanvas, hueMarker]);

    // Saturation/Value square (RIGHT). Redrawn for the current hue; x = saturation, y = value.
    var sqCanvas = el('canvas', { id: 'cp-square', class: 'cp-square', width: '240', height: '240', 'aria-hidden': 'true' });
    var sqMarker = el('span', { class: 'cp-sv-marker', 'aria-hidden': 'true' });
    var sqWrap = el('div', { class: 'cp-square-wrap' }, [sqCanvas, sqMarker]);

    var main = el('div', { class: 'cp-main' }, [wheelWrap, sqWrap]);

    var current = el('span', { class: 'cp-current', id: 'cp-current', 'aria-hidden': 'true' });
    var hexInput = el('input', { type: 'text', id: 'cp-hex', class: 'cp-hex', 'aria-label': 'Hex color', spellcheck: 'false', maxlength: '7', value: '#000000' });
    var foot = el('div', { class: 'cp-foot' }, [current, hexInput]);

    var body = el('div', { class: 'cp-body' }, [main, foot]);
    return el('div', { id: 'color-picker' }, [hdr, body]);
  }

  // --- HSV <-> RGB <-> hex (used by the picker; standard conversions) ----------------------
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function wrapHue(h) { return ((h % 360) + 360) % 360; }
  function hsvToRgb(h, s, v) {
    h = wrapHue(h);
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * (((b - r) / d) + 2);
      else h = 60 * (((r - g) / d) + 4);
    }
    return { h: wrapHue(h), s: s, v: v };
  }
  function hex2(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? '0' + s : s; }
  function rgbToHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  function parseHexColor(str) {
    if (typeof str !== 'string') return null;
    var m = /^#?([0-9a-f]{6})$/i.exec(str.trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // A small live clone of the real widget face, shown at the top of the panel.
  // It carries NO look logic of its own: the pill background/text/font come from
  // the same :root CSS vars (--bg-rgb/--pill-opacity/--text-rgb/--text-opacity/--font) and
  // its arrangement is driven by #app[data-layout] (it's a descendant of #app),
  // so every Layout/Font/Color click updates it the instant the real face would.
  // app.js writes the live time + stopwatch value into #sp-time/#sp-meridiem/
  // #sp-stopwatch each tick, so it keeps ticking while the panel is open.
  function buildPreview() {
    var time = el('span', { id: 'sp-time', text: '10:42' });
    var meridiem = el('span', { id: 'sp-meridiem', text: 'AM' });
    var clock = el('div', { class: 'sp-clock' }, [time, meridiem]);
    var sep = el('span', { class: 'sp-sep', 'aria-hidden': 'true' });
    var stopwatch = el('div', { id: 'sp-stopwatch', class: 'sp-sw', text: '00:00:00' });
    var face = el('div', { class: 'sp-face arrange' }, [clock, sep, stopwatch]);
    var pill = el('div', { id: 'settings-preview', 'aria-hidden': 'true' }, face);
    // The checkerboard backdrop sits BEHIND the pill so that lowering the
    // opacity visibly reveals "desktop" through the translucent pill (the panel
    // itself is opaque dark, which would otherwise hide the transparency).
    var backdrop = el('div', { id: 'settings-preview-backdrop' }, pill);
    return el('div', { class: 'settings-preview-wrap' }, backdrop);
  }

  // A continuous range slider (0..1) for an alpha value. Shared shape for both the
  // background- and text-opacity sliders; wired + reflected in init().
  function opacitySlider(id, label) {
    return el('input', {
      type: 'range', id: id, class: 'color-slider', min: '0', max: '1', step: '0.05',
      'aria-label': label, value: '1'
    });
  }

  // A small eyedropper glyph overlaid on each grid's PICKER swatch, so that cell reads as
  // "mix your own" rather than another preset. Inline SVG (offline-safe, no icon font).
  var DROPPER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18.4 2.6a2 2 0 0 1 2.8 2.8l-8.3 8.3-3.4.6.6-3.4z"/><path d="M11 6 4.5 12.5a2.1 2.1 0 0 0 0 3l.5.5L3 18.5 5.5 21l2.5-2 .5.5a2.1 2.1 0 0 0 3 0L18 13"/></svg>';

  // The last cell of each swatch grid: a PICKER swatch. Modeled on the Font tab's "Custom"
  // tile — it's an .option with NO data-setting/data-value, so the enum-select delegation
  // skips it and a dedicated handler opens the color-picker takeover. Its chip always shows
  // the REMEMBERED custom color (reflect() fills it): a solid fill for the bg picker, the 'A'
  // glyph tinted for the text picker (matching its sibling swatches). Empty -> a neutral
  // "pick one" look (the .is-empty hint). The dropper icon is overlaid on top.
  function colorPickerTile(which) {
    var isText = which === 'text';
    var chip = el('span', { class: 'swatch-chip swatch-picker is-empty' + (isText ? ' swatch-text' : '') });
    if (isText) chip.textContent = 'A';
    var dropper = el('span', { class: 'picker-dropper', 'aria-hidden': 'true', html: DROPPER_SVG });
    return el('button', {
      type: 'button',
      id: which + '-color-picker',
      class: 'option option-swatch option-picker',
      'aria-pressed': 'false',
      title: 'Custom color…'
    }, [chip, dropper]);
  }

  function buildColorsPanel() {
    // BACKGROUND swatches: a solid chip of the color. The 9 presets + the picker swatch as
    // the LAST cell (bottom-right) = 10 cells (a tidy 5x2 block).
    var bgGrid = el('div', { class: 'option-grid swatch-grid' });
    schema.BG_COLORS.forEach(function (color) {
      var chip = option('bgColor', color, 'option-swatch', el('span', { class: 'swatch-chip' }));
      chip.querySelector('.swatch-chip').style.background = color;
      bgGrid.appendChild(chip);
    });
    bgGrid.appendChild(colorPickerTile('bg'));

    // TEXT swatches: a sample glyph painted in the color (on a neutral chip). 9 presets +
    // the picker swatch last.
    var textGrid = el('div', { class: 'option-grid swatch-grid' });
    schema.TEXT_COLORS.forEach(function (color) {
      var chip = option('textColor', color, 'option-swatch', el('span', { class: 'swatch-chip swatch-text', text: 'A' }));
      chip.querySelector('.swatch-chip').style.color = color;
      textGrid.appendChild(chip);
    });
    textGrid.appendChild(colorPickerTile('text'));

    // Two opacity sliders, each sitting directly UNDER its own swatch grid:
    //   - background opacity drives --pill-opacity (the EXISTING `opacity` setting),
    //     so it can slide to 0 for a fully see-through pill.
    //   - text opacity drives --text-opacity (the NEW `textOpacity` setting), fading
    //     the numerals to invisible at 0.
    // Each section is a shrink-wrapped, centered block (.color-section) so the slider
    // ends up exactly as wide as the swatch grid above it (see styles.css).
    var bgSlider = opacitySlider('opacity-slider', 'Background opacity');
    var textSlider = opacitySlider('text-opacity-slider', 'Text opacity');

    // A small gray label (same .settings-section style as the "Background"/"Text color"
    // headers) sits directly ABOVE each opacity slider so it's clear what the slider does.
    var bgSection = el('div', { class: 'color-section' }, [
      el('h3', { class: 'settings-section', text: 'Background' }),
      bgGrid,
      el('h3', { class: 'settings-section slider-label', text: 'Background Opacity' }),
      el('div', { class: 'slider-row' }, [bgSlider])
    ]);

    // Cutout checkbox — sits directly UNDER the text-opacity slider. When ON, the numerals
    // become holes punched through the opaque pill to the desktop (the text COLOR is ignored;
    // the text-opacity slider above becomes the cutout STRENGTH). The label wraps the input
    // (no `for`) so a single click toggles it exactly once.
    var cutoutCheckbox = el('input', { type: 'checkbox', id: 'cutout-checkbox', class: 'cutout-checkbox' });
    var cutoutRow = el('label', { class: 'cutout-row', id: 'cutout-row' }, [
      cutoutCheckbox,
      el('span', { class: 'cutout-caption', text: 'Cutout' })
    ]);

    var textSection = el('div', { class: 'color-section' }, [
      el('h3', { class: 'settings-section', text: 'Text color' }),
      textGrid,
      el('h3', { class: 'settings-section slider-label', text: 'Text Opacity' }),
      el('div', { class: 'slider-row' }, [textSlider]),
      cutoutRow
    ]);

    return el('div', { id: 'panel-colors', class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-colors' }, [
      bgSection,
      textSection
    ]);
  }

  // init — build + wire everything. Returns a controller the app uses.
  //   opts.appEl   : the #app element (panel is appended inside it)
  //   opts.onSelect: (settingKey, value) => void  (app persists + applies)
  // NOTE: there is no gear button any more (the on-pill controls were removed).
  // The panel is opened programmatically via the returned controller's open()
  // (tray "Settings…" / right-click menu). init works with no opener element.
  function init(opts) {
    var appEl = opts.appEl;
    var onSelect = opts.onSelect || function () {};
    var onToggle = opts.onToggle || function () {}; // (open:boolean) -> void
    var onReapply = opts.onReapply || function () {}; // re-apply current settings live (no persist)

    // --- tabs ---
    var tabButtons = TABS.map(function (t) {
      return el('button', {
        type: 'button',
        class: 'tab' + (t.id === 'layout' ? ' is-active' : ''),
        id: 'tab-' + t.id,
        role: 'tab',
        'data-tab': t.id,
        'aria-selected': t.id === 'layout' ? 'true' : 'false',
        text: t.label
      });
    });
    var tabNav = el('div', { class: 'settings-tabs', role: 'tablist' }, tabButtons);

    // --- header (title + close) ---
    var closeBtn = el('button', { type: 'button', id: 'settings-close', class: 'settings-close', 'aria-label': 'Close settings', html: '&#215;' });
    var header = el('div', { class: 'settings-header' }, [
      el('span', { class: 'settings-title', text: 'Settings' }),
      closeBtn
    ]);

    // --- panels ---
    var panels = el('div', { class: 'settings-body' }, [
      buildLayoutPanel(),
      buildFontPanel(),
      buildColorsPanel()
    ]);

    // Order (top -> bottom): title+× row, then the live preview, then the tab
    // nav, then (hidden) the Choose-font overlay, then the tab panels. The overlay
    // sits right after the tab nav so that, when it takes over, its header lands
    // exactly where the tab bar was.
    var fontBrowser = buildFontBrowser();
    // The color-picker overlay sits right after the font browser (both after the tab nav), so
    // when either takes over, its header lands exactly where the tab bar was. The live preview
    // stays ABOVE them, so the picker's live color changes are visible on the preview clock.
    var colorPicker = buildColorPicker();
    var panel = el('div', { id: 'settings-panel', role: 'dialog', 'aria-label': 'Widget settings' }, [header, buildPreview(), tabNav, fontBrowser, colorPicker, panels]);
    appEl.appendChild(panel);

    // --- Font tab: Custom tile + system-font browser wiring ---
    var customTile = panel.querySelector('#font-custom-tile');
    var customSwatch = panel.querySelector('#font-custom-swatch');
    var previewPill = panel.querySelector('#settings-preview'); // the live clock preview
    var fbGrid = panel.querySelector('#fb-grid');
    var fbBack = panel.querySelector('#fb-back');
    var fbSave = panel.querySelector('#fb-save');

    var lastSettings = null;       // most recent settings reflected into the panel
    var selectedFamily = '';       // DEFERRED selection in Choose-font mode (committed on Save)
    var previewFontSnapshot = '';  // the preview's font-family override at overlay-open, restored on Back

    // Feature-detect: queryLocalFonts is desktop/Electron-only. Without it (the
    // single-file/browser build) the system-font browser can't work, so disable the
    // Custom tile entirely rather than offer an entry point that does nothing. (It
    // stays in the DOM — hidden — so it never silently changes the tile count.)
    var hasQueryLocalFonts = (typeof root.queryLocalFonts === 'function');
    if (!hasQueryLocalFonts && customTile) {
      customTile.setAttribute('hidden', '');
      customTile.disabled = true;
    }

    function enterChooseMode() { appEl.setAttribute('data-fontbrowser', 'open'); }
    function exitChooseMode() { appEl.removeAttribute('data-fontbrowser'); }

    // A representative, STATIC sample (the current HH:MM) painted in each card's
    // font — one string shared by every card, so there are no N live timers.
    function sampleTime() {
      try {
        var d = new Date(), h = d.getHours(), m = d.getMinutes();
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
      } catch (e) { return '12:34'; }
    }

    // Highlight exactly one card (deferred selection — no apply yet).
    function markSelectedCard(family) {
      var cards = fbGrid.querySelectorAll('.fb-card');
      Array.prototype.forEach.call(cards, function (c) {
        var on = c.getAttribute('data-family') === family;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    // Center the pre-selected card in the (bounded, own-scroll) grid. This MUST run
    // AFTER the overlay is shown (#app[data-fontbrowser="open"]): while #font-browser is
    // still display:none the grid has no box to scroll, so a scroll set there is simply
    // dropped — which is exactly why a fresh-after-restart open used to land at the top
    // with the remembered family scrolled off-screen. We scroll only once the grid is
    // laid out. scrollIntoView({block:'center'}) is the request; a manual centering is the
    // fallback for environments that ignore the options object.
    function scrollSelectedIntoView() {
      if (!fbGrid) return;
      var sel = fbGrid.querySelector('.fb-card.is-selected');
      if (!sel) { fbGrid.scrollTop = 0; return; }
      try {
        sel.scrollIntoView({ block: 'center' });
      } catch (e) {
        // Fallback for environments that throw on the options object. fbGrid is the
        // scroll container but is NOT positioned, so it is not sel.offsetParent — using
        // sel.offsetTop here measured from the wrong element and never actually centered
        // the card. Measure the card relative to the grid with getBoundingClientRect
        // (offsetParent-independent) and nudge scrollTop to center it.
        var gridRect = fbGrid.getBoundingClientRect();
        var selRect = sel.getBoundingClientRect();
        var delta = (selRect.top - gridRect.top) - (fbGrid.clientHeight - sel.offsetHeight) / 2;
        fbGrid.scrollTop = Math.max(0, fbGrid.scrollTop + delta);
      }
    }

    // Build the card grid from a queryLocalFonts() result: one entry per FACE, so
    // dedupe by .family (each family once), sort A->Z, and render a big preview +
    // an ellipsis-truncated family name. A document fragment keeps a hundreds-long
    // list a single reflow.
    function populateFontGrid(fonts) {
      var seen = Object.create(null);
      var families = [];
      (fonts || []).forEach(function (f) {
        var fam = f && f.family;
        if (typeof fam !== 'string' || !fam) return;
        var key = fam.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        families.push(fam);
      });
      families.sort(function (a, b) { return a.localeCompare(b); });

      var sample = sampleTime();
      var frag = document.createDocumentFragment();
      families.forEach(function (fam) {
        var preview = el('span', { class: 'fb-preview', 'aria-hidden': 'true', text: sample });
        preview.style.fontFamily = '"' + fam.replace(/"/g, '') + '"'; // render in THAT font
        var name = el('span', { class: 'fb-cardname', text: fam, title: fam });
        frag.appendChild(el('button', {
          type: 'button', class: 'fb-card', 'data-family': fam, 'aria-pressed': 'false', title: fam
        }, [preview, name]));
      });
      fbGrid.innerHTML = '';
      fbGrid.appendChild(frag);

      // Pre-highlight the REMEMBERED custom family if it's in the list (independent of
      // useCustomFont — we always pre-select what you'd be switching back to), so Save
      // without a fresh pick is a harmless no-op rather than a surprise. The matching
      // SCROLL (centering it) happens in scrollSelectedIntoView() once the overlay is
      // visible — doing it here, while #font-browser is still display:none, wouldn't land.
      var remembered = (lastSettings && typeof lastSettings.customFont === 'string') ? lastSettings.customFont.trim() : '';
      selectedFamily = remembered;
      markSelectedCard(selectedFamily);
    }

    // Quote a family for a CSS font-family override, stripping embedded quotes.
    function cssQuoteFamily(family) { return '"' + String(family).replace(/"/g, '') + '"'; }

    // Live-update ONLY the preview clock's font (an inline override on the preview
    // pill; children inherit it). This never touches --font, so the real widget and
    // the stored customFont are unchanged — the browse selection stays deferred.
    function setPreviewFont(cssFamily) {
      if (previewPill) previewPill.style.fontFamily = cssFamily; // '' clears the override
    }

    // Open the system-font browser (the old Edit-button behavior, now on the Custom
    // tile). Snapshot the preview's current font override so Back can restore the
    // previously-active font exactly (clicking cards only changes the preview).
    function openFontBrowser() {
      if (typeof root.queryLocalFonts !== 'function') return; // belt-and-suspenders
      previewFontSnapshot = previewPill ? previewPill.style.fontFamily : '';
      Promise.resolve(root.queryLocalFonts()).then(function (fonts) {
        populateFontGrid(fonts);
        // Cache the authoritative installed-family list so later availability
        // checks are an O(1) membership test instead of a measurement.
        try {
          settingsMod.setKnownFamilies((fonts || []).map(function (f) { return f && f.family; }).filter(Boolean));
        } catch (err) { /* non-fatal */ }
        enterChooseMode();
        // Overlay is now visible, so the grid finally has a box to scroll: center the
        // pre-selected (remembered) family. rAF gives the just-flipped display:flex one
        // frame to lay out before we measure/scroll (belt-and-suspenders over the direct
        // call, which already works once the overlay is shown).
        scrollSelectedIntoView();
        if (root.requestAnimationFrame) root.requestAnimationFrame(scrollSelectedIntoView);
        // The cache is now populated: re-apply the live settings so a customFont that
        // had been falling back but is now CONFIRMED installed gets applied + highlighted.
        // (The cache is positive-only, so this never flips an installed font to fallback.)
        onReapply();
      }).catch(function () { /* permission denied / error -> stay on the Font tab */ });
    }

    if (customTile) {
      customTile.addEventListener('click', function (e) {
        e.stopPropagation();
        openFontBrowser();
      });
    }

    // Deferred selection: a card click SELECTS (highlights) and LIVE-UPDATES THE PREVIEW
    // font so the host can see the candidate on the preview clock — but it does NOT apply
    // to the real widget, does NOT persist, and does NOT leave Choose-font mode.
    fbGrid.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.fb-card') : null;
      if (!card) return;
      selectedFamily = card.getAttribute('data-family');
      markSelectedCard(selectedFamily);
      // Append the curated stack as a last-ditch fallback (mirrors activeFontInfo), so a
      // not-quite-renderable pick still shows a sane preview instead of nothing.
      var curated = settingsMod.fontFamilyFor(lastSettings && lastSettings.font);
      setPreviewFont(cssQuoteFamily(selectedFamily) + ', ' + curated);
    });

    // Save commits the selected family (applies live to the REAL widget via onSelect) and
    // returns to the normal Font tab. Clearing the preview override lets the preview track
    // the newly-applied --font. Only sends a patch when something is actually selected, so
    // an accidental Save never clears an existing custom font.
    fbSave.addEventListener('click', function (e) {
      e.stopPropagation();
      setPreviewFont(''); // drop the override -> preview follows the real --font after commit
      // Commit BOTH: remember the family AND switch the custom font ON (useCustomFont).
      // Only when something is actually selected, so an accidental Save never flips on
      // (or clears) an existing custom font.
      if (selectedFamily) {
        onSelect('customFont', selectedFamily);
        onSelect('useCustomFont', true);
      }
      exitChooseMode();
    });

    // Back cancels — no commit — and returns to the normal Font tab, restoring the preview
    // to the font that was active when the overlay opened (the browsed candidate is dropped).
    fbBack.addEventListener('click', function (e) {
      e.stopPropagation();
      setPreviewFont(previewFontSnapshot); // revert the preview to the previously-active font
      exitChooseMode();
    });

    // Toggle the Custom tile's selected/pressed state (it has no data-setting, so it's
    // not part of the curated markSelectedInGroup group).
    function setCustomSelected(on) {
      if (!customTile) return;
      customTile.classList.toggle('is-selected', !!on);
      customTile.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // --- Colors tab: the color-picker takeover (wheel + square + hex) -----------------------
    // Opened by either grid's picker swatch; a near-exact parallel of the Font tab's Custom ->
    // #font-browser flow. Dragging the hue wheel / SV square or typing a hex updates the picker's
    // internal HSV and LIVE-PREVIEWS onto the settings preview pill ONLY (an inline --bg-rgb /
    // --text-rgb override, exactly like setPreviewFont) — it is never committed and never
    // persisted, so the real pill (:root var) and storage stay untouched until Save. Save commits
    // BOTH the active color and the remembered custom via the normal onSelect patch->broadcast
    // path; Back reverts the preview to the color that was active when the picker opened.
    var cpHue = panel.querySelector('#cp-hue');
    var cpSquare = panel.querySelector('#cp-square');
    var cpHueMarker = panel.querySelector('.cp-hue-marker');
    var cpSvMarker = panel.querySelector('.cp-sv-marker');
    var cpHex = panel.querySelector('#cp-hex');
    var cpCurrent = panel.querySelector('#cp-current');
    var cpTitle = panel.querySelector('#cp-title');
    var cpBack = panel.querySelector('#cp-back');
    var cpSave = panel.querySelector('#cp-save');
    var bgPickerTile = panel.querySelector('#bg-color-picker');
    var textPickerTile = panel.querySelector('#text-color-picker');

    var HUE_RING_WIDTH = 26;      // px thickness of the hue ring on the 240px canvas
    var cpMode = null;            // 'bg' | 'text' while the picker is open, else null
    var cpHsv = { h: 0, s: 0, v: 0 };
    var cpPreviewSnapshot = '';   // the preview's inline var override at open (restored on Back)

    function cpVarName() { return cpMode === 'text' ? '--text-rgb' : '--bg-rgb'; }
    function cpSettingKey() { return cpMode === 'text' ? 'textColor' : 'bgColor'; }
    function cpCustomKey() { return cpMode === 'text' ? 'customTextColor' : 'customBgColor'; }
    function cpCurrentHex() { return rgbToHex(hsvToRgb(cpHsv.h, cpHsv.s, cpHsv.v)); }
    function cpTriplet() { var c = hsvToRgb(cpHsv.h, cpHsv.s, cpHsv.v); return c.r + ', ' + c.g + ', ' + c.b; }

    // Live-preview the picked color onto the preview pill ONLY (inline var override; '' clears).
    function cpSetPreview(triplet) {
      if (previewPill) previewPill.style.setProperty(cpVarName(), triplet);
    }

    // Paint the hue ring (one thin arc per degree, in hsl so the ring hue == the angle we read
    // back). Canvas has a fixed buffer, so this works even while the overlay is display:none.
    function drawHueRing() {
      if (!cpHue || !cpHue.getContext) return;
      var ctx = cpHue.getContext('2d'); if (!ctx) return;
      var size = cpHue.width, cx = size / 2, cy = size / 2;
      var r = size / 2 - 1 - HUE_RING_WIDTH / 2;
      ctx.clearRect(0, 0, size, size);
      ctx.lineWidth = HUE_RING_WIDTH;
      for (var a = 0; a < 360; a++) {
        ctx.beginPath();
        ctx.strokeStyle = 'hsl(' + a + ',100%,50%)';
        ctx.arc(cx, cy, r, (a - 1) * Math.PI / 180, (a + 1) * Math.PI / 180);
        ctx.stroke();
      }
    }

    // Paint the SV square for the current hue: pure hue, a white gradient L->R (saturation),
    // then a black gradient top->bottom (value). x = saturation (0 left), y = value (1 top).
    function drawSvSquare() {
      if (!cpSquare || !cpSquare.getContext) return;
      var ctx = cpSquare.getContext('2d'); if (!ctx) return;
      var w = cpSquare.width, h = cpSquare.height;
      ctx.fillStyle = 'hsl(' + wrapHue(cpHsv.h) + ',100%,50%)';
      ctx.fillRect(0, 0, w, h);
      var gx = ctx.createLinearGradient(0, 0, w, 0);
      gx.addColorStop(0, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gx; ctx.fillRect(0, 0, w, h);
      var gy = ctx.createLinearGradient(0, 0, 0, h);
      gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = gy; ctx.fillRect(0, 0, w, h);
    }

    // Move the markers + sync the hex box and current-color swatch from cpHsv.
    function cpReflectControls() {
      var hex = cpCurrentHex();
      if (cpHueMarker) {
        var ang = wrapHue(cpHsv.h) * Math.PI / 180;
        var size = cpHue ? cpHue.width : 240;
        var rpx = size / 2 - 1 - HUE_RING_WIDTH / 2;
        cpHueMarker.style.left = ((size / 2 + rpx * Math.cos(ang)) / size * 100) + '%';
        cpHueMarker.style.top = ((size / 2 + rpx * Math.sin(ang)) / size * 100) + '%';
      }
      if (cpSvMarker) {
        cpSvMarker.style.left = (clamp01(cpHsv.s) * 100) + '%';
        cpSvMarker.style.top = ((1 - clamp01(cpHsv.v)) * 100) + '%';
      }
      if (cpCurrent) cpCurrent.style.background = hex;
      // Don't fight the user mid-type: only overwrite the box when it isn't focused.
      if (cpHex && document.activeElement !== cpHex) cpHex.value = hex;
    }

    // Set the picker's color from HSV (redraws the square for the new hue) and live-preview it.
    function cpSetFromHsv(h, s, v) {
      cpHsv = { h: wrapHue(h), s: clamp01(s), v: clamp01(v) };
      drawSvSquare();
      cpReflectControls();
      cpSetPreview(cpTriplet());
    }
    // Set from a hex string; invalid input is ignored (the internal color stays put). Returns
    // whether it parsed.
    function cpSetFromHex(hex) {
      var rgb = parseHexColor(hex);
      if (!rgb) return false;
      var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      cpHsv = { h: hsv.h, s: hsv.s, v: hsv.v };
      drawSvSquare();
      cpReflectControls();
      cpSetPreview(cpTriplet());
      return true;
    }

    // Pointer -> hue (angle from the ring center) / saturation+value (position in the square).
    function cpHueFromPoint(x, y) {
      var rect = cpHue.getBoundingClientRect();
      var deg = Math.atan2(y - (rect.top + rect.height / 2), x - (rect.left + rect.width / 2)) * 180 / Math.PI;
      return wrapHue(deg);
    }
    function cpSvFromPoint(x, y) {
      var rect = cpSquare.getBoundingClientRect();
      return {
        s: clamp01((x - rect.left) / rect.width),
        v: clamp01(1 - (y - rect.top) / rect.height)
      };
    }

    // A reusable drag installer (pointer capture so a drag that leaves the element keeps tracking).
    function installDrag(elem, handler) {
      if (!elem) return;
      var dragging = false;
      elem.addEventListener('pointerdown', function (e) {
        dragging = true;
        try { elem.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        handler(e);
      });
      elem.addEventListener('pointermove', function (e) { if (dragging) handler(e); });
      function end(e) { dragging = false; try { elem.releasePointerCapture(e.pointerId); } catch (err) {} }
      elem.addEventListener('pointerup', end);
      elem.addEventListener('pointercancel', end);
    }
    installDrag(cpHue, function (e) { cpSetFromHsv(cpHueFromPoint(e.clientX, e.clientY), cpHsv.s, cpHsv.v); });
    installDrag(cpSquare, function (e) { var sv = cpSvFromPoint(e.clientX, e.clientY); cpSetFromHsv(cpHsv.h, sv.s, sv.v); });

    if (cpHex) {
      cpHex.addEventListener('input', function () { cpSetFromHex(cpHex.value); });
    }

    function enterPickerMode() { appEl.setAttribute('data-colorpicker', 'open'); }
    function exitPickerMode() { appEl.removeAttribute('data-colorpicker'); cpMode = null; }

    // Open the picker for 'bg' or 'text'. Snapshot the preview's current override for that var
    // (so Back restores it exactly), seed the picker to the remembered custom color (or the
    // current active color when there's no remembered one), pre-reflect it, and take over.
    function openColorPicker(mode) {
      cpMode = mode;
      var s = lastSettings || {};
      var activeHex = mode === 'text' ? s.textColor : s.bgColor;
      var rememberedHex = mode === 'text' ? s.customTextColor : s.customBgColor;
      cpPreviewSnapshot = previewPill ? previewPill.style.getPropertyValue(cpVarName()) : '';
      if (cpTitle) cpTitle.textContent = mode === 'text' ? 'Choose text color' : 'Choose background color';
      drawHueRing();
      var seed = parseHexColor(rememberedHex) ? rememberedHex : activeHex;
      if (!cpSetFromHex(seed)) cpSetFromHex('#000000');
      enterPickerMode();
    }
    // Restore the preview override to the open-time snapshot (used by Back + panel close).
    function revertPickerPreview() {
      if (!previewPill) return;
      if (cpPreviewSnapshot) previewPill.style.setProperty(cpVarName(), cpPreviewSnapshot);
      else previewPill.style.removeProperty(cpVarName());
    }

    if (bgPickerTile) {
      bgPickerTile.addEventListener('click', function (e) { e.stopPropagation(); openColorPicker('bg'); });
    }
    if (textPickerTile) {
      textPickerTile.addEventListener('click', function (e) {
        e.stopPropagation();
        if (textPickerTile.disabled) return; // cutout mode ignores the text color -> picker disabled too
        openColorPicker('text');
      });
    }

    // Save commits the picked color to the REAL widget: bgColor/textColor = the hex AND
    // customBgColor/customTextColor = that hex (so the picker swatch keeps showing it). Clearing
    // the preview override lets the preview follow the committed :root var (same hex). Two onSelect
    // calls mirror the Font tab's customFont+useCustomFont commit.
    cpSave.addEventListener('click', function (e) {
      e.stopPropagation();
      var hex = cpCurrentHex();
      var key = cpSettingKey(), customKey = cpCustomKey();
      if (previewPill) previewPill.style.removeProperty(cpVarName());
      exitPickerMode();
      onSelect(key, hex);
      onSelect(customKey, hex);
    });

    // Back cancels — no commit — and reverts the preview to the previously-active color.
    cpBack.addEventListener('click', function (e) {
      e.stopPropagation();
      revertPickerPreview();
      exitPickerMode();
    });

    // Toggle a picker tile's selected state (no data-setting, so markSelectedInGroup skips it).
    function setPickerSelected(tile, on) {
      if (!tile) return;
      tile.classList.toggle('is-selected', !!on);
      tile.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // Reflect one color group: when the ACTIVE color is a preset, highlight that preset tile;
    // otherwise a custom color is active -> highlight the picker tile and no preset.
    function reflectColorGroup(key, value, presets, pickerTile) {
      var isPreset = presets.indexOf(value) !== -1;
      markSelectedInGroup(key, isPreset ? value : null); // null matches no preset -> all off
      setPickerSelected(pickerTile, !isPreset);
    }

    // The picker swatch ALWAYS shows the remembered custom color (even while a preset is active),
    // so it previews what you'd switch back to. Empty ('') -> the neutral .is-empty hint.
    function updatePickerSwatch(tile, hex) {
      if (!tile) return;
      var chip = tile.querySelector('.swatch-chip');
      if (!chip) return;
      var has = !!parseHexColor(hex);
      chip.classList.toggle('is-empty', !has);
      if (tile === textPickerTile) { chip.style.color = has ? hex : ''; }
      else { chip.style.background = has ? hex : ''; }
    }

    // --- per-tile sample fit (so a wide glyph never bleeds past its card) -------
    // Each curated tile (and the Custom tile) shows a "10:42" sample in its OWN face, and
    // faces vary wildly in width, so a sample sized by CSS alone overflows the narrow cards
    // for the wide ones (System/Serif/Helvetica were bleeding past the edges). We measure
    // each sample at its (responsive) CSS size and shrink its font-size just enough to sit
    // inside the card with ~SAMPLE_PAD of breathing room on every side — the same measure-
    // and-scale idea the live preview / main face use, applied per tile. We only ever
    // SHRINK (never enlarge past the CSS size), so a bigger panel -> bigger CSS base ->
    // bigger sample that is still fit-contained (feature D). Idempotent.
    var SAMPLE_PAD = 10;          // px breathing room inside each tile
    var lastSampleFitW = -1;      // last grid width we fit at (RO loop guard)
    function fitSampleIn(card) {
      var swatch = card.querySelector('.font-swatch');
      if (!swatch) return;
      swatch.style.fontSize = ''; // measure at the CSS (responsive) base, not a prior fit
      if (!card.clientWidth || !card.clientHeight) return; // hidden tab -> nothing to fit yet
      var cs = root.getComputedStyle ? root.getComputedStyle(swatch) : null;
      var base = cs ? parseFloat(cs.fontSize) : 0;
      if (!base) return;
      var caption = card.querySelector('.option-caption');
      var capH = caption ? caption.offsetHeight : 0;
      var natW = swatch.offsetWidth, natH = swatch.offsetHeight;
      var availW = card.clientWidth - SAMPLE_PAD * 2;
      var availH = card.clientHeight - capH - SAMPLE_PAD * 2;
      if (natW <= 0 || natH <= 0 || availW <= 0 || availH <= 0) return;
      var scale = Math.min(availW / natW, availH / natH, 1); // shrink-only
      if (scale < 1) swatch.style.fontSize = (base * scale) + 'px';
    }
    // Fit every Font-tab sample. `force` re-fits even at an unchanged width (used when the
    // sample FAMILY changed, e.g. reflect() repainting the Custom tile); the RO path passes
    // false so a mere height change (tab switch / sample resize) can't drive a refit loop.
    function fitFontSwatches(force) {
      var grid = panel.querySelector('#panel-font .option-grid');
      if (!grid) return;
      var w = grid.clientWidth;
      if (!w) return;                              // Font tab hidden -> skip (re-run on activate)
      if (!force && w === lastSampleFitW) return;  // width unchanged -> nothing to redo
      lastSampleFitW = w;
      var cards = grid.querySelectorAll('.option-font');
      Array.prototype.forEach.call(cards, fitSampleIn);
    }

    // --- open / close (notifies onToggle so main can grow/restore the window) ---
    function setOpen(open, silent) {
      // Closing always leaves Choose-font mode, so reopening starts clean on the
      // normal Font tab rather than mid-browse. If we were mid-browse, also drop the
      // deferred preview override (same as Back) so a reopened panel never shows a
      // browsed-but-uncommitted font on the preview clock.
      if (!open) {
        if (appEl.getAttribute('data-fontbrowser') === 'open') setPreviewFont(previewFontSnapshot);
        // Mid color-pick when closing -> revert the preview (same as Back) so a reopened panel
        // never shows an uncommitted color, and leave picker mode.
        if (appEl.getAttribute('data-colorpicker') === 'open') { revertPickerPreview(); exitPickerMode(); }
        exitChooseMode();
      }
      appEl.setAttribute('data-settings', open ? 'open' : 'closed');
      if (!silent) onToggle(open);
    }
    function isOpen() { return appEl.getAttribute('data-settings') === 'open'; }
    function open() { setOpen(true); }
    function close() { setOpen(false); }
    function toggle() { setOpen(!isOpen()); }
    setOpen(false, true); // initial state, silent (don't poke main before any open)

    closeBtn.addEventListener('click', close);

    // --- tab switching ---
    function activateTab(tabId) {
      tabButtons.forEach(function (b) {
        var on = b.getAttribute('data-tab') === tabId;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      TAB_IDS.forEach(function (id) {
        var p = document.getElementById('panel-' + id);
        if (p) p.classList.toggle('is-active', id === tabId);
      });
      // The Font tab's tiles have no measurable box until the tab is visible, so fit the
      // samples the moment it activates. We toggled display:block synchronously just above
      // and fitSampleIn forces a layout read (offsetWidth), so a SYNCHRONOUS fit already has
      // real geometry — and it must be synchronous, since under a frozen test clock an rAF
      // would never fire. The extra rAF only helps the real app re-settle after any async
      // relayout; it's a harmless no-op when rAF is faked/paused.
      if (tabId === 'font') {
        fitFontSwatches(true);
        if (root.requestAnimationFrame) root.requestAnimationFrame(function () { fitFontSwatches(true); });
      }
    }
    tabNav.addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (tab) activateTab(tab.getAttribute('data-tab'));
    });

    // Responsive samples (feature D): refit when the panel changes width (the settings
    // window is resizable). Width-gated inside fitFontSwatches so a height change (tab
    // switch, a sample resizing) can't feed back into a refit loop.
    if (typeof root.ResizeObserver === 'function') {
      try {
        var sampleRO = new root.ResizeObserver(function () { fitFontSwatches(false); });
        sampleRO.observe(panels);
      } catch (e) { /* non-fatal: samples still fit on tab-activate + reflect */ }
    }

    // --- option selection (event delegation over the whole panel body) ---
    panels.addEventListener('click', function (e) {
      var opt = e.target.closest ? e.target.closest('.option') : null;
      if (!opt) return;
      var key = opt.getAttribute('data-setting');
      // The Custom tile is an .option with NO data-setting; it opens the system-font
      // browser (handled by its own listener), not an enum selection — skip it here.
      if (!key) return;
      var value = opt.getAttribute('data-value');
      markSelectedInGroup(key, value); // snappy optimistic highlight
      // Choosing a curated font de-selects the Custom tile optimistically (the round-trip
      // reflect() will confirm it once useCustomFont flips off below).
      if (key === 'font') setCustomSelected(false);
      // Choosing a color PRESET de-selects that grid's picker tile optimistically. It does NOT
      // touch customBgColor/customTextColor (only this one key is sent), so the picker swatch
      // keeps showing the remembered custom color.
      if (key === 'bgColor') setPickerSelected(bgPickerTile, false);
      if (key === 'textColor') setPickerSelected(textPickerTile, false);
      onSelect(key, value);
      // Choosing from the curated grid steps the custom override aside — otherwise the
      // curated pick would be invisible (the active font prefers an installed customFont).
      // We flip useCustomFont OFF (making the curated picker authoritative) but LEAVE
      // customFont REMEMBERED, so the Custom tile still shows / can restore that family.
      if (key === 'font') onSelect('useCustomFont', false);
    });

    // --- opacity sliders (continuous, so not tile groups) ---
    // Both persist + apply live through the SAME onSelect(key, value) path the rest of
    // the panel uses, so they go through the usual IPC/localStorage normalization.
    // bgOpacitySlider -> `opacity` (--pill-opacity); textOpacitySlider -> `textOpacity`.
    var bgOpacitySlider = panel.querySelector('#opacity-slider');
    if (bgOpacitySlider) {
      bgOpacitySlider.addEventListener('input', function () {
        onSelect('opacity', Number(bgOpacitySlider.value));
      });
    }
    var textOpacitySlider = panel.querySelector('#text-opacity-slider');
    if (textOpacitySlider) {
      textOpacitySlider.addEventListener('input', function () {
        onSelect('textOpacity', Number(textOpacitySlider.value));
      });
    }

    // --- cutout checkbox (knockout mode) ---------------------------------------
    // Persists `cutout` through the SAME onSelect path as everything else, so it live-
    // applies to THIS window's preview AND broadcasts to the real pill (Pass H). The
    // text-color swatches are greyed/disabled while it's ON (they don't apply in cutout
    // mode); the text-opacity slider stays active as the strength control.
    var cutoutCheckbox = panel.querySelector('#cutout-checkbox');
    if (cutoutCheckbox) {
      cutoutCheckbox.addEventListener('change', function () {
        onSelect('cutout', !!cutoutCheckbox.checked);
      });
    }

    // Grey out + disable the TEXT-color swatches (cutout ignores the text color). A disabled
    // button also can't fire the delegated option-select click, so a greyed swatch is inert.
    // The bg swatches, both opacity sliders and everything else stay active.
    function setTextSwatchesDisabled(on) {
      var swatches = panel.querySelectorAll('.option[data-setting="textColor"]');
      Array.prototype.forEach.call(swatches, function (o) {
        o.disabled = !!on;
        o.classList.toggle('is-disabled', !!on);
        o.setAttribute('aria-disabled', on ? 'true' : 'false');
      });
      // The text PICKER swatch has no data-setting, so grey/disable it here too (cutout ignores
      // the text color, so mixing a custom one makes no sense in knockout mode).
      if (textPickerTile) {
        textPickerTile.disabled = !!on;
        textPickerTile.classList.toggle('is-disabled', !!on);
        textPickerTile.setAttribute('aria-disabled', on ? 'true' : 'false');
      }
    }

    // (Float-on-top lives in the Electron menu-bar tray now, not a tab.)

    // Mark exactly one option as selected within a data-setting group.
    function markSelectedInGroup(key, value) {
      var opts = panel.querySelectorAll('.option[data-setting="' + key + '"]');
      Array.prototype.forEach.call(opts, function (o) {
        var on = o.getAttribute('data-value') === value;
        o.classList.toggle('is-selected', on);
        o.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    // reflect(settings) — sync every group's highlight + the slider to live settings.
    function reflect(settings) {
      if (!settings) return;
      lastSettings = settings;
      markSelectedInGroup('layout', settings.layout);

      // Colors: the active bg/text color may be a preset OR a custom (picked) hex. A preset
      // highlights its tile; a custom color highlights the picker tile instead. The picker
      // swatch always shows the REMEMBERED custom color, independent of which tile is selected.
      reflectColorGroup('bgColor', settings.bgColor, schema.BG_COLORS, bgPickerTile);
      reflectColorGroup('textColor', settings.textColor, schema.TEXT_COLORS, textPickerTile);
      updatePickerSwatch(bgPickerTile, settings.customBgColor);
      updatePickerSwatch(textPickerTile, settings.customTextColor);

      // Font selection is split between the curated grid and the Custom tile. The TRUE
      // active face decides which is highlighted: when the custom font is actually active
      // (customFont non-empty AND installed), the Custom tile is the selected one and NO
      // curated tile is selected; otherwise the curated tile for settings.font is selected.
      var info = settingsMod.activeFontInfo ? settingsMod.activeFontInfo(settings) : { customActive: false, family: '' };
      if (info && info.customActive) {
        markSelectedInGroup('font', null); // null matches no curated tile -> all de-selected
        setCustomSelected(true);
      } else {
        markSelectedInGroup('font', settings.font);
        setCustomSelected(false);
      }

      // The Custom tile's SAMPLE is independent of which tile is selected: it ALWAYS
      // renders in the remembered customFont family when that family is actually
      // installed — even while a curated preset is the active font — so the tile keeps
      // previewing what you'd get by switching back to it. Only when there is no
      // remembered family (or it isn't installed) does it fall back to a neutral system
      // stack (never a blank/bogus face). Label stays literally "Custom".
      if (customSwatch) {
        var remembered = settings && typeof settings.customFont === 'string' ? settings.customFont.trim() : '';
        var showCustom = remembered && settingsMod.fontAvailable && settingsMod.fontAvailable(remembered);
        customSwatch.style.fontFamily = showCustom
          ? cssQuoteFamily(remembered) + ', ' + settingsMod.fontFamilyFor('system')
          : settingsMod.fontFamilyFor('system');
      }
      // The sample font-family just changed, so re-fit every tile sample to its card.
      fitFontSwatches(true);

      // Don't fight the user mid-drag: only sync a slider when it isn't the focused one.
      if (bgOpacitySlider && document.activeElement !== bgOpacitySlider) {
        bgOpacitySlider.value = String(settings.opacity);
      }
      if (textOpacitySlider && document.activeElement !== textOpacitySlider) {
        textOpacitySlider.value = String(settings.textOpacity);
      }

      // Cutout checkbox + the dependent greying of the text-color swatches.
      var cutoutOn = settings.cutout === true;
      if (cutoutCheckbox) cutoutCheckbox.checked = cutoutOn;
      setTextSwatchesDisabled(cutoutOn);
    }

    return { reflect: reflect, open: open, close: close, toggle: toggle, isOpen: isOpen, activateTab: activateTab };
  }

  root.EpisodeTimerSettingsPanel = { init: init };
}(typeof self !== 'undefined' ? self : this));
