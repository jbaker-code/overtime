// PRD acceptance: "Wall clock HH:MM + small AM/PM" and "stopwatch HH:MM:SS".
// PLAN §3.4. Project: unit (pure Node).
const { test, expect } = require('@playwright/test');
const { formatClock, formatElapsed } = require('../source/app/shared/format.js');

// Local-time dates (formatClock uses getHours() etc, deliberately not toLocaleTimeString).
const at = (h, m, s = 0) => new Date(2026, 9, 31, h, m, s);

test.describe('formatClock - 12-hour (default)', () => {
  const rows = [
    [at(0, 0), '12:00', 'AM'], // midnight -> 12 AM
    [at(0, 5), '12:05', 'AM'],
    [at(1, 7), '01:07', 'AM'], // zero padded
    [at(10, 42), '10:42', 'AM'],
    [at(12, 0), '12:00', 'PM'], // noon -> 12 PM
    [at(12, 59), '12:59', 'PM'],
    [at(13, 0), '01:00', 'PM'],
    [at(23, 59), '11:59', 'PM'],
  ];
  for (const [d, time, meridiem] of rows) {
    test(`${d.getHours()}:${d.getMinutes()} -> ${time} ${meridiem}`, () => {
      expect(formatClock(d, { hour12: true, showSeconds: false })).toEqual({ time, meridiem });
    });
  }
  test('no options -> defaults (12-hour, no seconds)', () => {
    expect(formatClock(at(15, 4))).toEqual({ time: '03:04', meridiem: 'PM' });
  });
});

test.describe('formatClock - 24-hour', () => {
  test('hour12:false -> 00-23 and EMPTY meridiem', () => {
    expect(formatClock(at(0, 0), { hour12: false })).toEqual({ time: '00:00', meridiem: '' });
    expect(formatClock(at(23, 59), { hour12: false })).toEqual({ time: '23:59', meridiem: '' });
    expect(formatClock(at(12, 3), { hour12: false })).toEqual({ time: '12:03', meridiem: '' });
  });
});

test.describe('formatClock - seconds', () => {
  test('showSeconds -> HH:MM:SS', () => {
    expect(formatClock(at(10, 42, 7), { hour12: true, showSeconds: true })).toEqual({ time: '10:42:07', meridiem: 'AM' });
    expect(formatClock(at(23, 5, 59), { hour12: false, showSeconds: true })).toEqual({ time: '23:05:59', meridiem: '' });
  });
});

test.describe('formatElapsed - HH:MM:SS', () => {
  const rows = [
    [0, '00:00:00'],
    [999, '00:00:00'], // floors, never rounds up
    [1000, '00:00:01'],
    [59_999, '00:00:59'],
    [60_000, '00:01:00'],
    [3_599_999, '00:59:59'],
    [3_600_000, '01:00:00'],
    [3_661_000, '01:01:01'],
    [9_000_000, '02:30:00'], // Episode 001 was ~2.5 h
    [100 * 3_600_000, '100:00:00'], // hours may exceed 99
  ];
  for (const [ms, out] of rows) test(`${ms} ms -> ${out}`, () => expect(formatElapsed(ms)).toBe(out));
});
