// src/renderer/settings-panel.js
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

  function buildColorsPanel() {
    // BACKGROUND swatches: a solid chip of the color.
    var bgGrid = el('div', { class: 'option-grid swatch-grid' });
    schema.BG_COLORS.forEach(function (color) {
      var chip = option('bgColor', color, 'option-swatch', el('span', { class: 'swatch-chip' }));
      chip.querySelector('.swatch-chip').style.background = color;
      bgGrid.appendChild(chip);
    });

    // TEXT swatches: a sample glyph painted in the color (on a neutral chip).
    var textGrid = el('div', { class: 'option-grid swatch-grid' });
    schema.TEXT_COLORS.forEach(function (color) {
      var chip = option('textColor', color, 'option-swatch', el('span', { class: 'swatch-chip swatch-text', text: 'A' }));
      chip.querySelector('.swatch-chip').style.color = color;
      textGrid.appendChild(chip);
    });

    // Two opacity sliders, each sitting directly UNDER its own swatch grid:
    //   - background opacity drives --pill-opacity (the EXISTING `opacity` setting),
    //     so it can slide to 0 for a fully see-through pill.
    //   - text opacity drives --text-opacity (the NEW `textOpacity` setting), fading
    //     the numerals to invisible at 0.
    // Each section is a shrink-wrapped, centered block (.color-section) so the slider
    // ends up exactly as wide as the swatch grid above it (see styles.css).
    var bgSlider = opacitySlider('opacity-slider', 'Background opacity');
    var textSlider = opacitySlider('text-opacity-slider', 'Text opacity');

    var bgSection = el('div', { class: 'color-section' }, [
      el('h3', { class: 'settings-section', text: 'Background' }),
      bgGrid,
      el('div', { class: 'slider-row' }, [bgSlider])
    ]);
    var textSection = el('div', { class: 'color-section' }, [
      el('h3', { class: 'settings-section', text: 'Text color' }),
      textGrid,
      el('div', { class: 'slider-row' }, [textSlider])
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
    var panel = el('div', { id: 'settings-panel', role: 'dialog', 'aria-label': 'Widget settings' }, [header, buildPreview(), tabNav, fontBrowser, panels]);
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
      fbGrid.scrollTop = 0;

      // Pre-highlight the active custom font if it's in the list, so Save without a
      // fresh pick is a harmless no-op rather than a surprise.
      selectedFamily = (lastSettings && lastSettings.customFont) ? lastSettings.customFont : '';
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
      if (selectedFamily) onSelect('customFont', selectedFamily);
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

    // --- open / close (notifies onToggle so main can grow/restore the window) ---
    function setOpen(open, silent) {
      // Closing always leaves Choose-font mode, so reopening starts clean on the
      // normal Font tab rather than mid-browse. If we were mid-browse, also drop the
      // deferred preview override (same as Back) so a reopened panel never shows a
      // browsed-but-uncommitted font on the preview clock.
      if (!open) {
        if (appEl.getAttribute('data-fontbrowser') === 'open') setPreviewFont(previewFontSnapshot);
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
    }
    tabNav.addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (tab) activateTab(tab.getAttribute('data-tab'));
    });

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
      // reflect() will confirm it once customFont is cleared below).
      if (key === 'font') setCustomSelected(false);
      onSelect(key, value);
      // Choosing from the curated grid means any custom override steps aside —
      // otherwise the curated pick would be invisible (the active font prefers an
      // installed customFont). Clearing it makes the curated picker authoritative.
      if (key === 'font') onSelect('customFont', '');
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
      ['layout', 'bgColor', 'textColor'].forEach(function (key) {
        markSelectedInGroup(key, settings[key]);
      });

      // Font selection is split between the curated grid and the Custom tile. The TRUE
      // active face decides which is highlighted: when the custom font is actually active
      // (customFont non-empty AND installed), the Custom tile is the selected one and NO
      // curated tile is selected; otherwise the curated tile for settings.font is selected.
      var info = settingsMod.activeFontInfo ? settingsMod.activeFontInfo(settings) : { customActive: false, family: '' };
      if (info && info.customActive) {
        markSelectedInGroup('font', null); // null matches no curated tile -> all de-selected
        setCustomSelected(true);
        // The Custom tile's sample renders in the active custom font (label stays "Custom").
        if (customSwatch) customSwatch.style.fontFamily = info.family;
      } else {
        markSelectedInGroup('font', settings.font);
        setCustomSelected(false);
        // No custom font active -> show the sample in a neutral system stack (never blank).
        if (customSwatch) customSwatch.style.fontFamily = settingsMod.fontFamilyFor('system');
      }

      // Don't fight the user mid-drag: only sync a slider when it isn't the focused one.
      if (bgOpacitySlider && document.activeElement !== bgOpacitySlider) {
        bgOpacitySlider.value = String(settings.opacity);
      }
      if (textOpacitySlider && document.activeElement !== textOpacitySlider) {
        textOpacitySlider.value = String(settings.textOpacity);
      }
    }

    return { reflect: reflect, open: open, close: close, toggle: toggle, isOpen: isOpen, activateTab: activateTab };
  }

  root.EpisodeTimerSettingsPanel = { init: init };
}(typeof self !== 'undefined' ? self : this));
