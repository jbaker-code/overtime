// PRD acceptance: "Config must tolerate a missing or corrupt file - fall back to sensible
// defaults, never crash" + "forward-looking settings object".  PLAN §2.4.  Project: unit.
const { test, expect } = require('@playwright/test');
const cs = require('../src/shared/config-schema.js');

const D = () => JSON.parse(JSON.stringify(cs.DEFAULT_CONFIG));
const SETTINGS = ['layout', 'font', 'customFont', 'bgColor', 'textColor', 'opacity', 'textOpacity', 'showSeconds', 'hour12', 'alwaysOnTop', 'showClock', 'showStopwatch'];

test.describe('config-schema: defaults', () => {
  test('DEFAULT_CONFIG matches the frozen schema', () => {
    const d = cs.DEFAULT_CONFIG;
    expect(d.schemaVersion).toBe(cs.SCHEMA_VERSION);
    expect(d.schemaVersion).toBe(1);
    expect(Object.keys(d.settings).sort()).toEqual([...SETTINGS].sort());
    expect(d.settings).toMatchObject({
      layout: 'stack', font: 'system', customFont: '', bgColor: '#000000', textColor: '#ffffff', opacity: 1.0, textOpacity: 1.0, showSeconds: false, hour12: true, alwaysOnTop: true, showClock: true, showStopwatch: true,
    });
    expect(d.timer).toMatchObject({ status: 'stopped', accumulatedMs: 0, runningSince: null });
  });
  test('SETTINGS_KEYS lists exactly the settings (incl. customFont + textOpacity, no `theme`); count is 12', () => {
    expect([...cs.SETTINGS_KEYS].sort()).toEqual([...SETTINGS].sort());
    expect(cs.SETTINGS_KEYS).toHaveLength(12); // was 11; textOpacity brought it to 12
    expect(cs.SETTINGS_KEYS).toContain('customFont');
    expect(cs.SETTINGS_KEYS).toContain('textOpacity');
    expect(cs.SETTINGS_KEYS).not.toContain('theme');
  });
  test('min window size: MIN_WIDTH stays 100, MIN_HEIGHT dropped to 20 (~1/3 of the old 60)', () => {
    expect(cs.MIN_WIDTH).toBe(100);
    expect(cs.MIN_HEIGHT).toBe(20);
    // the window normalizer clamps height UP to the new, lower floor (a 15px height
    // becomes 20, no longer bumped to the old 60), and keeps a height above it as-is.
    expect(cs.normalizeConfig({ schemaVersion: 1, window: { width: 100, height: 15 } }).window.height).toBe(20);
    expect(cs.normalizeConfig({ schemaVersion: 1, window: { width: 100, height: 30 } }).window.height).toBe(30);
  });

  test('option catalogs: sizes, defaults first, hex colors', () => {
    expect(cs.LAYOUTS).toEqual(['stack', 'stopwatch-top', 'clock-left', 'side-by-side', 'split', 'one-line', 'dash', 'clock-hero', 'stopwatch-hero', 'centered-gap']);
    expect(cs.FONTS).toEqual(['system', 'mono', 'serif', 'helvetica', 'times', 'trebuchet', 'verdana', 'palatino', 'condensed']);
    expect(cs.FONTS).not.toContain('courier'); // removed (Mono already covers monospace)
    expect(cs.BG_COLORS).toHaveLength(10);
    expect(cs.TEXT_COLORS).toHaveLength(10);
    for (const c of [...cs.BG_COLORS, ...cs.TEXT_COLORS]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    expect(cs.DEFAULT_CONFIG.settings.layout).toBe(cs.LAYOUTS[0]);
    expect(cs.DEFAULT_CONFIG.settings.bgColor).toBe(cs.BG_COLORS[0]);
    expect(cs.DEFAULT_CONFIG.settings.textColor).toBe(cs.TEXT_COLORS[0]);
  });
});

test.describe('config-schema: corrupt / missing input -> defaults, never throws', () => {
  const junk = { undefined: undefined, null: null, string: 'junk', number: 42, array: [], emptyObject: {}, true: true };
  for (const [name, v] of Object.entries(junk)) {
    test(`normalizeConfig(${name}) -> DEFAULT_CONFIG`, () => {
      const out = cs.normalizeConfig(v);
      expect(out.schemaVersion).toBe(1);
      expect(out.settings).toEqual(cs.DEFAULT_CONFIG.settings);
      expect(out.timer).toEqual(cs.DEFAULT_CONFIG.timer);
    });
  }
  test('schemaVersion: 99 (from the future) -> defaults, no throw', () => {
    const out = cs.normalizeConfig({ schemaVersion: 99, settings: { opacity: 0.1 } });
    expect(out.schemaVersion).toBe(1);
    expect(out.settings).toEqual(cs.DEFAULT_CONFIG.settings);
  });
});

test.describe('config-schema: merge, validation, clamp', () => {
  test('partial config gets every missing field filled with defaults', () => {
    const out = cs.normalizeConfig({ schemaVersion: 1, settings: { hour12: false } });
    expect(out.settings.hour12).toBe(false);
    expect(out.settings).toEqual({ ...cs.DEFAULT_CONFIG.settings, hour12: false });
    expect(out.timer).toEqual(cs.DEFAULT_CONFIG.timer);
  });
  test('opacity is clamped to [0,1]', () => {
    expect(cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: 7 } }).settings.opacity).toBe(1);
    expect(cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: -3 } }).settings.opacity).toBe(0);
    expect(cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: 0.25 } }).settings.opacity).toBe(0.25);
  });
  test('wrong-typed opacity -> default', () => {
    for (const bad of ['abc', null, NaN, {}]) {
      expect(cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: bad } }).settings.opacity).toBe(1.0);
    }
  });
  test('textOpacity: default 1.0, clamped to [0,1], wrong-type -> 1.0, patch-validated', () => {
    const n = (v) => cs.normalizeConfig({ schemaVersion: 1, settings: { textOpacity: v } }).settings.textOpacity;
    // default
    expect(cs.DEFAULT_CONFIG.settings.textOpacity).toBe(1.0);
    expect(cs.normalizeConfig({}).settings.textOpacity).toBe(1.0);
    // clamp (same rule as opacity): -1 -> 0, 2 -> 1, 0 stays 0, a mid value kept
    expect(n(-1)).toBe(0);
    expect(n(2)).toBe(1);
    expect(n(0)).toBe(0);
    expect(n(0.35)).toBe(0.35);
    // wrong type / non-finite -> default 1.0 (NOT 0 — a garbage value must not hide the text)
    for (const bad of ['x', null, NaN, {}, [], true, undefined, Infinity]) expect(n(bad)).toBe(1.0);
    // patch validity: any finite number survives (and is clamped); non-numbers are dropped
    expect(cs.normalizeSettingsPatch({ textOpacity: 0 })).toEqual({ textOpacity: 0 });
    expect(cs.normalizeSettingsPatch({ textOpacity: 7 })).toEqual({ textOpacity: 1 }); // clamped
    expect(cs.normalizeSettingsPatch({ textOpacity: 'x' })).toEqual({}); // dropped, not coerced
    expect(cs.normalizeSettingsPatch({ textOpacity: NaN })).toEqual({});
  });
  test('textOpacity + opacity are independent and round-trip idempotently', () => {
    const once = cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: 0.2, textOpacity: 0.8 } }).settings;
    expect(once.opacity).toBe(0.2);
    expect(once.textOpacity).toBe(0.8);
    const twice = cs.normalizeConfig({ schemaVersion: 1, settings: once }).settings;
    expect(twice.opacity).toBe(0.2);
    expect(twice.textOpacity).toBe(0.8);
    // opacity still behaves on its own (textOpacity default fills in)
    expect(cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: 0.5 } }).settings.textOpacity).toBe(1.0);
  });
  test('invalid enums fall back to default; valid ones kept (layout/font/bgColor/textColor)', () => {
    const n = (settings) => cs.normalizeConfig({ schemaVersion: 1, settings }).settings;
    expect(n({ layout: 'diagonal' }).layout).toBe('stack');
    expect(n({ layout: 'clock-hero' }).layout).toBe('clock-hero');
    expect(n({ font: 'Comic Sans MS, cursive' }).font).toBe('system');
    expect(n({ font: 12 }).font).toBe('system');
    expect(n({ font: 'courier' }).font).toBe('system'); // dropped preset normalizes to the default
    for (const f of cs.FONTS) expect(n({ font: f }).font).toBe(f);
    expect(n({ bgColor: '#123456' }).bgColor).toBe('#000000'); // not in the palette
    expect(n({ bgColor: '#ffffff' }).bgColor).toBe('#ffffff');
    expect(n({ textColor: 'red' }).textColor).toBe('#ffffff');
    expect(n({ textColor: '#111111' }).textColor).toBe('#111111');
  });
  test('legacy `theme` key is not a setting any more: dropped', () => {
    const out = cs.normalizeConfig({ schemaVersion: 1, settings: { theme: 'light' } });
    expect(out.settings.theme).toBeUndefined();
  });
  test('normalizeSettingsPatch keeps only keys whose supplied value is valid (bad hex dropped, opacity clamped)', () => {
    const p = cs.normalizeSettingsPatch({ bgColor: '#zzz', textColor: '#111111', layout: 'nope', font: 'mono', opacity: 7, hour12: 'x', sparkle: 1 });
    expect(p).toEqual({ textColor: '#111111', font: 'mono', opacity: 1 });
    expect(cs.normalizeSettingsPatch('junk')).toEqual({});
  });
  test('wrong-typed booleans -> default', () => {
    const out = cs.normalizeConfig({ schemaVersion: 1, settings: { showSeconds: 'yes', hour12: 0, alwaysOnTop: null } });
    expect(out.settings.showSeconds).toBe(false);
    expect(out.settings.hour12).toBe(true);
    expect(out.settings.alwaysOnTop).toBe(true);
  });
  test('showClock / showStopwatch: default true, valid false kept, garbage -> true, patch-validated', () => {
    expect(cs.DEFAULT_CONFIG.settings.showClock).toBe(true);
    expect(cs.DEFAULT_CONFIG.settings.showStopwatch).toBe(true);
    const off = cs.normalizeConfig({ schemaVersion: 1, settings: { showClock: false, showStopwatch: false } }).settings;
    expect(off.showClock).toBe(false);
    expect(off.showStopwatch).toBe(false);
    const bad = cs.normalizeConfig({ schemaVersion: 1, settings: { showClock: 'no', showStopwatch: 1 } }).settings;
    expect(bad.showClock).toBe(true); // wrong type -> default
    expect(bad.showStopwatch).toBe(true);
    // only valid booleans survive a partial patch
    expect(cs.normalizeSettingsPatch({ showClock: false, showStopwatch: 'x' })).toEqual({ showClock: false });
  });
  test('customFont: default is empty string', () => {
    expect(cs.DEFAULT_CONFIG.settings.customFont).toBe('');
    expect(cs.normalizeConfig({}).settings.customFont).toBe('');
  });
  test('customFont: a valid family string is kept (and trimmed)', () => {
    const n = (v) => cs.normalizeConfig({ schemaVersion: 1, settings: { customFont: v } }).settings.customFont;
    expect(n('Helvetica Neue')).toBe('Helvetica Neue');
    expect(n('  Comic Sans MS  ')).toBe('Comic Sans MS'); // trimmed
    expect(n('')).toBe(''); // explicit none
    expect(n('   ')).toBe(''); // whitespace-only -> none
  });
  test('customFont: non-string or over-long -> empty string', () => {
    const n = (v) => cs.normalizeConfig({ schemaVersion: 1, settings: { customFont: v } }).settings.customFont;
    for (const bad of [12, null, {}, [], true, undefined, NaN]) expect(n(bad)).toBe('');
    expect(n('x'.repeat(cs.MAX_CUSTOM_FONT))).toBe('x'.repeat(cs.MAX_CUSTOM_FONT)); // at the cap: kept
    expect(n('x'.repeat(cs.MAX_CUSTOM_FONT + 1))).toBe(''); // over the cap: dropped
  });
  test('customFont: patch validity (valid string within cap, or "" to clear; over-long/non-string dropped)', () => {
    // valid values survive a partial patch...
    expect(cs.normalizeSettingsPatch({ customFont: 'Menlo' })).toEqual({ customFont: 'Menlo' });
    expect(cs.normalizeSettingsPatch({ customFont: '' })).toEqual({ customFont: '' });
    expect(cs.normalizeSettingsPatch({ customFont: '  Menlo  ' })).toEqual({ customFont: 'Menlo' });
    // ...garbage / over-long are DROPPED from the patch (not coerced), so they can't
    // silently wipe an existing choice.
    expect(cs.normalizeSettingsPatch({ customFont: 42 })).toEqual({});
    expect(cs.normalizeSettingsPatch({ customFont: 'x'.repeat(cs.MAX_CUSTOM_FONT + 1) })).toEqual({});
  });
  test('customFont: round-trips through normalizeSettings / normalizeConfig idempotently', () => {
    const once = cs.normalizeConfig({ schemaVersion: 1, settings: { customFont: 'Papyrus' } });
    expect(once.settings.customFont).toBe('Papyrus');
    expect(cs.normalizeConfig(once).settings.customFont).toBe('Papyrus');
    // font (enum) and customFont (free-form) are independent fields
    const both = cs.normalizeConfig({ schemaVersion: 1, settings: { font: 'serif', customFont: 'Papyrus' } }).settings;
    expect(both.font).toBe('serif');
    expect(both.customFont).toBe('Papyrus');
  });

  test('unknown keys are dropped at every level', () => {
    const out = cs.normalizeConfig({ schemaVersion: 1, evil: 1, settings: { hour12: false, sparkle: true }, timer: { status: 'paused', accumulatedMs: 1, runningSince: null, x: 1 } });
    expect(out.evil).toBeUndefined();
    expect(out.settings.sparkle).toBeUndefined();
    expect(out.timer.x).toBeUndefined();
  });
  test('timer.status "running" is restored as "paused" (D6), value kept', () => {
    const out = cs.normalizeConfig({ schemaVersion: 1, timer: { status: 'running', accumulatedMs: 4000, runningSince: 123 } });
    expect(out.timer).toEqual({ status: 'paused', accumulatedMs: 4000, runningSince: null });
  });
  test('garbage timer -> default timer', () => {
    expect(cs.normalizeConfig({ schemaVersion: 1, timer: 'x' }).timer).toEqual(cs.DEFAULT_CONFIG.timer);
    expect(cs.normalizeConfig({ schemaVersion: 1, timer: { status: 'paused', accumulatedMs: 'lots' } }).timer).toEqual(cs.DEFAULT_CONFIG.timer);
  });
  test('window bounds: finite numbers kept; non-finite / wrong types dropped or defaulted without throwing', () => {
    const ok = cs.normalizeConfig({ schemaVersion: 1, window: { x: 10, y: 20, width: 300, height: 163 } });
    expect(ok.window).toMatchObject({ x: 10, y: 20, width: 300, height: 163 });
    const bad = cs.normalizeConfig({ schemaVersion: 1, window: { x: 'a', y: NaN, width: 'wide', height: null } });
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = bad.window && bad.window[k];
      expect(v === undefined || v === null || Number.isFinite(v)).toBe(true);
    }
  });
  test('normalize is idempotent and does not mutate DEFAULT_CONFIG', () => {
    const before = D();
    const once = cs.normalizeConfig({ schemaVersion: 1, settings: { opacity: 9, layout: 'nope' } });
    const twice = cs.normalizeConfig(once);
    expect(twice).toEqual(once);
    expect(cs.DEFAULT_CONFIG).toEqual(before);
  });
});
