// source/electron/window-state.js
// -----------------------------------------------------------------------------
// Window bounds persistence + the "never opens off-screen" clamp (PLAN D15).
//
//   restoreBounds(config, defaults) -> { width, height, x?, y? }
//       Size is always honored (clamped to minimums). Position is only used if
//       the saved rectangle still lands meaningfully on a CONNECTED display's
//       work area — monitors come and go, so a saved spot on a now-unplugged
//       external screen would otherwise open the widget into the void.
//
//   trackBounds(win, config)
//       Debounced 'moved'/'resized' listeners that write the live bounds back
//       into config.window (position AND size).
// -----------------------------------------------------------------------------
'use strict';

var schema = require('../app/shared/config-schema');

// `screen` can only be required after app 'ready'. We require it lazily so this
// module is importable (and node --check-able) outside a running Electron app.
function getScreen() { return require('electron').screen; }

function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }

// Area of the overlap between two rectangles ({x,y,width,height}). 0 if disjoint.
function intersectionArea(a, b) {
  var x1 = Math.max(a.x, b.x);
  var y1 = Math.max(a.y, b.y);
  var x2 = Math.min(a.x + a.width, b.x + b.width);
  var y2 = Math.min(a.y + a.height, b.y + b.height);
  var w = x2 - x1;
  var h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

// Nudge a rectangle fully inside a work area (keeping its size).
function slideInside(rect, area) {
  var x = rect.x;
  var y = rect.y;
  // If it's wider/taller than the work area, just pin to the top-left corner.
  x = Math.min(Math.max(x, area.x), area.x + area.width - rect.width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - rect.height);
  if (!isFinite(x) || x < area.x) x = area.x;
  if (!isFinite(y) || y < area.y) y = area.y;
  return { x: Math.round(x), y: Math.round(y) };
}

// restoreBounds(config, defaults, opts) -> { width, height, x?, y? }
//   opts.key       : the config key holding the saved bounds (default 'window';
//                    the separate settings window passes 'settingsWindow').
//   opts.minWidth  : size floor (default schema.MIN_WIDTH).
//   opts.minHeight : size floor (default schema.MIN_HEIGHT).
function restoreBounds(config, defaults, opts) {
  defaults = defaults || { width: 240, height: 130 };
  opts = opts || {};
  var key = opts.key || 'window';
  var minW = isFiniteNumber(opts.minWidth) ? opts.minWidth : schema.MIN_WIDTH;
  var minH = isFiniteNumber(opts.minHeight) ? opts.minHeight : schema.MIN_HEIGHT;
  var saved = (config && config.get(key)) || {};

  // Size: always restored, clamped to the minimums.
  var width = isFiniteNumber(saved.width) ? Math.max(minW, Math.round(saved.width)) : defaults.width;
  var height = isFiniteNumber(saved.height) ? Math.max(minH, Math.round(saved.height)) : defaults.height;

  var bounds = { width: width, height: height };

  // Position: only if we have finite x/y. Otherwise omit x/y so the OS centers
  // the window on the primary display (first run, or a wiped position).
  if (!isFiniteNumber(saved.x) || !isFiniteNumber(saved.y)) {
    return bounds;
  }

  var rect = { x: Math.round(saved.x), y: Math.round(saved.y), width: width, height: height };

  var screen;
  try {
    screen = getScreen();
  } catch (e) {
    // No screen API (not ready / not Electron): trust the saved position.
    bounds.x = rect.x;
    bounds.y = rect.y;
    return bounds;
  }

  // Which display does the saved rect belong to? getDisplayMatching picks the
  // display with the largest overlap (or the nearest one).
  var display = screen.getDisplayMatching(rect);
  if (!display) {
    return bounds; // no display matched -> let the OS center it
  }

  var area = display.workArea;
  var overlap = intersectionArea(rect, area);
  var rectArea = rect.width * rect.height;

  // Comes back exactly where it was if it still overlaps its display by >=50%.
  if (rectArea > 0 && overlap / rectArea >= 0.5) {
    bounds.x = rect.x;
    bounds.y = rect.y;
  } else {
    // Otherwise slide it fully onto that display's work area so it's visible.
    var slid = slideInside(rect, area);
    bounds.x = slid.x;
    bounds.y = slid.y;
  }

  return bounds;
}

// clampBounds(rect) -> the same rectangle clamped fully onto a connected
// display's work area (shrinking it if it's bigger than the screen, then
// sliding it inside). Used by the settings-grow so the enlarged window can
// never land partly off-screen.
function clampBounds(rect) {
  var out = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height)
  };
  var screen;
  try { screen = getScreen(); } catch (e) { return out; }
  var display = screen.getDisplayMatching(out) || screen.getPrimaryDisplay();
  if (!display) return out;
  var area = display.workArea;
  if (out.width > area.width) out.width = area.width;
  if (out.height > area.height) out.height = area.height;
  var slid = slideInside(out, area);
  out.x = slid.x;
  out.y = slid.y;
  return out;
}

// trackBounds — persist position + size on move/resize, debounced so a drag
// doesn't hammer the disk. Writes the whole {x,y,width,height} each time.
// opts: a number (legacy debounceMs) or { debounceMs, shouldSkipSave, key }.
//   key           : the config key to write into (default 'window'; the separate
//                   settings window passes 'settingsWindow').
//   shouldSkipSave: returning true pauses persistence (kept as a general hook; no
//                   longer used by the pill now that the settings-grow hack is gone).
function trackBounds(win, config, opts) {
  if (typeof opts === 'number') opts = { debounceMs: opts }; // back-compat
  opts = opts || {};
  var debounceMs = opts.debounceMs || 300;
  var key = opts.key || 'window';
  var shouldSkipSave = typeof opts.shouldSkipSave === 'function' ? opts.shouldSkipSave : function () { return false; };
  var timer = null;

  function save() {
    timer = null;
    if (win.isDestroyed()) return;
    if (shouldSkipSave()) return;
    var b = win.getBounds(); // { x, y, width, height }
    config.set(key, { x: b.x, y: b.y, width: b.width, height: b.height });
  }

  function onChange() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  win.on('moved', onChange);
  win.on('resized', onChange);

  // Make sure the final position/size is captured when the window goes away.
  win.on('close', function () {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!win.isDestroyed() && !shouldSkipSave()) {
      var b = win.getBounds();
      config.set(key, { x: b.x, y: b.y, width: b.width, height: b.height });
    }
  });
}

module.exports = {
  restoreBounds: restoreBounds,
  trackBounds: trackBounds,
  clampBounds: clampBounds,
  intersectionArea: intersectionArea // exported for testing
};
