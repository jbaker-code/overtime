// source/app/shared/format.js
// -----------------------------------------------------------------------------
// Tiny, dependency-free formatting helpers for the two readouts.
//
// Why hand-rolled instead of toLocaleTimeString()? Because we want the EXACT
// same output on macOS, Windows and in a plain browser tab, regardless of the
// user's locale. Predictable + trivially unit-testable beats "clever."
//
// UMD wrapper (see PLAN D2): this file loads as a classic <script> in the
// renderer (exposing window.EpisodeTimerFormat) AND as a CommonJS module via
// require() in Electron's main process and in the Playwright unit tests. No
// bundler, no ES-module import/export.
// -----------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // Node / Electron main / unit tests
  } else {
    root.EpisodeTimerFormat = factory(); // browser / renderer global
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Zero-pad a number to at least `width` digits (defaults to 2).
  // Hours in the stopwatch can go past 99, so we only pad UP to the minimum.
  function pad(n, width) {
    var s = String(Math.abs(n));
    width = width || 2;
    while (s.length < width) s = '0' + s;
    return s;
  }

  // formatClock(date, { hour12, showSeconds }) -> { time, meridiem }
  //
  //   hour12:true  -> 12-hour clock, meridiem is 'AM' | 'PM', midnight/noon = 12
  //   hour12:false -> 24-hour clock ('00'..'23'), meridiem is '' (hidden)
  //   showSeconds  -> 'HH:MM:SS' instead of 'HH:MM'
  //
  // Returns an object so the renderer can drop `time` and `meridiem` into their
  // own spans (the meridiem is styled smaller, per the PRD).
  function formatClock(d, opts) {
    opts = opts || {};
    // Be bulletproof about the first arg: the renderer ticks on Date.now() (a
    // number), but callers/tests also pass a real Date. Coerce a number (epoch
    // ms) to a Date; leave an actual Date alone; anything else -> "now". If we
    // ever called date.getHours() on a number again, render() would throw and
    // take the whole tick loop down with it.
    var date;
    if (d instanceof Date) date = d;
    else if (typeof d === 'number' && isFinite(d)) date = new Date(d);
    else date = new Date();

    // Defaults mirror DEFAULT_CONFIG.settings so callers can pass nothing.
    var hour12 = opts.hour12 !== false; // default true
    var showSeconds = opts.showSeconds === true; // default false

    var h = date.getHours(); // 0..23
    var m = date.getMinutes();
    var s = date.getSeconds();

    var meridiem = '';
    var displayHour = h;

    if (hour12) {
      meridiem = h < 12 ? 'AM' : 'PM';
      displayHour = h % 12;
      if (displayHour === 0) displayHour = 12; // 0 and 12 both show as "12"
    }

    var time = pad(displayHour) + ':' + pad(m);
    if (showSeconds) time += ':' + pad(s);

    return { time: time, meridiem: meridiem };
  }

  // formatElapsed(ms) -> 'HH:MM:SS'
  //
  // Floors to whole seconds (we tick once a second; no point showing millis).
  // Hours are NOT capped at 99 — Episode 001's raw take was ~2.5 hours and this
  // series tempts fate, so three-digit hours render fine.
  function formatElapsed(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    var totalSeconds = Math.floor(ms / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  }

  return {
    pad: pad,
    formatClock: formatClock,
    formatElapsed: formatElapsed
  };
}));
