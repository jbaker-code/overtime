// PRD acceptance: "Episode stopwatch HH:MM:SS with working Play/Pause/Stop/Reset"
// PLAN §3.2 transition table, §3.3 accurate timing, D4/D5/D6.  Project: unit (pure Node).
const { test, expect } = require('@playwright/test');
const sw = require('../source/app/shared/stopwatch.js');

const T0 = 1_000_000;
const stoppedZero = () => sw.createInitial();
const running = (acc = 0, since = T0) => ({ status: 'running', accumulatedMs: acc, runningSince: since });
const paused = (acc = 5000) => ({ status: 'paused', accumulatedMs: acc, runningSince: null });
const stoppedVal = (acc = 5000) => ({ status: 'stopped', accumulatedMs: acc, runningSince: null });

test.describe('stopwatch: initial state', () => {
  test('createInitial is stopped at 0 with no anchor', () => {
    expect(stoppedZero()).toEqual({ status: 'stopped', accumulatedMs: 0, runningSince: null });
  });
});

// Table-driven 4 states x 4 actions. `expected: 'same'` => no-op returning the SAME object.
const NOW = T0 + 7000; // 7 s after any running anchor
const table = [
  // [label, makeState, action, expected]
  ['stopped(0)', stoppedZero, 'play', { status: 'running', accumulatedMs: 0, runningSince: NOW }],
  ['stopped(0)', stoppedZero, 'pause', 'same'],
  ['stopped(0)', stoppedZero, 'stop', 'same'],
  ['stopped(0)', stoppedZero, 'reset', 'same'],

  ['running', () => running(1000), 'play', 'same'],
  ['running', () => running(1000), 'pause', { status: 'paused', accumulatedMs: 8000, runningSince: null }],
  ['running', () => running(1000), 'stop', { status: 'stopped', accumulatedMs: 8000, runningSince: null }],
  // NEW: reset while RUNNING zeroes the elapsed but KEEPS RUNNING (re-anchors to now).
  ['running', () => running(1000), 'reset', { status: 'running', accumulatedMs: 0, runningSince: NOW }],

  ['paused', () => paused(5000), 'play', { status: 'running', accumulatedMs: 5000, runningSince: NOW }],
  ['paused', () => paused(5000), 'pause', 'same'],
  ['paused', () => paused(5000), 'stop', { status: 'stopped', accumulatedMs: 5000, runningSince: null }],
  ['paused', () => paused(5000), 'reset', { status: 'stopped', accumulatedMs: 0, runningSince: null }],

  ['stopped(value)', () => stoppedVal(5000), 'play', { status: 'running', accumulatedMs: 5000, runningSince: NOW }],
  ['stopped(value)', () => stoppedVal(5000), 'pause', 'same'],
  ['stopped(value)', () => stoppedVal(5000), 'stop', 'same'],
  ['stopped(value)', () => stoppedVal(5000), 'reset', { status: 'stopped', accumulatedMs: 0, runningSince: null }],
];

test.describe('stopwatch: PRD transition table (4x4)', () => {
  for (const [label, make, action, expected] of table) {
    test(`${label} + ${action}`, () => {
      const s = make();
      const out = sw[action](s, NOW);
      if (expected === 'same') expect(out).toBe(s); // identity => UI can skip re-render/persist
      else expect(out).toEqual(expected);
    });
  }
});

test.describe('stopwatch: reset behavior (running keeps running; paused/stopped zero + stop)', () => {
  test('reset while RUNNING zeroes the elapsed but stays running, re-anchored to now', () => {
    const s = running(12_345, T0);
    const out = sw.reset(s, NOW);
    expect(out).toEqual({ status: 'running', accumulatedMs: 0, runningSince: NOW });
    // elapsed is 0 at the reset instant and climbs again from there (not from the old value)
    expect(sw.elapsedMs(out, NOW)).toBe(0);
    expect(sw.elapsedMs(out, NOW + 4000)).toBe(4000);
    // and it's still resettable / pausable / not re-playable mid-run
    expect(sw.canReset(out)).toBe(true);
    expect(sw.canPause(out)).toBe(true);
    expect(sw.canPlay(out)).toBe(false);
  });

  test('reset while RUNNING defaults now to Date.now() when omitted (still running, zeroed)', () => {
    const out = sw.reset(running(9000, T0));
    expect(out.status).toBe('running');
    expect(out.accumulatedMs).toBe(0);
    expect(typeof out.runningSince).toBe('number');
  });

  test('reset while PAUSED zeroes AND stops (unchanged)', () => {
    expect(sw.reset(paused(5000), NOW)).toEqual({ status: 'stopped', accumulatedMs: 0, runningSince: null });
  });

  test('reset while STOPPED(value) zeroes AND stops; stopped(0) is a no-op (identity)', () => {
    expect(sw.reset(stoppedVal(5000), NOW)).toEqual({ status: 'stopped', accumulatedMs: 0, runningSince: null });
    const z = stoppedZero();
    expect(sw.reset(z, NOW)).toBe(z); // already clean -> same object
  });
});

test.describe('stopwatch: elapsedMs math (D4 - anchor, not accumulation)', () => {
  test('stopped / paused ignore "now"', () => {
    expect(sw.elapsedMs(stoppedZero(), T0 + 99999)).toBe(0);
    expect(sw.elapsedMs(paused(5000), T0 + 99999)).toBe(5000);
    expect(sw.elapsedMs(stoppedVal(1234), T0 + 99999)).toBe(1234);
  });
  test('running = accumulated + (now - anchor)', () => {
    expect(sw.elapsedMs(running(2000, T0), T0 + 3500)).toBe(5500);
  });
  test('play -> late tick -> pause counts real elapsed time (no drift)', () => {
    let s = sw.play(stoppedZero(), T0);
    // no ticks at all for an hour: still exact
    s = sw.pause(s, T0 + 3_661_000);
    expect(sw.elapsedMs(s, T0 + 9_999_999)).toBe(3_661_000);
  });
  test('pause / resume accumulates only running stretches', () => {
    let s = sw.play(stoppedZero(), 0);
    s = sw.pause(s, 10_000); // +10 s
    s = sw.play(s, 500_000); // long gap while paused must not count
    s = sw.pause(s, 505_000); // +5 s
    expect(sw.elapsedMs(s, 900_000)).toBe(15_000);
  });
  test('negative delta (clock stepped backwards) clamps to 0, never negative', () => {
    const s = running(2000, T0);
    expect(sw.elapsedMs(s, T0 - 5000)).toBe(2000);
    expect(sw.pause(s, T0 - 5000).accumulatedMs).toBe(2000);
    expect(sw.stop(s, T0 - 5000).accumulatedMs).toBe(2000);
  });
});

test.describe('stopwatch: can* helpers drive button enabled state', () => {
  const cases = [
    ['stopped(0)', stoppedZero(), { play: true, pause: false, stop: false, reset: false }],
    ['running', running(), { play: false, pause: true, stop: true, reset: true }],
    ['paused', paused(), { play: true, pause: false, stop: true, reset: true }],
    ['stopped(value)', stoppedVal(), { play: true, pause: false, stop: false, reset: true }],
  ];
  for (const [label, s, want] of cases) {
    test(label, () => {
      expect({
        play: sw.canPlay(s), pause: sw.canPause(s), stop: sw.canStop(s), reset: sw.canReset(s),
      }).toEqual(want);
    });
  }
});

test.describe('stopwatch: persistence (D6 restore-as-paused)', () => {
  test('running -> paused on restore, anchor dropped, banked value kept (offline time NOT added)', () => {
    const out = sw.fromPersisted({ status: 'running', accumulatedMs: 4000, runningSince: T0 });
    expect(out).toEqual({ status: 'paused', accumulatedMs: 4000, runningSince: null });
  });
  test('paused / stopped round-trip through toPersisted + fromPersisted', () => {
    for (const s of [paused(7000), stoppedVal(7000), stoppedZero()]) {
      const json = JSON.parse(JSON.stringify(sw.toPersisted(s)));
      expect(sw.fromPersisted(json)).toEqual(s);
    }
  });
  test('garbage input falls back to createInitial()', () => {
    const garbage = [undefined, null, 'junk', 42, [], {}, { status: 'exploding' },
      { status: 'paused', accumulatedMs: 'x' }, { status: 'paused', accumulatedMs: -5 },
      { status: 'paused', accumulatedMs: NaN }, { status: 'paused', accumulatedMs: Infinity }];
    for (const g of garbage) expect(sw.fromPersisted(g)).toEqual(sw.createInitial());
  });
});
