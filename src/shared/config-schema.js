// src/shared/config-schema.js
// -----------------------------------------------------------------------------
// The single source of truth for the config file's shape, defaults and
// validation. Lives in /shared so the Electron main process, the renderer's
// browser-mode fallback, and the unit tests all agree byte-for-byte (PLAN D14).
//
// The golden rule: normalizeConfig(anything) ALWAYS returns a complete, valid
// config. Missing file, half-written file, hand-edited garbage, an array, a
// string, null — all collapse to sensible defaults. Never throw, never crash.
//
// Depends on stopwatch.fromPersisted() for the `timer` sub-object, so load
// order matters: stopwatch.js must come before this file in index.html.
//
// UMD wrapper (PLAN D2): classic <script> -> window.EpisodeTimerConfigSchema,
// and require() in Node/Electron/tests.
// -----------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./stopwatch'));
  } else {
    root.EpisodeTimerConfigSchema = factory(root.EpisodeTimerStopwatch);
  }
}(typeof self !== 'undefined' ? self : this, function (stopwatch) {
  'use strict';

  var SCHEMA_VERSION = 1;

  // --- the click-to-select option catalogs (single source of truth) ----------
  // The settings panel renders tiles from these exact lists, and normalize*()
  // validates against them, so the UI and the schema can never drift apart.

  // LAYOUT — how the two readouts are arranged. Driven by #app[data-layout].
  // 'stack' is the original look (clock stacked over stopwatch).
  var LAYOUTS = [
    'stack', // clock over stopwatch (default / original)
    'stopwatch-top', // stopwatch over clock
    'clock-left', // clock · stopwatch (row, dot separator + spacing)
    'side-by-side', // clock  stopwatch (row, no separator)
    'split', // clock left (big) | stopwatch right (small), spread apart
    'one-line', // single compact inline row, both small
    'dash', // clock – stopwatch, vertical with a dash between
    'clock-hero', // big clock, small stopwatch beneath
    'stopwatch-hero', // big stopwatch, small clock beneath
    'centered-gap' // clock over stopwatch with extra breathing room
  ];

  // FONT — system / web-safe stacks ONLY (no external or CDN fonts, so the
  // widget stays fully offline/self-contained). Keyword -> CSS stack mapping
  // lives in settings-apply.js (presentation); this is just the allow-list.
  // NOTE: 'courier' was removed (Mono already covers monospace), leaving 9 curated
  // presets. A saved config carrying the dropped font:'courier' is not in this list,
  // so pickEnum() normalizes it to the default 'system' via the existing enum fallback
  // (no migration needed — the same safety net that catches any unknown/hand-edited value).
  var FONTS = [
    'system', 'mono', 'serif', 'helvetica',
    'times', 'trebuchet', 'verdana', 'palatino', 'condensed'
  ];

  // BACKGROUND colors (the pill). The existing `opacity` setting still controls
  // translucency; this is just the base color. First entry is the default
  // (black -> the original dark pill).
  var BG_COLORS = [
    '#000000', '#1a1a2e', '#0f3d3e', '#2d132c', '#1b2a4a',
    '#3a2d1b', '#2c2c2c', '#004e64', '#f5f5dc', '#ffffff'
  ];

  // TEXT colors (the numerals + labels). First entry is the default (white).
  var TEXT_COLORS = [
    '#ffffff', '#f0f0f0', '#e0e0e0', '#111111', '#f5c518',
    '#ffd166', '#4ade80', '#60a5fa', '#a78bfa', '#ff6b6b'
  ];

  // customFont — a SEPARATE field from `font` (the curated enum). It holds an
  // arbitrary system font-family name the user picked via the Font tab's system-
  // font browser (queryLocalFonts), or '' for "none / use the curated font". We
  // deliberately do NOT overload `font` with it: `font` is a strict enum that
  // COERCES anything unknown back to the default, so an arbitrary family could
  // never survive there. The renderer decides the ACTIVE font = customFont when
  // it's non-empty AND actually installed on this machine, else the curated
  // fontFamilyFor(font). The schema runs in the MAIN process (no DOM), so it can
  // only keep customFont type-safe — the real "is it installed?" availability
  // check lives in the renderer's applySettings() (see settings-apply.js).
  var MAX_CUSTOM_FONT = 120; // sane cap on a font-family name (CSS names are short)

  // The settings the app reads/applies/persists. Every one is wired end to end
  // (read + apply + writable over IPC / localStorage); the tabbed panel is the
  // v2 UI over exactly these keys.
  // textOpacity sits beside opacity on purpose: opacity is the pill BACKGROUND's
  // alpha, textOpacity is the TEXT color's alpha — two independent translucency
  // controls (the Colors tab shows one under each swatch grid).
  var SETTINGS_KEYS = ['layout', 'font', 'customFont', 'bgColor', 'textColor', 'opacity', 'textOpacity', 'showSeconds', 'hour12', 'alwaysOnTop', 'showClock', 'showStopwatch'];

  // DEFAULT_CONFIG — note window has no x/y on a fresh install; window-state.js
  // lets the OS pick a sensible first position (and clamps it on later restores).
  // The settings defaults reproduce the ORIGINAL look (black pill, white text,
  // stacked layout, system font).
  var DEFAULT_CONFIG = {
    schemaVersion: SCHEMA_VERSION,
    window: { width: 240, height: 130 },
    timer: { status: 'stopped', accumulatedMs: 0, runningSince: null },
    settings: {
      layout: 'stack', // arrangement of the two readouts (see LAYOUTS)
      font: 'system', // one of FONTS (the curated picker)
      customFont: '', // '' = none; else an arbitrary installed family name (system-font browser)
      bgColor: '#000000', // pill base color (one of BG_COLORS)
      textColor: '#ffffff', // numeral/label color (one of TEXT_COLORS)
      opacity: 1.0, // pill background alpha, 0..1 (solid pill by default; lower in config.json for see-through)
      textOpacity: 1.0, // numeral/label alpha, 0..1 (fully opaque by default; 0 = invisible text)
      showSeconds: false, // wall clock HH:MM:SS instead of HH:MM
      hour12: true, // false -> 24-hour, meridiem hidden
      alwaysOnTop: true, // main-side window level
      showClock: true, // show the wall clock readout (toggled from the tray)
      showStopwatch: true // show the episode stopwatch readout (toggled from the tray)
    }
  };

  // Minimum window size — mirrors BrowserWindow's minWidth/minHeight in main.js.
  // Lowered so the host can shrink the widget much smaller than before. These
  // feed BrowserWindow.minWidth/minHeight, the on-screen clamp, and the grip's
  // resize-by. MIN_HEIGHT was dropped to ~1/3 (60 -> 20) so the pill can become a
  // thin one-line strip. macOS enforces its own small floor underneath this (a
  // frameless window won't actually go below ~a couple dozen px), which is fine.
  var MIN_WIDTH = 100;
  var MIN_HEIGHT = 20;

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // migrate(raw) — bring an older file up to the current shape, or reject one
  // we can't understand. Today there are no older versions to upgrade, so the
  // only real work is the guard: a file stamped with an unknown/newer version
  // (e.g. a v99 config written by a future build, or a bogus number) can't be
  // interpreted safely, so we discard it and start from defaults.
  //
  // A file with NO schemaVersion is treated as current (a pre-versioning or
  // partial file) and just gets its missing fields filled in downstream.
  function migrate(raw) {
    if (!isPlainObject(raw)) return raw;
    var v = raw.schemaVersion;
    if (v === undefined || v === null) return raw; // unversioned -> treat as current
    switch (v) {
      case SCHEMA_VERSION:
        return raw; // current — nothing to migrate
      // case 0: return upgradeV0toV1(raw); /* future older-version upgrades land here */
      default:
        // From the future (or just garbage): we don't know its fields. Rather
        // than keep stale/foreign settings, collapse to a clean default config.
        return clone(DEFAULT_CONFIG);
    }
  }

  // Validate the window sub-object. width/height are always honored (clamped to
  // the minimum); x/y are only kept if finite (window-state.js does the real
  // on-screen clamping against live displays).
  function normalizeWindow(raw) {
    var def = DEFAULT_CONFIG.window;
    var out = {};
    out.width = isFiniteNumber(raw && raw.width) ? Math.max(MIN_WIDTH, Math.round(raw.width)) : def.width;
    out.height = isFiniteNumber(raw && raw.height) ? Math.max(MIN_HEIGHT, Math.round(raw.height)) : def.height;
    if (raw && isFiniteNumber(raw.x)) out.x = Math.round(raw.x);
    if (raw && isFiniteNumber(raw.y)) out.y = Math.round(raw.y);
    return out;
  }

  // Pick an enum value if it's in the allow-list, else fall back to default.
  function pickEnum(value, allowed, fallback) {
    return allowed.indexOf(value) !== -1 ? value : fallback;
  }

  // customFont is free-form text (a family name), so it can't be an enum. Keep it
  // type-safe: a trimmed non-empty string within the cap, otherwise '' (= none).
  // Anything that isn't a reasonable family name (not a string, empty/whitespace,
  // or absurdly long) collapses to '' rather than poisoning the config.
  function normalizeCustomFont(value) {
    if (typeof value !== 'string') return '';
    var s = value.trim();
    if (s.length === 0 || s.length > MAX_CUSTOM_FONT) return '';
    return s;
  }

  // Validate the settings sub-object field-by-field. Unknown keys are dropped
  // (we only ever copy the SETTINGS_KEYS). Bad values fall back to default.
  function normalizeSettings(raw) {
    var def = DEFAULT_CONFIG.settings;
    raw = isPlainObject(raw) ? raw : {};
    var out = {};

    // enums: layout / font / colors — unknown value -> default.
    out.layout = pickEnum(raw.layout, LAYOUTS, def.layout);
    out.font = pickEnum(raw.font, FONTS, def.font);
    out.customFont = normalizeCustomFont(raw.customFont); // free-form family or ''
    out.bgColor = pickEnum(raw.bgColor, BG_COLORS, def.bgColor);
    out.textColor = pickEnum(raw.textColor, TEXT_COLORS, def.textColor);

    // opacity: clamp into [0, 1].
    if (isFiniteNumber(raw.opacity)) {
      out.opacity = Math.min(1, Math.max(0, raw.opacity));
    } else {
      out.opacity = def.opacity;
    }

    // textOpacity: same contract as opacity — a finite number clamped into [0, 1],
    // anything else -> default (1.0, today's fully-opaque look).
    if (isFiniteNumber(raw.textOpacity)) {
      out.textOpacity = Math.min(1, Math.max(0, raw.textOpacity));
    } else {
      out.textOpacity = def.textOpacity;
    }

    // the three booleans.
    out.showSeconds = typeof raw.showSeconds === 'boolean' ? raw.showSeconds : def.showSeconds;
    out.hour12 = typeof raw.hour12 === 'boolean' ? raw.hour12 : def.hour12;
    out.alwaysOnTop = typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : def.alwaysOnTop;
    out.showClock = typeof raw.showClock === 'boolean' ? raw.showClock : def.showClock;
    out.showStopwatch = typeof raw.showStopwatch === 'boolean' ? raw.showStopwatch : def.showStopwatch;

    return out;
  }

  // normalizeConfig(raw) -> always a complete, valid config object.
  function normalizeConfig(raw) {
    raw = migrate(raw);
    if (!isPlainObject(raw)) raw = {}; // null / 'junk' / [] / undefined -> defaults

    return {
      schemaVersion: SCHEMA_VERSION, // always stamp the current version
      window: normalizeWindow(raw.window),
      timer: stopwatch.fromPersisted(raw.timer), // applies restore-as-paused (D6)
      settings: normalizeSettings(raw.settings)
    };
  }

  // Is a supplied patch value actually valid for its key? (Used to decide which
  // keys survive a partial patch.) opacity accepts any finite number — it gets
  // clamped — but a garbage value like '#zzz' for a color is simply dropped so
  // a misbehaving caller can't silently reset a setting to its default.
  function patchValueValid(key, value) {
    switch (key) {
      case 'layout': return LAYOUTS.indexOf(value) !== -1;
      case 'font': return FONTS.indexOf(value) !== -1;
      // A string within the cap (including '' to clear it). An over-long or
      // non-string value is dropped from a patch (not coerced), so a misbehaving
      // caller can't silently wipe the user's chosen family.
      case 'customFont': return typeof value === 'string' && value.trim().length <= MAX_CUSTOM_FONT;
      case 'bgColor': return BG_COLORS.indexOf(value) !== -1;
      case 'textColor': return TEXT_COLORS.indexOf(value) !== -1;
      case 'opacity': return isFiniteNumber(value);
      case 'textOpacity': return isFiniteNumber(value); // any finite number — gets clamped (same as opacity)
      case 'showSeconds':
      case 'hour12':
      case 'alwaysOnTop':
      case 'showClock':
      case 'showStopwatch': return typeof value === 'boolean';
      default: return false; // unknown key
    }
  }

  // Validate just a partial settings patch (used by config:set-settings). Only
  // known keys with VALID supplied values survive; unknown keys and keys whose
  // value is garbage are dropped (not coerced to default). The surviving values
  // are normalized (e.g. opacity clamped).
  function normalizeSettingsPatch(raw) {
    if (!isPlainObject(raw)) return {};
    var merged = normalizeSettings(raw);
    var patch = {};
    for (var i = 0; i < SETTINGS_KEYS.length; i++) {
      var k = SETTINGS_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(raw, k) && patchValueValid(k, raw[k])) {
        patch[k] = merged[k];
      }
    }
    return patch;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SETTINGS_KEYS: SETTINGS_KEYS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    MIN_WIDTH: MIN_WIDTH,
    MIN_HEIGHT: MIN_HEIGHT,
    MAX_CUSTOM_FONT: MAX_CUSTOM_FONT,
    // option catalogs — the panel renders tiles straight from these.
    LAYOUTS: LAYOUTS,
    FONTS: FONTS,
    BG_COLORS: BG_COLORS,
    TEXT_COLORS: TEXT_COLORS,
    migrate: migrate,
    normalizeConfig: normalizeConfig,
    normalizeSettings: normalizeSettings,
    normalizeSettingsPatch: normalizeSettingsPatch,
    clone: clone
  };
}));
