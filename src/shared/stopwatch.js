// src/shared/stopwatch.js
// -----------------------------------------------------------------------------
// The episode stopwatch state machine. Pure, framework-free, no DOM, no Node.
//
// Design (see PLAN §3 + decisions D3/D4/D5/D6):
//   * State lives in the RENDERER; main only persists what we hand it.
//   * Elapsed time is ALWAYS computed from an anchor, never accumulated per
//     tick -> zero setInterval drift. Ticks only drive rendering.
//       elapsed = accumulatedMs + (running ? now - runningSince : 0)
//   * Anchor clock = Date.now() (wall-clock epoch). Backward jumps clamp to 0.
//   * All transitions are pure functions (state, now) -> state. No-ops return
//     the SAME object (identity), so the UI can skip a re-render/persist.
//
// State shape:
//   { status: 'stopped' | 'running' | 'paused',
//     accumulatedMs: number,      // time banked from previous running stretches
//     runningSince: number|null } // anchor of the current stretch (null unless running)
//
// UMD wrapper (PLAN D2): classic <script> -> window.EpisodeTimerStopwatch,
// and require() in Node/Electron/tests.
// -----------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EpisodeTimerStopwatch = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- construction ----------------------------------------------------------

  function createInitial() {
    return { status: 'stopped', accumulatedMs: 0, runningSince: null };
  }

  // "bank" the current running stretch into accumulatedMs.
  // max(0, ...) clamps backward clock jumps (NTP step, manual change) to 0 ms —
  // we'd rather under-count by a second than show a negative/absurd value (D5).
  function bank(state, now) {
    return state.accumulatedMs + Math.max(0, now - state.runningSince);
  }

  // --- the elapsed value (the whole point) -----------------------------------

  function elapsedMs(state, now) {
    if (!state) return 0;
    if (state.status === 'running') {
      return state.accumulatedMs + Math.max(0, now - state.runningSince);
    }
    return state.accumulatedMs;
  }

  // --- transitions: pure (state, now) -> state --------------------------------
  // The truth table lives in PLAN §3.2 / PRD. Each returns the same object on a
  // no-op so callers can cheaply detect "nothing changed".

  function play(state, now) {
    // Running -> no-op. Stopped(0), Stopped(value) and Paused all (re)start.
    if (state.status === 'running') return state;
    return { status: 'running', accumulatedMs: state.accumulatedMs, runningSince: now };
  }

  function pause(state, now) {
    // Only Running can be paused; everything else is a no-op (button disabled).
    if (state.status !== 'running') return state;
    return { status: 'paused', accumulatedMs: bank(state, now), runningSince: null };
  }

  function stop(state, now) {
    // Running -> bank the value then stop. Paused -> keep the (already banked)
    // value and stop. Stopped -> no-op. Stop and Pause keep the value; they
    // differ only in which buttons light up next (and the host's mental model).
    if (state.status === 'running') {
      return { status: 'stopped', accumulatedMs: bank(state, now), runningSince: null };
    }
    if (state.status === 'paused') {
      return { status: 'stopped', accumulatedMs: state.accumulatedMs, runningSince: null };
    }
    return state; // already stopped
  }

  function reset(state, now) {
    // The destructive "back to 00:00:00".
    //
    // NEW (on-camera) behavior: if the stopwatch is RUNNING, Reset zeroes the
    // elapsed but KEEPS RUNNING — it re-anchors (accumulatedMs=0, runningSince=now)
    // instead of stopping. The host hits Reset mid-record to restart the count from
    // zero without a second Play tap; pausing wasn't what they wanted. We therefore
    // need `now` for the fresh anchor (the signature used to ignore it).
    //
    // Paused/stopped reset to a clean, zeroed STOP as before (no anchor). Already
    // at a clean stop (Stopped with 0) -> no-op (identity), so the UI can skip work.
    if (state.status === 'running') {
      if (typeof now !== 'number') now = Date.now();
      return { status: 'running', accumulatedMs: 0, runningSince: now };
    }
    if (state.status === 'stopped' && state.accumulatedMs === 0) return state;
    return { status: 'stopped', accumulatedMs: 0, runningSince: null };
  }

  // --- button-enabled helpers (one source of truth for the UI AND the table) --

  function canPlay(state) { return state.status !== 'running'; }
  function canPause(state) { return state.status === 'running'; }
  function canStop(state) { return state.status === 'running' || state.status === 'paused'; }
  function canReset(state) { return !(state.status === 'stopped' && state.accumulatedMs === 0); }

  // --- persistence ------------------------------------------------------------

  // coerce(obj) -> a clean, type-validated persisted shape WITHOUT applying the
  // restore-as-paused rule. The rule is STRICT: if ANY field is the wrong type
  // (e.g. accumulatedMs:'x', a bogus status, a non-numeric runningSince) we bail
  // to a fresh initial state rather than salvaging the good fields. A corrupt
  // timer is not worth half-trusting.
  function coerce(obj) {
    if (!obj || typeof obj !== 'object') return createInitial();

    var status = obj.status;
    if (status !== 'stopped' && status !== 'running' && status !== 'paused') {
      return createInitial();
    }

    var acc = obj.accumulatedMs;
    if (typeof acc !== 'number' || !isFinite(acc) || acc < 0) {
      return createInitial(); // e.g. 'x', NaN, Infinity, negative, missing
    }

    // runningSince may be null/undefined (no current stretch) or a finite
    // number (an anchor). Any other type is garbage -> bail.
    var since = obj.runningSince;
    var sinceEmpty = (since === null || since === undefined);
    var sinceNumber = (typeof since === 'number' && isFinite(since));
    if (!sinceEmpty && !sinceNumber) return createInitial();

    acc = Math.floor(acc);

    if (status === 'running') {
      // A running timer needs a real anchor. If it has one, keep it running;
      // if it has none, it comes back frozen (fromPersisted applies D6 anyway),
      // so demote to paused keeping the banked value — not garbage, just a
      // running stretch we can't continue.
      if (sinceNumber) return { status: 'running', accumulatedMs: acc, runningSince: since };
      return { status: 'paused', accumulatedMs: acc, runningSince: null };
    }

    // stopped / paused: the anchor is always null.
    return { status: status, accumulatedMs: acc, runningSince: null };
  }

  // fromPersisted(obj) -> the state to show at launch.
  // Applies D6 (restore-as-paused): a timer that was running when we quit comes
  // back PAUSED at its last saved value; offline time is never back-filled.
  function fromPersisted(obj) {
    var s = coerce(obj);
    if (s.status === 'running') {
      s = { status: 'paused', accumulatedMs: s.accumulatedMs, runningSince: null };
    }
    return s;
  }

  // toPersisted(state, now) -> a JSON-safe snapshot to write to disk.
  // We SNAPSHOT the elapsed value into accumulatedMs and drop the anchor, so a
  // crash/quit while running restores the frozen value (PRD: "never back-fills
  // closed time"). A running timer serializes as 'paused' — matching the schema
  // example in PLAN §2.4 — because that is exactly how it will come back.
  function toPersisted(state, now) {
    if (typeof now !== 'number') now = Date.now();
    return {
      status: state.status === 'running' ? 'paused' : state.status,
      accumulatedMs: elapsedMs(state, now),
      runningSince: null
    };
  }

  return {
    createInitial: createInitial,
    elapsedMs: elapsedMs,
    play: play,
    pause: pause,
    stop: stop,
    reset: reset,
    canPlay: canPlay,
    canPause: canPause,
    canStop: canStop,
    canReset: canReset,
    coerce: coerce,
    fromPersisted: fromPersisted,
    toPersisted: toPersisted
  };
}));
