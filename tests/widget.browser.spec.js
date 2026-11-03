// Single-file build in headless Chromium  (project: single-file; runs in the VM).
// Loads <scratch>/test/index.html produced by tests/helpers/global-setup.js via
// `build-single-file.js --out`. Time is faked with page.clock; persistence is localStorage.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { SINGLE_FILE, BUILD_ERROR_FILE, STORAGE_KEY } = require('./helpers/paths');
const { SEL, START_MS, freezeClock, advance, press } = require('./helpers/dom');
const { registerSharedWidgetTests } = require('./helpers/widget-suite');

const URL_ = pathToFileURL(SINGLE_FILE).href;

test.beforeAll(() => {
  if (fs.existsSync(BUILD_ERROR_FILE)) throw new Error('single-file build failed in global setup:\n' + fs.readFileSync(BUILD_ERROR_FILE, 'utf8'));
  if (!fs.existsSync(SINGLE_FILE)) throw new Error(`single-file build output missing: ${SINGLE_FILE}`);
});

/** Open the built page with a fake clock; optionally pre-seed localStorage before any script runs. */
async function openWidget(page, { settings, raw, timer, seed = true, queryLocalFonts } = {}) {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  page.pageErrors = pageErrors;
  // Control queryLocalFonts BEFORE any page script runs so settings-panel.js sees
  // the chosen state at boot. An array installs a deterministic stub (we don't want
  // to depend on the host Chromium's real one); `null` FORCES it absent to exercise
  // the "no API -> hide Edit" degradation branch — modern Chromium exposes
  // queryLocalFonts, so we must remove it explicitly rather than assume the browser
  // build lacks it.
  if (queryLocalFonts === null) {
    await page.addInitScript(() => {
      try { Object.defineProperty(window, 'queryLocalFonts', { value: undefined, configurable: true }); }
      catch (e) { try { window.queryLocalFonts = undefined; } catch (_) {} }
    });
  } else if (queryLocalFonts !== undefined) {
    await page.addInitScript((faces) => {
      window.queryLocalFonts = function () {
        return Promise.resolve((faces || []).map((f) => ({
          family: f.family, fullName: f.fullName || f.family,
          postscriptName: f.postscriptName || f.family, style: f.style || 'Regular',
        })));
      };
    }, queryLocalFonts);
  }
  if (settings || raw !== undefined || timer) {
    await page.addInitScript(({ key, settings, raw, timer }) => {
      // Only seed once: reloads in the same test must see what the app itself saved.
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      if (raw !== undefined) return localStorage.setItem(key, raw);
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, settings: settings || {}, ...(timer ? { timer } : {}) }));
    }, { key: STORAGE_KEY, settings, raw, timer });
  }
  await page.clock.install({ time: new Date(START_MS) });
  await page.goto(URL_);
  await expect(page.locator(SEL.app)).toBeVisible();
  await freezeClock(page);
  return page;
}

test.describe('single-file: shared widget behaviour', () => {
  // The clock/stopwatch/hover/resize/settings/drag/look suites, shared with Electron.
  let currentPage;
  test.beforeEach(({ page }) => { currentPage = page; });
  registerSharedWidgetTests(test, expect, {
    open: (o) => openWidget(currentPage, o),
    resize: (p, w, h) => p.setViewportSize({ width: w, height: h }),
    // Browser build: "Settings" is the IN-PAGE overlay on the SAME page (no second
    // window), so opening it returns the same page the panel lives on.
    openSettings: async (page) => {
      await press(page, 'settings'); // -> __episodeTimer.openSettings() -> panel.open()
      await expect(page.locator(SEL.panel)).toBeVisible();
      return page;
    },
    // Browser env drives data-hover from DOM mouseenter/leave (no drag region in a tab).
    setHover: async (p, on) => {
      if (on) await p.hover(SEL.app);
      else await p.dispatchEvent('html', 'mouseleave');
      await p.waitForFunction((v) => document.querySelector('#app').dataset.hover === v, on ? 'true' : 'false');
    },
  }, 'single-file');
});

test.describe('single-file: build correctness', () => {
  // PLAN 5.2 "Single-file build correctness": self-contained, nothing external.
  test('the built file is self-contained (no external src/href, no http references)', () => {
    const html = fs.readFileSync(SINGLE_FILE, 'utf8');
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(html).not.toMatch(/<link[^>]*rel\s*=\s*["']stylesheet/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
  });

  test('loads with no page errors and no failed requests', async ({ page }) => {
    const failed = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    await openWidget(page);
    expect(page.pageErrors).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('exposes the window.__episodeTimer test hook with env "browser"', async ({ page }) => {
    await openWidget(page);
    const env = await page.evaluate(() => window.__episodeTimer && window.__episodeTimer.env);
    expect(env).toBe('browser');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-env', 'browser');
  });
});

test.describe('single-file: browser mode hides Electron-only affordances', () => {
  // PLAN 5.2 row "Browser-mode hides Electron-only affordances". The resize grip is
  // meaningless in a browser tab (no OS window to resize), so it stays hidden even on
  // hover. (The on-pill controls go the OTHER way — they're browser-ONLY; see the
  // dedicated controls describe below.)
  test('#grip is hidden even while hovering', async ({ page }) => {
    await openWidget(page);
    await page.hover(SEL.app);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect(page.locator(SEL.grip)).toBeHidden();
  });
});

// ---- on-pill controls (browser-only fallback) ----------------------------------------------
// A plain browser tab has no tray and no native right-click menu, so the on-pill
// Play/Pause/Reset/Settings cluster is the ONLY way to drive the stopwatch + open settings
// there. Pass C removed all on-pill controls (correct for the Electron build); this restores
// them for browser mode. They fade in on hover (like the grip), sit above the 50%-black hover
// tint so they stay readable, and there is NO Quit button.
test.describe('single-file: on-pill controls (browser-only fallback)', () => {
  const controlsOpacity = (page) =>
    page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#controls')).opacity));
  const isDisabled = (page, id) => page.locator(id).evaluate((el) => el.disabled);

  test('the cluster is shown in browser mode (display:flex) and fades in on hover (opacity 0 -> 1)', async ({ page }) => {
    await openWidget(page);
    // In browser mode the cluster is laid out (display:flex), unlike the display:none it has in Electron.
    await expect(page.locator('#controls')).toHaveCount(1);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#controls')).display)).toBe('flex');
    // Faded out until hover...
    await page.dispatchEvent('html', 'mouseleave');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    await expect.poll(() => controlsOpacity(page)).toBe(0);
    // ...and hover reveals it.
    await page.hover(SEL.app);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect.poll(() => controlsOpacity(page)).toBe(1);
  });

  test('the cluster paints ABOVE the 50%-black hover tint (and the in-flow readouts), so it stays readable', async ({ page }) => {
    await openWidget(page);
    const z = await page.evaluate(() => ({
      controls: Number(getComputedStyle(document.querySelector('#controls')).zIndex),
      after: Number(getComputedStyle(document.querySelector('#app'), '::after').zIndex),
    }));
    // tint overlay is z-index:-1 (below the face); the controls must be above it.
    expect(z.after).toBe(-1);
    expect(z.controls).toBeGreaterThan(z.after);
    expect(z.controls).toBeGreaterThanOrEqual(0); // and above the in-flow face (auto == 0)
  });

  test('exactly four controls — Play/Pause/Reset/Settings — and NO Quit', async ({ page }) => {
    await openWidget(page);
    for (const id of ['#btn-play', '#btn-pause', '#btn-reset', '#btn-settings']) {
      await expect(page.locator(id), id).toHaveCount(1);
    }
    await expect(page.locator('#controls button')).toHaveCount(4);
    await expect(page.locator('#btn-quit')).toHaveCount(0);
  });

  test('clicking Play runs the stopwatch; Pause freezes it; Reset zeroes it', async ({ page }) => {
    await openWidget(page);
    await page.hover(SEL.app); // reveal the cluster, like a user would
    await page.click('#btn-play');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
    await advance(page, 5_000);
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await page.click('#btn-pause');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await advance(page, 30_000); // paused: must not move
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await page.click('#btn-reset'); // reset from paused -> zeroed + stopped
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
  });

  test('clicking Reset while RUNNING zeroes but keeps running (reset-keeps-running semantics)', async ({ page }) => {
    await openWidget(page);
    await page.hover(SEL.app);
    await page.click('#btn-play');
    await advance(page, 9_000);
    await page.click('#btn-reset');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running'); // still running
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    // Re-anchored from zero: after 3 s the last second-aligned tick shows 02 or 03.
    await advance(page, 3_000);
    await expect(page.locator(SEL.stopwatch)).toHaveText(/^00:00:0[23]$/);
  });

  test('clicking Settings (the gear) opens the settings panel', async ({ page }) => {
    await openWidget(page);
    await page.hover(SEL.app);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'closed');
    await page.click('#btn-settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await expect(page.locator(SEL.panel)).toBeVisible();
  });

  test('Play/Pause/Reset disabled states mirror the stopwatch (canPlay/canPause/canReset)', async ({ page }) => {
    await openWidget(page);
    await page.hover(SEL.app);
    // Stopped at zero: Play enabled, Pause disabled, Reset disabled.
    expect(await isDisabled(page, '#btn-play')).toBe(false);
    expect(await isDisabled(page, '#btn-pause')).toBe(true);
    expect(await isDisabled(page, '#btn-reset')).toBe(true);
    // Running: Play disabled, Pause enabled, Reset enabled.
    await page.click('#btn-play');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
    await expect.poll(() => isDisabled(page, '#btn-play')).toBe(true);
    expect(await isDisabled(page, '#btn-pause')).toBe(false);
    expect(await isDisabled(page, '#btn-reset')).toBe(false);
    // Paused with a banked value: Play enabled again, Pause disabled, Reset still enabled.
    await page.click('#btn-pause');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
    await expect.poll(() => isDisabled(page, '#btn-play')).toBe(false);
    expect(await isDisabled(page, '#btn-pause')).toBe(true);
    expect(await isDisabled(page, '#btn-reset')).toBe(false);
  });

  test('on hover, the compact controls do NOT geometrically overlap the readouts in ANY layout (#clock/#stopwatch)', async ({ page }) => {
    // REGRESSION FIX (Q1): the old 11vmin control bar scaled WITH the window, so the bottom
    // bar re-covered the lower readout at every size (~26% of #stopwatch). The cluster is now
    // compact + px-capped to sit UNDER the fit's ~6%-of-height margin, so it clears the readouts
    // at a normal browser-window size. We measure a VERTICAL/stacked set — the binding case —
    // including the TALL layouts the first fix still grazed: `dash` (clock + separator +
    // stopwatch) and `centered-gap` (extra --face-gap) push the bottom readout lowest. (We skip
    // the tiny 240x130 Electron widget shape, where a pill-filling stacked face reaches the
    // bottom edge regardless of bar size — a fit matter owned elsewhere; controls are hidden in
    // Electron anyway. The single-file build runs in a real, larger browser tab.)
    await openWidget(page);
    await page.setViewportSize({ width: 640, height: 400 });
    await advance(page, 300); // let the fit settle at the new size (SETTLE_MS = 120)
    await page.hover(SEL.app);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    // The cluster must actually be revealed (opacity 1) — we're asserting what the user sees.
    await expect.poll(() => controlsOpacity(page)).toBe(1);

    const overlapFor = async (layout) => {
      // Switch layout through the real settings path (NOT by poking the attribute), so the face
      // re-fits for the new arrangement; opening the panel would occlude the readouts, so we
      // drive the bridge directly. applyAndRemember re-fits synchronously.
      await page.evaluate((l) => window.EpisodeTimerBridge.setSettings({ layout: l }), layout);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', layout);
      await advance(page, 200); // belt-and-suspenders: flush any pending settle
      return page.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const area = (a, b) =>
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const c = box('#controls');
        return { stopwatch: area(c, box('#stopwatch')), clock: area(c, box('#clock')) };
      });
    };

    for (const layout of ['stack', 'dash', 'centered-gap', 'one-line']) {
      const o = await overlapFor(layout);
      expect(o.stopwatch, `${layout}: controls must not cover #stopwatch`).toBe(0);
      expect(o.clock, `${layout}: controls must not cover #clock`).toBe(0);
    }
  });

  test('on hover, a two-tone edge ring appears (readable on any background); gone otherwise', async ({ page }) => {
    // NEW: the 50%-black tint is ~invisible over a dark/black pill (the default), so hover also
    // draws a subtle two-tone outline (stacked inset box-shadows: a light line over a dark line)
    // hugging the pill, gated purely on data-hover so there's no startup flash. It rides the
    // #app::after overlay, so it shows in BOTH builds (browser DOM hover + Electron poll->IPC).
    const ring = (page) =>
      page.evaluate(() => getComputedStyle(document.querySelector('#app'), '::after').boxShadow);
    await openWidget(page);
    await page.dispatchEvent('html', 'mouseleave');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    expect(await ring(page), 'no ring until hover').toBe('none');
    await page.hover(SEL.app);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    const on = await ring(page);
    // both tones present, inset, hugging the edge
    expect(on).toContain('inset');
    expect(on).toContain('rgba(255, 255, 255, 0.6)'); // light line (contrasts on dark pills)
    expect(on).toContain('rgba(0, 0, 0, 0.5)');        // dark line (contrasts on light pills)
    await page.dispatchEvent('html', 'mouseleave');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    expect(await ring(page), 'ring gone on leave').toBe('none');
  });
});

test.describe('single-file: controls visibility is a POSITIVE data-env="browser" gate (Q2)', () => {
  // The reveal gate is POSITIVE: controls show ONLY when data-env is exactly "browser".
  // A missing or garbage data-env must fall through to the base display:none — so the
  // Electron build (and any unknown env) can never accidentally show on-pill controls.
  const controlsDisplay = (page) =>
    page.evaluate(() => getComputedStyle(document.querySelector('#controls')).display);

  test('browser env shows the cluster; a garbage or absent data-env hides it (display:none)', async ({ page }) => {
    await openWidget(page);
    // The browser build boots with data-env="browser" -> cluster laid out.
    await expect(page.locator(SEL.app)).toHaveAttribute('data-env', 'browser');
    expect(await controlsDisplay(page)).toBe('flex');
    // A typo'd / unknown env is NOT "browser" -> hidden (the positive gate's whole point).
    await page.evaluate(() => document.querySelector('#app').setAttribute('data-env', 'desktop'));
    expect(await controlsDisplay(page)).toBe('none');
    // An absent data-env is not "browser" either -> still hidden.
    await page.evaluate(() => document.querySelector('#app').removeAttribute('data-env'));
    expect(await controlsDisplay(page)).toBe('none');
    // "electron" stays hidden, as always.
    await page.evaluate(() => document.querySelector('#app').setAttribute('data-env', 'electron'));
    expect(await controlsDisplay(page)).toBe('none');
  });
});

test.describe('single-file: persistence (localStorage)', () => {
  // PRD: "Remembers ... the episode's elapsed value between launches."
  test('run 5 s, pause, reload -> 00:00:05 and status paused', async ({ page }) => {
    await openWidget(page);
    await press(page, 'play');
    await advance(page, 5_000);
    await press(page, 'pause');
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await page.reload();
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
  });

  test('reload while RUNNING restores as paused with the banked value, no offline time added (D6)', async ({ page }) => {
    await openWidget(page);
    await press(page, 'play');
    await advance(page, 8_000);
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:08');
    await page.reload();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
    const before = await page.locator(SEL.stopwatch).innerText();
    expect(['00:00:07', '00:00:08']).toContain(before); // last pushed tick, +/- 1 s
    await advance(page, 60_000);
    await expect(page.locator(SEL.stopwatch)).toHaveText(before); // paused: frozen
  });

  test('a persisted Stopped(value) config restores frozen at its value', async ({ page }) => {
    // The Stop button is gone from the UI, but a config can still legitimately carry a
    // STOPPED timer with a banked value (a hand-edited file, or a value written by an
    // older build). It must come back read-only at that value — not zeroed, not running.
    await openWidget(page, { timer: { status: 'stopped', accumulatedMs: 3000, runningSince: null } });
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:03');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
    await advance(page, 60_000); // stopped: frozen, must not advance
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:03');
  });

  test('settings + timer are stored as a complete, valid config blob', async ({ page }) => {
    await openWidget(page);
    await press(page, 'play');
    await advance(page, 2_000);
    await press(page, 'pause');
    const blob = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(blob.schemaVersion).toBe(1);
    expect(blob.timer).toMatchObject({ status: 'paused' });
    expect(blob.timer.accumulatedMs).toBeGreaterThanOrEqual(2000);
    expect(Object.keys(blob.settings).sort()).toEqual(['alwaysOnTop', 'bgColor', 'customBgColor', 'customFont', 'customTextColor', 'cutout', 'font', 'hour12', 'layout', 'opacity', 'showClock', 'showSeconds', 'showStopwatch', 'textColor', 'textOpacity', 'useCustomFont']);
  });
});

test.describe('single-file: corrupt / hostile stored config', () => {
  // PRD: "Config must tolerate a missing or corrupt file ... never crash."
  for (const [name, raw] of [
    ['not JSON', '{not json'],
    ['JSON but wrong type', '"just a string"'],
    ['JSON array', '[1,2,3]'],
    ['empty string', ''],
    ['future schemaVersion', JSON.stringify({ schemaVersion: 99, settings: { opacity: 0.1 } })],
    ['nonsense timer', JSON.stringify({ schemaVersion: 1, timer: { status: 'running', accumulatedMs: 'lots' } })],
  ]) {
    test(`${name} -> defaults, widget still works`, async ({ page }) => {
      await openWidget(page, { raw });
      expect(page.pageErrors).toEqual([]);
      await expect(page.locator(SEL.time)).toHaveText('10:42');
      await expect(page.locator(SEL.meridiem)).toHaveText('AM');
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
      await press(page, 'play'); // still functional
      await advance(page, 2_000);
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:02');
    });
  }

  test('a restored "running" timer in storage comes back paused', async ({ page }) => {
    await openWidget(page, { timer: { status: 'running', accumulatedMs: 4000, runningSince: START_MS - 999999 }, settings: {} });
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:04');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
  });
});

// ---- v2 settings panel -------------------------------------------------------------------
// DOM contract: the panel is opened programmatically (tray/right-click "Settings…", via the
// debug hook in tests) -> #settings-panel[role=dialog] shown when #app[data-settings=open];
// tabs #tab-layout/#tab-font/#tab-colors (.is-active + aria-selected) over #panel-* (.tab-panel.is-active);
// tiles button.option[data-setting][data-value] marked BOTH .is-selected and aria-pressed="true".
test.describe('single-file: settings panel', () => {
  const TILE = (key, value) => `.option[data-setting="${key}"][data-value="${value}"]`;
  const GROUPS = ['layout', 'font', 'bgColor', 'textColor'];

  // A bigger viewport (same aspect as the default 240x130) so the tiles are comfortably clickable.
  async function openPanel(page, opts) {
    await openWidget(page, opts);
    await page.setViewportSize({ width: 960, height: 520 });
    // Wait for the ResizeObserver to actually OBSERVE the new width (RO callbacks are
    // delivered by the compositor in real time, independent of the fake clock), THEN flush
    // its settle timer. This leaves the fit in a settled, resting state with no late RO
    // in flight — otherwise a straggler callback can flip `settled` back to false right
    // after a subsequent pick and flake the fit assertions. (Before the on-pill controls
    // were removed, opening went through a hover+wait that happened to drain this; the
    // programmatic open is instant, so we drain it explicitly here.)
    await expect.poll(() => page.evaluate(() => window.__episodeTimer.fit().cw)).toBe(960);
    await advance(page, 200);
    await press(page, 'settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
  }
  // Tiles can sit in a non-active tab or a scrolled grid; dispatch the click so we test the
  // handler, not scroll geometry.
  const pick = (page, key, value) => page.locator(TILE(key, value)).dispatchEvent('click');
  const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').settings || {}, STORAGE_KEY);

  async function expectOneSelected(page, expected) {
    for (const g of GROUPS) {
      const sel = page.locator(`.option[data-setting="${g}"].is-selected`);
      const prs = page.locator(`.option[data-setting="${g}"][aria-pressed="true"]`);
      await expect(sel, `${g} .is-selected count`).toHaveCount(1);
      await expect(prs, `${g} aria-pressed count`).toHaveCount(1);
      await expect(sel).toHaveAttribute('data-value', expected[g]);
      await expect(prs).toHaveAttribute('data-value', expected[g]);
    }
  }

  test('panel starts closed and hidden; opening shows it, x closes it', async ({ page }) => {
    await openWidget(page);
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'closed');
    await expect(page.locator(SEL.panel)).toBeHidden();
    await press(page, 'settings'); // the tray/right-click "Settings…" path
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await expect(page.locator(SEL.panel)).toBeVisible();
    await expect(page.locator(SEL.panel)).toHaveAttribute('role', 'dialog');
    await page.locator(SEL.close).click();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'closed');
    await expect(page.locator(SEL.panel)).toBeHidden();
  });

  test('panel overlays the pill (covers the face area)', async ({ page }) => {
    await openPanel(page);
    const [p, a] = await Promise.all([page.locator(SEL.panel).boundingBox(), page.locator(SEL.app).boundingBox()]);
    expect(p.width).toBeGreaterThan(a.width * 0.5);
    expect(p.height).toBeGreaterThan(a.height * 0.5);
  });

  test('tabs: Layout is active by default; Font and Colors switch panels', async ({ page }) => {
    await openPanel(page);
    const tabs = { layout: ['#tab-layout', '#panel-layout'], font: ['#tab-font', '#panel-font'], colors: ['#tab-colors', '#panel-colors'] };
    const expectActive = async (which) => {
      for (const [name, [tab, pnl]] of Object.entries(tabs)) {
        const on = name === which;
        await expect(page.locator(tab), `${tab} .is-active`).toHaveClass(on ? /\bis-active\b/ : /^((?!is-active).)*$/);
        await expect(page.locator(tab)).toHaveAttribute('aria-selected', on ? 'true' : 'false');
        await expect(page.locator(tab)).toHaveAttribute('data-tab', name);
        await expect(page.locator(pnl)).toHaveClass(on ? /\bis-active\b/ : /^((?!is-active).)*$/);
        if (on) await expect(page.locator(pnl)).toBeVisible(); else await expect(page.locator(pnl)).toBeHidden();
      }
    };
    await expectActive('layout');
    await page.click('#tab-font');
    await expectActive('font');
    await page.click('#tab-colors');
    await expectActive('colors');
    await page.click('#tab-layout');
    await expectActive('layout');
  });

  test('tile inventory: 10 layouts, 9 curated fonts (+ a Custom tile), 9 bg presets + a picker, 9 text presets + a picker', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('button.option[data-setting="layout"]')).toHaveCount(10);
    // Colors: 9 PRESET option tiles per grid (beige dropped) + a picker swatch (no data-setting).
    await expect(page.locator('button.option[data-setting="bgColor"]')).toHaveCount(9);
    await expect(page.locator('button.option[data-setting="textColor"]')).toHaveCount(9);
    // courier was dropped -> 9 curated font presets, each a data-setting="font" option tile.
    await expect(page.locator('button.option[data-setting="font"]')).toHaveCount(9);
    // The Custom tile is a font-grid tile but NOT an enum option (no data-setting); it's
    // always present in the DOM (hidden only when the Local Font Access API is absent).
    await expect(page.locator('#font-custom-tile')).toHaveCount(1);
    await expect(page.locator('#font-custom-tile')).not.toHaveAttribute('data-setting', /.*/);
    // Each color grid's LAST cell is a picker swatch: an .option-picker with NO data-setting
    // (so the enum-select delegation skips it), carrying the dropper icon.
    await expect(page.locator('#bg-color-picker.option-picker')).toHaveCount(1);
    await expect(page.locator('#text-color-picker.option-picker')).toHaveCount(1);
    await expect(page.locator('#bg-color-picker')).not.toHaveAttribute('data-setting', /.*/);
    await expect(page.locator('#text-color-picker')).not.toHaveAttribute('data-setting', /.*/);
    await expect(page.locator('#bg-color-picker .picker-dropper svg')).toHaveCount(1);
    // the removed name bar is gone, and beige is no longer a bg swatch
    await expect(page.locator('#font-namebar')).toHaveCount(0);
    await expect(page.locator('.option[data-setting="bgColor"][data-value="#f5f5dc"]')).toHaveCount(0);
  });

  test('defaults: exactly one tile selected per group, matching the defaults', async ({ page }) => {
    await openPanel(page);
    await expectOneSelected(page, { layout: 'stack', font: 'system', bgColor: '#000000', textColor: '#ffffff' });
  });

  test('selecting a LAYOUT applies data-layout, persists, survives reload', async ({ page }) => {
    await openPanel(page);
    await pick(page, 'layout', 'stopwatch-hero');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'stopwatch-hero');
    await expect.poll(async () => (await stored(page)).layout).toBe('stopwatch-hero');
    await page.reload();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'stopwatch-hero');
    await expect(page.locator(TILE('layout', 'stopwatch-hero'))).toHaveClass(/is-selected/);
  });

  test('every layout can be applied (all 10 data-layout values)', async ({ page }) => {
    await openPanel(page);
    for (const l of ['stack', 'stopwatch-top', 'clock-left', 'side-by-side', 'split', 'one-line', 'dash', 'clock-hero', 'stopwatch-hero', 'centered-gap']) {
      await pick(page, 'layout', l);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', l);
    }
  });

  test('layouts keep both readouts in the DOM and visible (clock + stopwatch)', async ({ page }) => {
    await openPanel(page);
    await page.locator(SEL.close).click().catch(() => {});
    for (const l of ['stack', 'one-line', 'split', 'clock-hero']) {
      await pick(page, 'layout', l);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', l);
      await expect(page.locator(SEL.time)).toBeAttached();
      await expect(page.locator(SEL.stopwatch)).toBeAttached();
    }
  });

  test('selecting a FONT applies computed font-family + --font, persists, survives reload', async ({ page }) => {
    await openPanel(page);
    await page.click('#tab-font');
    await pick(page, 'font', 'serif');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#app')).fontFamily)).toMatch(/Georgia|serif/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font'))).toMatch(/Georgia/);
    await expect.poll(async () => (await stored(page)).font).toBe('serif');
    await page.reload();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app')).fontFamily)).toMatch(/Georgia|serif/);
    await expect(page.locator(TILE('font', 'serif'))).toHaveAttribute('aria-pressed', 'true');
  });

  test('selecting a BACKGROUND color sets --bg-rgb, derives data-theme, persists, survives reload', async ({ page }) => {
    await openPanel(page);
    await page.click('#tab-colors');
    await pick(page, 'bgColor', '#ffffff');
    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').replace(/\s/g, ''));
    await expect.poll(bg).toBe('255,255,255');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'light'); // derived, not a setting
    await expect.poll(async () => (await stored(page)).bgColor).toBe('#ffffff');
    expect((await stored(page)).theme).toBeUndefined();
    await page.reload();
    expect(await bg()).toBe('255,255,255');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'light');
    await pick(page, 'bgColor', '#1a1a2e');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'dark');
    await expect.poll(bg).toBe('26,26,46');
  });

  test('selecting a TEXT color sets --text-color and the numerals use it; persists across reload', async ({ page }) => {
    await openPanel(page);
    await page.click('#tab-colors');
    await pick(page, 'textColor', '#f5c518');
    const txt = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim().toLowerCase());
    await expect.poll(txt).toBe('#f5c518');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#clock-time')).color)).toBe('rgb(245, 197, 24)');
    await expect.poll(async () => (await stored(page)).textColor).toBe('#f5c518');
    await page.reload();
    expect(await txt()).toBe('#f5c518');
  });

  test('exactly ONE tile selected per group after many changes, and after a reload (reflect)', async ({ page }) => {
    await openPanel(page);
    await pick(page, 'layout', 'dash');
    await pick(page, 'layout', 'split');
    await pick(page, 'font', 'mono');
    await pick(page, 'font', 'palatino');
    await pick(page, 'bgColor', '#004e64');
    await pick(page, 'bgColor', '#2d132c');
    await pick(page, 'textColor', '#4ade80');
    await pick(page, 'textColor', '#ff6b6b');
    const want = { layout: 'split', font: 'palatino', bgColor: '#2d132c', textColor: '#ff6b6b' };
    await expectOneSelected(page, want);
    await page.reload();
    await press(page, 'settings');
    await expectOneSelected(page, want);
  });

  test('reflect(): seeded settings are what the panel highlights on first open', async ({ page }) => {
    const want = { layout: 'one-line', font: 'trebuchet', bgColor: '#ffffff', textColor: '#111111' };
    await openWidget(page, { settings: { ...want } });
    await press(page, 'settings');
    await expectOneSelected(page, want);
  });

  test('a saved font:"courier" (dropped preset) normalizes to the default and highlights System', async ({ page }) => {
    await openWidget(page, { settings: { font: 'courier' } });
    await press(page, 'settings');
    // The enum fallback coerces the removed preset to 'system', so the System tile is the one selected.
    await expectOneSelected(page, { layout: 'stack', font: 'system', bgColor: '#000000', textColor: '#ffffff' });
    await expect(page.locator(TILE('font', 'courier'))).toHaveCount(0); // the courier tile is gone
  });

  test('changing the layout at runtime re-measures and re-settles the fit (ends crisp)', async ({ page }) => {
    // A layout change moves the face's natural box WITHOUT changing any text length,
    // so it must force a re-measure (the per-tick length signature won't catch it)
    // and then settle straight to a crisp baked font-size.
    await openPanel(page);
    const fit = () => page.evaluate(() => window.__episodeTimer.fit());
    const before = (await fit()).measureCount;
    await pick(page, 'layout', 'side-by-side');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'side-by-side');
    await expect.poll(async () => (await fit()).measureCount).toBeGreaterThan(before);
    const info = await fit();
    expect(info.settled).toBe(true); // settings changes go straight to the baked font-size
    expect(info.transform === 'none' || info.transform === '').toBe(true);
    expect(parseFloat(info.fontSize)).toBeGreaterThan(0);
    expect(info.fontSize).not.toMatch(/NaN/);
  });

  test('changing settings in the panel does not disturb the stopwatch', async ({ page }) => {
    await openWidget(page);
    await press(page, 'play');
    await advance(page, 4_000);
    await press(page, 'settings');
    await pick(page, 'layout', 'dash');
    await advance(page, 2_000);
    await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:06');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
  });
});

// ---- Colors tab: TWO opacity sliders (background + text), centered swatch grids -------------
// The Colors tab now carries a background-opacity slider UNDER the bg swatch grid (the existing
// `opacity` -> --pill-opacity) and a text-opacity slider UNDER the text swatch grid (the new
// `textOpacity` -> --text-opacity, the alpha of the numerals). Both persist through the normal
// onSelect path, and the live preview mirrors both.
test.describe('single-file: Colors tab — two opacity sliders', () => {
  const TILE = (key, value) => `.option[data-setting="${key}"][data-value="${value}"]`;
  const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').settings || {}, STORAGE_KEY);
  const setSlider = (page, sel, v) => page.locator(sel).evaluate((el, val) => {
    el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  // Parse a computed "rgb(a)(...)" color into {r,g,b,a} (a defaults to 1 when the browser
  // reports the opaque rgb() form).
  const parseColor = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  async function openColors(page, opts) {
    await openWidget(page, opts);
    await page.setViewportSize({ width: 960, height: 560 });
    await press(page, 'settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await page.click('#tab-colors');
    await expect(page.locator('#panel-colors')).toHaveClass(/is-active/);
    return page;
  }

  test('the Colors tab shows exactly two sliders, one under each swatch grid', async ({ page }) => {
    await openColors(page);
    await expect(page.locator('#panel-colors .color-slider')).toHaveCount(2);
    // Section 1 = background: its swatch grid holds the 9 bgColor preset tiles (+ the picker
    // swatch, no data-setting) AND the bg slider.
    const bgSection = page.locator('#panel-colors .color-section').nth(0);
    await expect(bgSection.locator('.option[data-setting="bgColor"]')).toHaveCount(9);
    await expect(bgSection.locator('#bg-color-picker')).toHaveCount(1);
    await expect(bgSection.locator('#opacity-slider')).toHaveCount(1);
    await expect(bgSection.locator('#text-opacity-slider')).toHaveCount(0);
    // Section 2 = text: the 9 textColor preset tiles (+ the picker swatch) AND the text slider.
    const textSection = page.locator('#panel-colors .color-section').nth(1);
    await expect(textSection.locator('.option[data-setting="textColor"]')).toHaveCount(9);
    await expect(textSection.locator('#text-color-picker')).toHaveCount(1);
    await expect(textSection.locator('#text-opacity-slider')).toHaveCount(1);
    await expect(textSection.locator('#opacity-slider')).toHaveCount(0);
    // The slider sits BELOW its grid (greater top), proving the [grid][slider] order.
    const order = await page.evaluate(() => {
      const g = document.querySelector('#panel-colors .color-section .swatch-grid').getBoundingClientRect();
      const s = document.querySelector('#opacity-slider').getBoundingClientRect();
      return s.top >= g.top;
    });
    expect(order).toBe(true);
  });

  test('the background slider drives --pill-opacity live, incl. 0 = fully clear', async ({ page }) => {
    await openColors(page);
    const pillAlpha = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity')));
    await setSlider(page, '#opacity-slider', 0.3);
    await expect.poll(pillAlpha).toBeCloseTo(0.3, 2);
    // all the way to 0 = see-through pill (the real window is transparent, so this shows the desktop)
    await setSlider(page, '#opacity-slider', 0);
    await expect.poll(pillAlpha).toBe(0);
    const pill = await page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor);
    expect(parseColor(pill).a).toBe(0); // background alpha is genuinely 0
    await expect.poll(async () => (await stored(page)).opacity).toBe(0); // persisted via the normal path
  });

  test('the text slider drives --text-opacity + the numerals\' alpha, and the preview mirrors it', async ({ page }) => {
    await openColors(page);
    // Pick a non-default text color so an alpha change is unambiguous.
    await page.locator(TILE('textColor', '#4ade80')).dispatchEvent('click');
    const textVar = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-opacity')));
    await setSlider(page, '#text-opacity-slider', 0.5);
    await expect.poll(textVar).toBeCloseTo(0.5, 2);
    // the live widget's numerals now carry alpha 0.5...
    const clock = parseColor(await page.evaluate(() => getComputedStyle(document.querySelector('#clock-time')).color));
    expect(clock).toMatchObject({ r: 74, g: 222, b: 128 });
    expect(clock.a).toBeCloseTo(0.5, 2);
    // ...and the PREVIEW clock fades in lockstep (same :root var -> same alpha).
    const prev = parseColor(await page.evaluate(() => getComputedStyle(document.querySelector('#sp-time')).color));
    expect(prev.a).toBeCloseTo(0.5, 2);
    // to 0 = invisible numerals (alpha 0, no throw/NaN), persisted via the normal path
    await setSlider(page, '#text-opacity-slider', 0);
    await expect.poll(textVar).toBe(0);
    expect(parseColor(await page.evaluate(() => getComputedStyle(document.querySelector('#clock-time')).color)).a).toBe(0);
    await expect.poll(async () => (await stored(page)).textOpacity).toBe(0);
  });

  test('textOpacity persists and the slider reflects it on reload; opacity stays independent', async ({ page }) => {
    await openColors(page);
    await setSlider(page, '#opacity-slider', 0.6);
    await setSlider(page, '#text-opacity-slider', 0.25);
    await expect.poll(async () => (await stored(page)).opacity).toBe(0.6);
    await expect.poll(async () => (await stored(page)).textOpacity).toBe(0.25);
    await page.reload();
    await press(page, 'settings');
    await page.click('#tab-colors');
    // Both sliders reflect the stored values (reflect() syncs them on open).
    expect(await page.locator('#opacity-slider').inputValue()).toBe('0.6');
    expect(await page.locator('#text-opacity-slider').inputValue()).toBe('0.25');
    // and the two vars are applied independently
    const vars = await page.evaluate(() => ({
      pill: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity')),
      text: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-opacity')),
    }));
    expect(vars.pill).toBeCloseTo(0.6, 2);
    expect(vars.text).toBeCloseTo(0.25, 2);
  });

  test('both swatch grids are horizontally centered in the Colors tab (#10)', async ({ page }) => {
    await openColors(page);
    const gaps = await page.evaluate(() => {
      const body = document.querySelector('#panel-colors').getBoundingClientRect();
      return ['bgColor', 'textColor'].map((k) => {
        const g = document.querySelector(`.option[data-setting="${k}"]`).closest('.swatch-grid').getBoundingClientRect();
        return { left: g.left - body.left, right: body.right - g.right, width: g.width };
      });
    });
    for (const g of gaps) {
      // centered: left margin ≈ right margin (within a couple px), and the grid is
      // genuinely narrower than the tab (so there's real margin to balance).
      expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(2);
      expect(g.left).toBeGreaterThan(4);
    }
  });

  test('a knockout combo (bg opacity 0 + text opacity 0) never throws or yields NaN', async ({ page }) => {
    await openColors(page);
    await setSlider(page, '#opacity-slider', 0);
    await setSlider(page, '#text-opacity-slider', 0);
    expect(page.pageErrors).toEqual([]);
    const v = await page.evaluate(() => ({
      pill: getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity').trim(),
      text: getComputedStyle(document.documentElement).getPropertyValue('--text-opacity').trim(),
      clock: getComputedStyle(document.querySelector('#clock-time')).color,
      app: getComputedStyle(document.querySelector('#app')).backgroundColor,
    }));
    expect(v.pill).toBe('0');
    expect(v.text).toBe('0');
    expect(v.clock).not.toMatch(/NaN/);
    expect(v.app).not.toMatch(/NaN/);
  });
});

// ---- Colors tab: the custom color PICKER (wheel + square + hex, takeover) --------------------
// The last cell of each swatch grid is a picker swatch (#bg-color-picker / #text-color-picker).
// Clicking it opens a TAKEOVER (#app[data-colorpicker="open"]) with a [← Back] · title · [Save]
// header over a hue wheel + SV square + hex box. Dragging/typing LIVE-PREVIEWS onto the preview
// pill ONLY (inline --bg-rgb/--text-rgb override) — not committed/persisted until Save. Save
// commits bgColor/textColor AND customBgColor/customTextColor via the normal onSelect path; Back
// reverts. bgColor/textColor now hold ANY picked hex (the schema relaxed them off the enum).
test.describe('single-file: Colors tab — the custom color picker', () => {
  const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').settings || {}, STORAGE_KEY);
  const rootVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).replace(/\s/g, ''), name);
  const previewBg = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#settings-preview')).backgroundColor);
  const appBg = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor);
  const hexBox = (page) => page.locator('#cp-hex').inputValue();
  // Drag the SV square to a fractional position (0..1 of its box) via a dispatched pointerdown.
  const dragSquare = (page, fx, fy) => page.evaluate(({ fx, fy }) => {
    const sq = document.querySelector('#cp-square');
    const r = sq.getBoundingClientRect();
    sq.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, pointerId: 1, bubbles: true }));
  }, { fx, fy });
  const dragWheel = (page, deg) => page.evaluate((deg) => {
    const w = document.querySelector('#cp-hue');
    const r = w.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const rad = deg * Math.PI / 180, rr = r.width * 0.42;
    w.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx + rr * Math.cos(rad), clientY: cy + rr * Math.sin(rad), pointerId: 1, bubbles: true }));
  }, deg);

  async function openColors(page, opts) {
    await openWidget(page, opts);
    await page.setViewportSize({ width: 960, height: 560 });
    await press(page, 'settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await page.click('#tab-colors');
    await expect(page.locator('#panel-colors')).toHaveClass(/is-active/);
    return page;
  }

  test('clicking the bg picker swatch opens the takeover ("Choose background color", Back/Save)', async ({ page }) => {
    await openColors(page);
    await expect(page.locator(SEL.app)).not.toHaveAttribute('data-colorpicker', 'open');
    await page.click('#bg-color-picker');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-colorpicker', 'open');
    await expect(page.locator('#color-picker')).toBeVisible();
    await expect(page.locator('#cp-title')).toHaveText('Choose background color');
    await expect(page.locator('#cp-back')).toBeVisible();
    await expect(page.locator('#cp-save')).toBeVisible();
    // the tabs + tab panels are hidden by the takeover (same as the font browser)
    await expect(page.locator('.settings-tabs')).toBeHidden();
    await expect(page.locator('#panel-colors')).toBeHidden();
    // the live preview stays visible so the picked color can be seen live
    await expect(page.locator('#settings-preview')).toBeVisible();
  });

  test('the text picker swatch opens with the "Choose text color" title', async ({ page }) => {
    await openColors(page);
    await page.click('#text-color-picker');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-colorpicker', 'open');
    await expect(page.locator('#cp-title')).toHaveText('Choose text color');
  });

  test('typing a hex live-previews WITHOUT committing; Save commits bgColor + customBgColor', async ({ page }) => {
    await openColors(page);
    const rawBefore = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
    await page.click('#bg-color-picker');
    // type an off-palette hex -> the PREVIEW pill paints it live...
    await page.locator('#cp-hex').fill('#3b82f6');
    await expect.poll(() => previewBg(page)).toBe('rgb(59, 130, 246)');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#cp-current')).backgroundColor)).toBe('rgb(59, 130, 246)');
    // ...but the REAL pill (:root var) + storage are UNCHANGED until Save.
    expect(await rootVar(page, '--bg-rgb')).toBe('0,0,0');
    expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe(rawBefore); // nothing persisted yet
    // Save commits: the real pill's --bg-rgb updates, bgColor AND customBgColor = the hex.
    await page.click('#cp-save');
    await expect(page.locator(SEL.app)).not.toHaveAttribute('data-colorpicker', 'open');
    await expect.poll(() => rootVar(page, '--bg-rgb')).toBe('59,130,246');
    await expect.poll(() => appBg(page)).toBe('rgb(59, 130, 246)');
    await expect.poll(async () => (await stored(page)).bgColor).toBe('#3b82f6');
    await expect.poll(async () => (await stored(page)).customBgColor).toBe('#3b82f6');
    // the picker swatch is now the selected tile; no preset is selected.
    await expect(page.locator('#bg-color-picker')).toHaveClass(/is-selected/);
    await expect(page.locator('.option[data-setting="bgColor"].is-selected')).toHaveCount(0);
  });

  test('Back reverts the live preview and commits nothing', async ({ page }) => {
    await openColors(page);
    const rawBefore = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
    await page.click('#bg-color-picker');
    await page.locator('#cp-hex').fill('#3b82f6');
    await expect.poll(() => previewBg(page)).toBe('rgb(59, 130, 246)');
    await page.click('#cp-back');
    await expect(page.locator(SEL.app)).not.toHaveAttribute('data-colorpicker', 'open');
    // preview reverted to the previously-active color (default black), nothing committed.
    await expect.poll(() => previewBg(page)).toBe('rgb(0, 0, 0)');
    expect(await rootVar(page, '--bg-rgb')).toBe('0,0,0');
    expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe(rawBefore); // nothing persisted
  });

  test('text picker Save commits textColor + customTextColor and paints the numerals', async ({ page }) => {
    await openColors(page);
    await page.click('#text-color-picker');
    await page.locator('#cp-hex').fill('#3b82f6');
    await page.click('#cp-save');
    await expect.poll(async () => (await stored(page)).textColor).toBe('#3b82f6');
    await expect.poll(async () => (await stored(page)).customTextColor).toBe('#3b82f6');
    await expect.poll(() => rootVar(page, '--text-rgb')).toBe('59,130,246');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#clock-time')).color)).toBe('rgb(59, 130, 246)');
    await expect(page.locator('#text-color-picker')).toHaveClass(/is-selected/);
  });

  test('HSV<->hex round-trips: hex -> square/wheel markers reflect it; dragging -> hex updates', async ({ page }) => {
    await openColors(page);
    await page.click('#bg-color-picker');
    // set a known hex -> the SV marker lands at (saturation, 1-value) and the hue marker moves.
    await page.locator('#cp-hex').fill('#3b82f6'); // s≈0.76, v≈0.965, hue≈217°
    const markers = await page.evaluate(() => ({
      sl: parseFloat(document.querySelector('.cp-sv-marker').style.left),
      st: parseFloat(document.querySelector('.cp-sv-marker').style.top),
      hl: parseFloat(document.querySelector('.cp-hue-marker').style.left),
    }));
    expect(markers.sl).toBeGreaterThan(70); expect(markers.sl).toBeLessThan(82); // saturation ~76%
    expect(markers.st).toBeLessThan(10); // value ~0.965 -> top ~3.5%
    // now DRAG the square to the middle -> hex must change to a valid new #rrggbb, and the
    // preview must agree with the hex box (same color from both paths). Blur the hex box first:
    // a real pointer on the canvas blurs it, but a synthetic pointerdown doesn't, and the box is
    // only re-synced when it isn't the focused element (so we don't fight a mid-type user).
    await page.evaluate(() => document.querySelector('#cp-hex').blur());
    await dragSquare(page, 0.5, 0.5);
    const hx = await hexBox(page);
    expect(hx).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hx).not.toBe('#3b82f6');
    const triplet = await page.evaluate((h) => { const n = parseInt(h.slice(1), 16); return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255); }, hx);
    await expect.poll(() => previewBg(page)).toBe('rgb(' + triplet + ')');
    // dragging the hue wheel also changes the hex (hue component)
    const before = await hexBox(page);
    await dragWheel(page, 120); // toward green
    expect(await hexBox(page)).not.toBe(before);
  });

  test('the picker swatch shows the remembered customBgColor even after a preset is picked', async ({ page }) => {
    await openColors(page);
    // mix + save a custom color
    await page.click('#bg-color-picker');
    await page.locator('#cp-hex').fill('#3b82f6');
    await page.click('#cp-save');
    await expect.poll(async () => (await stored(page)).customBgColor).toBe('#3b82f6');
    // now pick a PRESET: the active color changes, but the remembered custom is untouched...
    await page.locator('.option[data-setting="bgColor"][data-value="#000000"]').dispatchEvent('click');
    await expect.poll(async () => (await stored(page)).bgColor).toBe('#000000');
    await expect.poll(async () => (await stored(page)).customBgColor).toBe('#3b82f6'); // remembered
    // the preset tile is selected, the picker tile is not...
    await expect(page.locator('.option[data-setting="bgColor"][data-value="#000000"]')).toHaveClass(/is-selected/);
    await expect(page.locator('#bg-color-picker')).not.toHaveClass(/is-selected/);
    // ...yet the picker swatch chip STILL displays the remembered custom color.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#bg-color-picker .swatch-chip')).backgroundColor)).toBe('rgb(59, 130, 246)');
  });

  test('a custom (off-preset) active color on open: picker selected, no preset selected', async ({ page }) => {
    await openColors(page, { settings: { bgColor: '#123456', customBgColor: '#123456' } });
    await expect(page.locator('#bg-color-picker')).toHaveClass(/is-selected/);
    await expect(page.locator('.option[data-setting="bgColor"].is-selected')).toHaveCount(0);
    // seeding reopen also re-seeds the picker to the remembered custom
    await page.click('#bg-color-picker');
    await expect.poll(() => hexBox(page)).toBe('#123456');
  });

  test('seeding the picker: opens on the remembered customBgColor, not the active preset', async ({ page }) => {
    await openColors(page, { settings: { bgColor: '#000000', customBgColor: '#3b82f6' } });
    await page.click('#bg-color-picker');
    await expect.poll(() => hexBox(page)).toBe('#3b82f6'); // remembered, not the active #000000
  });
});

// ---- Colors tab: Cutout (knockout) mode + per-slider labels + preview outline ----------------
// Cutout is a Colors-tab checkbox UNDER the text-opacity slider. ON -> #app[data-cutout="true"]
// and paintCutout() draws the numerals onto a <canvas> with globalCompositeOperation =
// 'destination-out' (a CANVAS knockout), so the glyph pixels erase the opaque pill to alpha 0
// (over the transparent Electron window the DESKTOP shows through — verifiable only on the host;
// here we read back the canvas alpha / assert the CSS STATE). The text color is ignored (swatches grey out) and
// the text-opacity slider becomes the cutout STRENGTH. Also covers the two new slider labels and
// the preview's gray outline.
test.describe('single-file: Colors tab — cutout mode, slider labels, preview outline', () => {
  const TILE = (key, value) => `.option[data-setting="${key}"][data-value="${value}"]`;
  const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').settings || {}, STORAGE_KEY);
  const setSlider = (page, sel, v) => page.locator(sel).evaluate((el, val) => {
    el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const parseColor = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // Read back the PILL's cutout canvas: classify every pixel by alpha (0 = a real transparent
  // HOLE, 255 = opaque pill fill, in-between = a partial/faint erase) and sample a corner. This
  // is the proof the CSS path couldn't give — real alpha-0 holes punched where the glyphs are.
  const canvasStats = (page) => page.evaluate(() => {
    const c = [...document.querySelector('#app').children]
      .find((n) => n.tagName === 'CANVAS' && n.className.indexOf('et-cutout') !== -1);
    if (!c) return null;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    if (!W || !H) return { W, H, holes: 0, filled: 0, partial: 0, corner: null, display: getComputedStyle(c).display };
    const data = ctx.getImageData(0, 0, W, H).data;
    let holes = 0, filled = 0, partial = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a === 0) holes++; else if (a === 255) filled++; else partial++;
    }
    const corner = [...ctx.getImageData(1, 1, 1, 1).data];
    return { W, H, holes, filled, partial, corner, display: getComputedStyle(c).display };
  });
  const canvasDisplay = (page) => page.evaluate(() => {
    const c = [...document.querySelector('#app').children]
      .find((n) => n.tagName === 'CANVAS' && n.className.indexOf('et-cutout') !== -1);
    return c ? getComputedStyle(c).display : 'absent';
  });
  const faceVisibility = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#face')).visibility);
  async function openColors(page, opts) {
    await openWidget(page, opts);
    await page.setViewportSize({ width: 960, height: 560 });
    await press(page, 'settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await page.click('#tab-colors');
    await expect(page.locator('#panel-colors')).toHaveClass(/is-active/);
    return page;
  }

  test('each opacity slider has a gray label above it ("Background Opacity" / "Text Opacity")', async ({ page }) => {
    await openColors(page);
    const labels = page.locator('#panel-colors .settings-section.slider-label');
    await expect(labels).toHaveCount(2);
    await expect(labels.nth(0)).toHaveText('Background Opacity');
    await expect(labels.nth(1)).toHaveText('Text Opacity');
    // Each label sits directly ABOVE its slider (smaller/equal top than the slider).
    const order = await page.evaluate(() => {
      const secs = [...document.querySelectorAll('#panel-colors .color-section')];
      const bgLabel = secs[0].querySelector('.slider-label').getBoundingClientRect();
      const bgSlider = document.querySelector('#opacity-slider').getBoundingClientRect();
      const txLabel = secs[1].querySelector('.slider-label').getBoundingClientRect();
      const txSlider = document.querySelector('#text-opacity-slider').getBoundingClientRect();
      return bgLabel.top <= bgSlider.top && txLabel.top <= txSlider.top;
    });
    expect(order).toBe(true);
  });

  test('the preview pill has a gray outline/border so its bounds read against the dark panel', async ({ page }) => {
    await openColors(page);
    const b = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#settings-preview'));
      return { w: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor };
    });
    expect(parseFloat(b.w)).toBeGreaterThan(0);
    expect(b.style).toBe('solid');
    // SOLID, fully-OPAQUE mid-gray (#808080 = rgb(128,128,128), alpha 1). It used to be
    // rgba(128,128,128,0.5), which went see-through over the preview's checkerboard backing;
    // the opaque color draws a crisp bound in both the browser panel and the Electron window.
    const c = parseColor(b.color);
    expect(c.r).toBe(128); expect(c.g).toBe(128); expect(c.b).toBe(128);
    expect(c.a).toBe(1);
  });

  test('the Cutout checkbox sits directly under the text-opacity slider (unchecked by default)', async ({ page }) => {
    await openColors(page);
    await expect(page.locator('#cutout-checkbox')).toHaveCount(1);
    await expect(page.locator('#cutout-checkbox')).not.toBeChecked();
    await expect(page.locator('.cutout-caption')).toHaveText('Cutout');
    const under = await page.evaluate(() => {
      const slider = document.querySelector('#text-opacity-slider').getBoundingClientRect();
      const row = document.querySelector('#cutout-row').getBoundingClientRect();
      // the cutout row is BELOW the text slider, and inside the text (second) color-section
      const inText = document.querySelectorAll('#panel-colors .color-section')[1].contains(document.querySelector('#cutout-row'));
      return row.top >= slider.top && inText;
    });
    expect(under).toBe(true);
  });

  test('toggling Cutout ON builds the canvas, hides (keeps-in-layout) the face + makes #app bg transparent; OFF reverts', async ({ page }) => {
    await openColors(page);
    // OFF by default: no canvas, face visible, #app keeps its background.
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'false');
    expect(await canvasDisplay(page)).toMatch(/absent|none/);
    expect(await faceVisibility(page)).toBe('visible');
    // Turn cutout ON.
    await page.locator('#cutout-checkbox').check();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    // Canvas now present + displayed (the visible pill surface).
    await expect.poll(async () => (await canvasStats(page)) && (await canvasStats(page)).display).toBe('block');
    // The DOM face is HIDDEN but KEPT IN LAYOUT (so paintCutout can measure it): visibility
    // hidden, yet its readouts still report a real bounding box.
    expect(await faceVisibility(page)).toBe('hidden');
    expect(await page.evaluate(() => { const r = document.querySelector('#clock-time').getBoundingClientRect(); return r.width > 0 && r.height > 0; })).toBe(true);
    // #app's own background is transparent in cutout mode (the canvas provides the fill).
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    // persisted via the normal path
    await expect.poll(async () => (await stored(page)).cutout).toBe(true);
    // Turn it OFF -> canvas hidden, face visible again, #app background restored.
    await page.locator('#cutout-checkbox').uncheck();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'false');
    await expect.poll(() => canvasDisplay(page)).toBe('none');
    expect(await faceVisibility(page)).toBe('visible');
    await expect.poll(async () => (await stored(page)).cutout).toBe(false);
  });

  test('cutout punches REAL transparent holes: glyph pixels are alpha 0 over an opaque bg-colored fill', async ({ page }) => {
    // Seed a NON-black background so a non-glyph (filled) pixel unambiguously proves the canvas
    // is painted with the configured pill color, while glyph pixels are genuinely transparent.
    await openColors(page, { settings: { bgColor: '#1a1a2e' } }); // rgb(26,26,46)
    await page.locator('#cutout-checkbox').check();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    // Real holes exist (hundreds of fully-transparent glyph pixels), and the pill is mostly filled.
    await expect.poll(async () => { const s = await canvasStats(page); return s ? s.holes : 0; }).toBeGreaterThan(100);
    const s = await canvasStats(page);
    expect(s.filled).toBeGreaterThan(s.holes); // the pill is mostly solid; the holes are the glyphs
    // A non-glyph corner pixel is the configured background color, fully opaque...
    expect(s.corner[3]).toBe(255);
    expect([s.corner[0], s.corner[1], s.corner[2]]).toEqual([26, 26, 46]);
    // ...while the glyph region genuinely shows alpha-0 holes (this is what CSS could NOT do).
    expect(s.holes).toBeGreaterThan(0);
  });

  test('text-opacity is the cutout STRENGTH: full = alpha-0 holes, half = partial (faint) erase', async ({ page }) => {
    await openColors(page);
    await page.locator('#cutout-checkbox').check();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    // Full strength: real alpha-0 holes.
    await setSlider(page, '#text-opacity-slider', 1);
    await expect.poll(async () => { const s = await canvasStats(page); return s ? s.holes : 0; }).toBeGreaterThan(100);
    // Half strength: the glyph pixels are only PARTIALLY erased (alpha ~127), so they become
    // "partial" pixels, not full alpha-0 holes — a fainter cutout.
    await setSlider(page, '#text-opacity-slider', 0.5);
    await expect.poll(async () => { const s = await canvasStats(page); return s ? s.partial : 0; }).toBeGreaterThan(100);
    const half = await canvasStats(page);
    expect(half.holes).toBeLessThan(half.partial); // few/no full holes at half strength
  });

  test('holes ALIGN with the measured text boxes across layouts (incl. the separator layouts)', async ({ page }) => {
    // The knockout is drawn from MEASURED DOM run rects, so the holes must land inside the
    // readouts' boxes — no gross drift from the layout/fit. For each layout we count alpha-0
    // hole pixels that fall OUTSIDE the (slightly inflated) union of the readout rects; a tiny
    // fraction is tolerated (anti-aliased glyph edges, canvas vs. tabular-nums advance drift),
    // but a misaligned layout would spill holes well outside the boxes.
    await openColors(page);
    await page.locator('#cutout-checkbox').check();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');

    const outsideFractionFor = async (layout) => {
      await page.evaluate((l) => window.EpisodeTimerBridge.setSettings({ layout: l }), layout);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', layout);
      await advance(page, 200); // let the fit settle + redrawCutout run
      return page.evaluate(() => {
        const app = document.querySelector('#app');
        const appRect = app.getBoundingClientRect();
        const c = [...app.children].find((n) => n.tagName === 'CANVAS' && n.className.indexOf('et-cutout') !== -1);
        const ctx = c.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        // Inflated union of the readout run boxes (CSS px relative to #app).
        const face = document.querySelector('#face');
        const boxes = [];
        face.querySelectorAll('*').forEach((n) => {
          const cs = getComputedStyle(n);
          if (cs.display === 'none') return;
          if (n.children.length) {
            // a container: include it only if it owns a ::before glyph (the separator)
            const pb = getComputedStyle(n, '::before').content;
            if (!pb || pb === 'none' || pb === 'normal') return;
          }
          const r = n.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const padX = r.height * 0.35, padY = r.height * 0.25; // slop for baseline + advance drift
          boxes.push({ l: r.left - appRect.left - padX, t: r.top - appRect.top - padY, r: r.right - appRect.left + padX, b: r.bottom - appRect.top + padY });
        });
        const inAny = (x, y) => boxes.some((b) => x >= b.l && x <= b.r && y >= b.t && y <= b.b);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let holes = 0, outside = 0;
        for (let p = 0; p < c.width * c.height; p++) {
          if (data[p * 4 + 3] !== 0) continue;
          holes++;
          const cx = (p % c.width) / dpr, cy = Math.floor(p / c.width) / dpr;
          if (!inAny(cx, cy)) outside++;
        }
        return { holes, outside };
      });
    };

    for (const layout of ['stack', 'one-line', 'dash', 'clock-left', 'split']) {
      const { holes, outside } = await outsideFractionFor(layout);
      expect(holes, `${layout}: expected real holes`).toBeGreaterThan(100);
      expect(outside / holes, `${layout}: too many holes fall outside the measured text boxes`).toBeLessThan(0.02);
    }
  });

  test('the live preview also gets a knockout canvas in cutout mode (best-effort; reveals the panel backdrop)', async ({ page }) => {
    await openColors(page);
    await page.locator('#cutout-checkbox').check();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    // The in-page preview pill is a descendant of #app; it gets its OWN direct-child canvas
    // (never the pill's — directCutoutCanvas is scoped per host).
    await expect.poll(() => page.evaluate(() => {
      const pv = document.querySelector('#settings-preview');
      if (!pv) return 'no-preview';
      const c = [...pv.children].find((n) => n.tagName === 'CANVAS' && n.className.indexOf('et-cutout') !== -1);
      return c ? getComputedStyle(c).display : 'absent';
    })).toBe('block');
  });

  test('cutout ON greys + disables the text-color swatches (text-opacity slider stays active)', async ({ page }) => {
    await openColors(page);
    const firstTextSwatch = page.locator('.option[data-setting="textColor"]').first();
    // enabled when cutout is off
    expect(await firstTextSwatch.evaluate((el) => el.disabled)).toBe(false);
    await page.locator('#cutout-checkbox').check();
    // all text swatches disabled + greyed (opacity reduced)
    const info = await page.evaluate(() => {
      const sw = [...document.querySelectorAll('.option[data-setting="textColor"]')];
      return {
        allDisabled: sw.every((e) => e.disabled),
        allGrey: sw.every((e) => parseFloat(getComputedStyle(e).opacity) < 0.5),
        bgStillEnabled: [...document.querySelectorAll('.option[data-setting="bgColor"]')].every((e) => !e.disabled),
        textPickerDisabled: document.querySelector('#text-color-picker').disabled,
        bgPickerEnabled: !document.querySelector('#bg-color-picker').disabled,
        sliderEnabled: !document.querySelector('#text-opacity-slider').disabled,
      };
    });
    expect(info.allDisabled).toBe(true);
    expect(info.allGrey).toBe(true);
    expect(info.textPickerDisabled).toBe(true); // the text PICKER swatch is greyed too
    expect(info.bgPickerEnabled).toBe(true);    // the bg picker stays active
    expect(info.bgStillEnabled).toBe(true); // bg swatches unaffected
    expect(info.sliderEnabled).toBe(true);  // text-opacity (strength) stays active
    // re-enabled when cutout goes off
    await page.locator('#cutout-checkbox').uncheck();
    expect(await firstTextSwatch.evaluate((el) => el.disabled)).toBe(false);
  });

  test('cutout persists and the checkbox + data-cutout reflect it on reload (holes drawn on seeded-ON open)', async ({ page }) => {
    await openColors(page, { settings: { cutout: true } });
    // seeded ON: applied + reflected on first open (data-cutout + the checked box).
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    await expect(page.locator('#cutout-checkbox')).toBeChecked();
    // real holes are drawn without any further interaction
    await expect.poll(async () => { const s = await canvasStats(page); return s ? s.holes : 0; }).toBeGreaterThan(100);
    // flip off, reload, confirm it stuck
    await page.locator('#cutout-checkbox').uncheck();
    await expect.poll(async () => (await stored(page)).cutout).toBe(false);
    await page.reload();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-cutout', 'false');
  });
});

// ---- Font tab: the Custom tile + system-font browser ----------------------------------------
// The curated Font grid stays the clean default picker; its FIRST tile is "Custom", which opens
// a system-font browser that enumerates installed families via queryLocalFonts(). We STUB
// queryLocalFonts at the test layer (never in the app) with a controlled list — including a
// duplicate .family to prove dedupe and a very long name to prove the ellipsis — so the
// single-file build (which has no real one) can exercise the whole flow deterministically.
test.describe('single-file: Font tab Custom tile + system-font browser', () => {
  const LONG = 'Supercalifragilistic Extended Variable Display Condensed Oblique Family Name';
  // A controlled face list: Alpha Sans appears TWICE (two faces, one family) to prove dedupe;
  // the rest are distinct. Enough entries that the grid must scroll.
  const FACES = [
    { family: 'Alpha Sans', style: 'Regular' },
    { family: 'Alpha Sans', style: 'Bold' }, // duplicate family -> must collapse to one card
    { family: 'Beta Serif' },
    { family: 'Gamma Mono' },
    { family: LONG },
  ];
  for (let i = 0; i < 60; i++) FACES.push({ family: 'Filler Face ' + String(i).padStart(2, '0') });
  const UNIQUE = new Set(FACES.map((f) => f.family)).size; // families, not faces

  const liveFont = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font').trim());
  // The preview face's resolved font-family (what the host sees on the preview clock).
  const previewFont = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#sp-time')).fontFamily);
  const customSwatchFont = (page) => page.evaluate(() => document.querySelector('#font-custom-swatch').style.fontFamily);
  const TILE_FONT = (value) => `.option[data-setting="font"][data-value="${value}"]`;
  const storedCustom = (page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '{}').settings || {}).customFont, STORAGE_KEY);
  const storedUseCustom = (page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '{}').settings || {}).useCustomFont, STORAGE_KEY);

  async function openFontTab(page, opts = {}) {
    await openWidget(page, { queryLocalFonts: FACES, ...opts });
    await page.setViewportSize({ width: 960, height: 640 });
    await press(page, 'settings');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-settings', 'open');
    await page.click('#tab-font');
    await expect(page.locator('#panel-font')).toHaveClass(/is-active/);
    return page;
  }

  test('Custom is the FIRST tile, labelled "Custom"; the name bar is gone; clicking it opens the browser', async ({ page }) => {
    await openFontTab(page);
    // the removed name bar / Edit button are gone entirely
    await expect(page.locator('#font-namebar')).toHaveCount(0);
    await expect(page.locator('#font-edit-btn')).toHaveCount(0);
    // Custom is the first tile in the font grid, and its caption is literally "Custom".
    const first = page.locator('#panel-font .option-grid > *').first();
    await expect(first).toHaveAttribute('id', 'font-custom-tile');
    await expect(page.locator('#font-custom-tile .option-caption')).toHaveText('Custom');
    await expect(page.locator('#font-custom-tile')).toBeVisible();
    // clicking it opens the system-font browser
    await page.click('#font-custom-tile');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-fontbrowser', 'open');
    await expect(page.locator('#font-browser')).toBeVisible();
  });

  test('opening the browser hides the tabs + tiles; header reads "Choose system font"', async ({ page }) => {
    await openFontTab(page);
    await page.click('#font-custom-tile');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-fontbrowser', 'open');
    await expect(page.locator('.settings-tabs')).toBeHidden();
    await expect(page.locator('#panel-font .option-grid')).toBeHidden();
    // the 3-part header, with the renamed title
    await expect(page.locator('#fb-back')).toBeVisible();
    await expect(page.locator('.fb-title')).toHaveText('Choose system font');
    await expect(page.locator('#fb-save')).toBeVisible();
  });

  test('grid: one card per family (dedupe), sorted, 3 columns', async ({ page }) => {
    await openFontTab(page);
    await page.click('#font-custom-tile');
    await expect(page.locator('#fb-grid .fb-card')).toHaveCount(UNIQUE); // deduped by family
    await expect(page.locator('.fb-card[data-family="Alpha Sans"]')).toHaveCount(1);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('#fb-grid')).gridTemplateColumns.trim().split(/\s+/).length);
    expect(cols).toBe(3);
    await expect(page.locator('#fb-grid .fb-card').first()).toHaveAttribute('data-family', 'Alpha Sans');
  });

  test('a card preview renders in its own family; long names get ellipsis', async ({ page }) => {
    await openFontTab(page);
    await page.click('#font-custom-tile');
    const card = page.locator('.fb-card[data-family="Beta Serif"]');
    const famCss = await card.locator('.fb-preview').evaluate((el) => el.style.fontFamily);
    expect(famCss.replace(/\s/g, '')).toContain('"BetaSerif"');
    const nameCss = await page.locator(`.fb-card[data-family="${LONG}"] .fb-cardname`).evaluate((el) => {
      const s = getComputedStyle(el);
      return { overflow: s.textOverflow, wrap: s.whiteSpace };
    });
    expect(nameCss.overflow).toBe('ellipsis');
    expect(nameCss.wrap).toBe('nowrap');
  });

  test('clicking a card LIVE-UPDATES THE PREVIEW only: preview font changes, the real --font does NOT; stays in choose mode', async ({ page }) => {
    await openFontTab(page);
    const beforeLive = await liveFont(page);
    await page.click('#font-custom-tile');
    await page.click('.fb-card[data-family="Gamma Mono"]');
    // card highlighted
    await expect(page.locator('.fb-card[data-family="Gamma Mono"]')).toHaveClass(/is-selected/);
    await expect(page.locator('.fb-card[data-family="Gamma Mono"]')).toHaveAttribute('aria-pressed', 'true');
    // PREVIEW font changed to the browsed family...
    await expect.poll(() => previewFont(page)).toContain('Gamma Mono');
    // ...while the REAL widget's --font is untouched and nothing was persisted, and we're still browsing.
    expect(await liveFont(page)).toBe(beforeLive);
    expect(await storedCustom(page)).toBeFalsy();
    await expect(page.locator(SEL.app)).toHaveAttribute('data-fontbrowser', 'open');
  });

  test('Save commits: applies to the real widget (--font + customFont + useCustomFont), Custom tile selected, its sample in that family', async ({ page }) => {
    await openFontTab(page);
    await page.click('#font-custom-tile');
    await page.click('.fb-card[data-family="Gamma Mono"]');
    await page.click('#fb-save');
    await expect(page.locator(SEL.app)).not.toHaveAttribute('data-fontbrowser', 'open');
    await expect(page.locator('#font-browser')).toBeHidden();
    // the real --font now leads with the chosen family (available via the cached list)...
    await expect.poll(() => liveFont(page)).toContain('"Gamma Mono"');
    // ...and it persisted as customFont AND flipped the switch on (useCustomFont).
    await expect.poll(() => storedCustom(page)).toBe('Gamma Mono');
    await expect.poll(() => storedUseCustom(page)).toBe(true);
    // the Custom tile is the selected one, and NO curated tile is selected
    await expect(page.locator('#font-custom-tile')).toHaveClass(/is-selected/);
    await expect(page.locator('#font-custom-tile')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.option[data-setting="font"].is-selected')).toHaveCount(0);
    // the Custom tile's label is STILL "Custom" (never the family name), but its sample renders in the family
    await expect(page.locator('#font-custom-tile .option-caption')).toHaveText('Custom');
    expect(await customSwatchFont(page)).toContain('Gamma Mono');
  });

  test('Back reverts the preview to the prior font and does NOT commit', async ({ page }) => {
    await openFontTab(page);
    const beforeLive = await liveFont(page);
    const beforePreview = await previewFont(page);
    await page.click('#font-custom-tile');
    await page.click('.fb-card[data-family="Beta Serif"]');
    await expect.poll(() => previewFont(page)).toContain('Beta Serif'); // preview moved...
    await page.click('#fb-back');
    await expect(page.locator(SEL.app)).not.toHaveAttribute('data-fontbrowser', 'open');
    // preview reverted to the previously-active font; real widget + storage untouched
    await expect.poll(() => previewFont(page)).toBe(beforePreview);
    expect(await liveFont(page)).toBe(beforeLive);
    expect(await storedCustom(page)).toBeFalsy();
    // and no curated tile got stolen — System (the default) is still the selected curated tile
    await expect(page.locator(TILE_FONT('system'))).toHaveClass(/is-selected/);
  });

  test('custom active -> NO curated tile is selected; picking a curated tile flips useCustomFont OFF but REMEMBERS customFont + de-selects Custom', async ({ page }) => {
    await openFontTab(page);
    // make a custom font genuinely active via the browser (Save populates the availability cache)
    await page.click('#font-custom-tile');
    await page.click('.fb-card[data-family="Gamma Mono"]');
    await page.click('#fb-save');
    await expect.poll(() => storedCustom(page)).toBe('Gamma Mono');
    await expect.poll(() => storedUseCustom(page)).toBe(true);
    // custom active -> Custom tile selected, zero curated tiles selected
    await expect(page.locator('#font-custom-tile')).toHaveClass(/is-selected/);
    await expect(page.locator('.option[data-setting="font"].is-selected')).toHaveCount(0);
    // now pick a curated tile -> switch OFF, de-select Custom, select the curated tile, apply serif
    await page.locator(TILE_FONT('serif')).dispatchEvent('click');
    await expect.poll(() => storedUseCustom(page)).toBe(false);
    await expect.poll(() => liveFont(page)).toMatch(/Georgia|serif/);
    await expect(page.locator('#font-custom-tile')).not.toHaveClass(/is-selected/);
    await expect(page.locator('#font-custom-tile')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(TILE_FONT('serif'))).toHaveClass(/is-selected/);
    // ...but customFont is REMEMBERED (not wiped), and the Custom tile's sample still shows it.
    await expect.poll(() => storedCustom(page)).toBe('Gamma Mono');
    expect(await customSwatchFont(page)).toContain('Gamma Mono');
    // re-opening the browser pre-selects the remembered family AND scrolls it into view (centered
    // in the grid's own scroll viewport, not off-screen) — reliable on a fresh open.
    await page.click('#font-custom-tile');
    await expect(page.locator('.fb-card[data-family="Gamma Mono"]')).toHaveClass(/is-selected/);
    const within = await page.evaluate(() => {
      const g = document.querySelector('#fb-grid').getBoundingClientRect();
      const c = document.querySelector('.fb-card.is-selected').getBoundingClientRect();
      // the selected card's vertical center sits inside the grid's visible viewport
      const mid = (c.top + c.bottom) / 2;
      return mid >= g.top && mid <= g.bottom;
    });
    expect(within).toBe(true);
  });

  test('picking a curated tile REMEMBERS the custom font even when it was never switched on', async ({ page }) => {
    // Seeded customFont with useCustomFont default false (curated 'system' is the active face).
    await openFontTab(page, { settings: { customFont: 'Gamma Mono' } });
    await page.locator(TILE_FONT('serif')).dispatchEvent('click');
    // the curated pick applies, flips the switch off (already off), and leaves customFont intact.
    await expect.poll(() => storedUseCustom(page)).toBe(false);
    await expect.poll(() => liveFont(page)).toMatch(/Georgia|serif/);
    await expect.poll(() => storedCustom(page)).toBe('Gamma Mono');
  });

  test('the card grid scrolls INDEPENDENTLY (its own overflow-y), not the whole panel', async ({ page }) => {
    await openFontTab(page);
    await page.click('#font-custom-tile');
    const info = await page.evaluate(() => {
      const g = document.querySelector('#fb-grid');
      const panel = document.querySelector('#settings-panel');
      return { overflowY: getComputedStyle(g).overflowY, gridScrollable: g.scrollHeight > g.clientHeight + 1, panelOverflowBefore: panel.scrollTop };
    });
    expect(info.overflowY).toBe('auto');
    expect(info.gridScrollable).toBe(true);
    const moved = await page.evaluate(() => {
      const g = document.querySelector('#fb-grid');
      const panel = document.querySelector('#settings-panel');
      g.scrollTop = 200;
      return { gridTop: g.scrollTop, panelTop: panel.scrollTop };
    });
    expect(moved.gridTop).toBeGreaterThan(0);
    expect(moved.panelTop).toBe(0);
  });

  test('when queryLocalFonts is ABSENT (plain browser build) the Custom tile is hidden/disabled', async ({ page }) => {
    await openWidget(page, { queryLocalFonts: null }); // force the API absent
    await page.setViewportSize({ width: 960, height: 640 });
    await press(page, 'settings');
    await page.click('#tab-font');
    await expect(page.locator('#font-custom-tile')).toBeHidden();
    const disabled = await page.locator('#font-custom-tile').evaluate((el) => el.disabled);
    expect(disabled).toBe(true);
  });

  // Feature C: every tile's "10:42" sample must stay INSIDE its card (no glyph bleeding past
  // the edges), for ALL fonts — proven by measuring the sample's rendered box against the card's
  // box with a padding margin. The per-tile fit (fitFontSwatches -> shrink-to-contain) is what
  // guarantees this across the wide faces (System/Serif/Helvetica) that used to overflow.
  test('every tile sample fits inside its card with padding (no bleed), across all fonts', async ({ page }) => {
    await openFontTab(page);
    const MARGIN = 7; // px tolerance; the fit targets ~12px inset, so this is comfortably safe
    // The fit runs a frame after the Font tab activates, so poll until the (binding) horizontal
    // axis is contained for every tile — that also confirms the fit actually ran.
    const measure = () => page.evaluate((m) => {
      const out = [];
      document.querySelectorAll('#panel-font .option-font').forEach((card) => {
        const sw = card.querySelector('.font-swatch'); if (!sw) return;
        const c = card.getBoundingClientRect(), s = sw.getBoundingClientRect();
        out.push({
          label: ((card.querySelector('.option-caption') || {}).textContent || card.id).trim(),
          hOk: s.left >= c.left + m && s.right <= c.right - m,
          vOk: s.top >= c.top + m && s.bottom <= c.bottom - m,
        });
      });
      return out;
    }, MARGIN);
    await expect.poll(async () => (await measure()).every((r) => r.hOk)).toBe(true);
    // Now assert BOTH axes per tile with a legible per-font failure message.
    const results = await measure();
    expect(results.length).toBe(10); // 9 curated presets + the Custom tile
    for (const r of results) {
      expect(r.hOk, `${r.label}: sample bleeds past the card horizontally`).toBe(true);
      expect(r.vOk, `${r.label}: sample bleeds past the card vertically`).toBe(true);
    }
  });
});

// ---- Missing-font fallback: never render a blank/broken face --------------------------------
test.describe('single-file: customFont missing-font fallback', () => {
  const BOGUS = 'Definitely Not A Real Font 12345';

  test('a customFont that is not installed falls back to the curated default (no throw, visible face)', async ({ page }) => {
    // useCustomFont ON + a bogus family: this is the branch where the switch is on but the
    // family isn't installed, which must still fall back to the curated face (never blank).
    await openWidget(page, { settings: { customFont: BOGUS, useCustomFont: true, font: 'system' } });
    expect(page.pageErrors).toEqual([]); // no throw
    // --font resolves to the curated default stack, NOT the bogus family.
    const f = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font').trim());
    expect(f).not.toContain(BOGUS);
    expect(f).toMatch(/-apple-system|system-ui|sans-serif/); // the curated 'system' stack
    // the clock still renders a real face
    await expect(page.locator(SEL.time)).toHaveText('10:42');
    const rendered = await page.evaluate(() => getComputedStyle(document.querySelector('#clock-time')).fontFamily);
    expect(rendered).not.toContain(BOGUS);
  });

  test('an uninstalled custom font (switch ON) does NOT select the Custom tile; the curated tile stays selected', async ({ page }) => {
    await openWidget(page, { settings: { customFont: BOGUS, useCustomFont: true, font: 'serif' } });
    await page.setViewportSize({ width: 960, height: 640 });
    await press(page, 'settings');
    await page.click('#tab-font');
    // custom font is NOT active (uninstalled) -> Custom tile is NOT selected...
    await expect(page.locator('#font-custom-tile')).not.toHaveClass(/is-selected/);
    await expect(page.locator('#font-custom-tile')).toHaveAttribute('aria-pressed', 'false');
    // ...and the curated 'serif' tile IS the selected one (the rendered fallback face).
    await expect(page.locator('.option[data-setting="font"][data-value="serif"]')).toHaveClass(/is-selected/);
    // the Custom tile's sample falls back to the neutral system stack, never the bogus family.
    const swatchFont = await page.evaluate(() => document.querySelector('#font-custom-swatch').style.fontFamily);
    expect(swatchFont).not.toContain(BOGUS);
  });
});

// ---- customFont availability: the measurement path + a positive-ONLY cache --------------
// These lock the two directions that had no coverage: (1) with NO queryLocalFonts cache, a
// genuinely-installed customFont is detected by width-measurement and APPLIED; (2) opening
// the font browser with a PARTIAL queryLocalFonts list must NOT poison availability — a cache
// MISS can never by itself declare an installed font unavailable (regression for the
// cache-poisoning bug). macOS Chromium ships these families, so they're reliable here.
test.describe('single-file: customFont availability + cache', () => {
  const liveFont = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font').trim());

  for (const fam of ['Georgia', 'Arial', 'Menlo']) {
    test(`cold load (no cache): installed "${fam}" is detected by measurement and applied`, async ({ page }) => {
      await openWidget(page, { settings: { customFont: fam, useCustomFont: true, font: 'system' } }); // no queryLocalFonts stub -> knownFamilies stays null
      expect(page.pageErrors).toEqual([]);
      await expect.poll(() => liveFont(page)).toContain('"' + fam + '"'); // measurement kept the installed family
      const active = await page.evaluate((f) => window.EpisodeTimerSettings.activeFontInfo({ font: 'system', customFont: f, useCustomFont: true }), fam);
      expect(active.customActive).toBe(true);
      expect(active.customName).toBe(fam);
    });
  }

  test('cache-poisoning regression: a PARTIAL queryLocalFonts list must not drop an installed customFont', async ({ page }) => {
    // customFont = Georgia (installed). The font browser enumerates a SUBSET that OMITS Georgia
    // (a realistic "user shared only some fonts" result). A later settings change re-applies.
    await openWidget(page, {
      settings: { customFont: 'Georgia', useCustomFont: true, font: 'system' },
      queryLocalFonts: [{ family: 'Arial' }], // subset WITHOUT Georgia
    });
    await page.setViewportSize({ width: 960, height: 640 });
    // Boot: measurement keeps Georgia.
    await expect.poll(() => liveFont(page)).toContain('"Georgia"');

    // Open the font browser (populates the cache with the Georgia-less subset), then back out.
    await press(page, 'settings');
    await page.click('#tab-font');
    await page.click('#font-custom-tile');
    await expect(page.locator(SEL.app)).toHaveAttribute('data-fontbrowser', 'open');
    await page.click('#fb-back');

    // Fire a settings change that does NOT touch the font (opacity), forcing a re-apply.
    await page.click('#tab-colors');
    await page.locator('#opacity-slider').evaluate((s) => { s.value = '0.8'; s.dispatchEvent(new Event('input', { bubbles: true })); });

    // The installed Georgia must STILL be the active font, and the Custom tile must still
    // reflect it — a cache miss must not mask a font that measurement/the OS can render.
    await expect.poll(() => liveFont(page)).toContain('"Georgia"');
    expect(await page.evaluate(() => window.EpisodeTimerSettings.fontAvailable('Georgia'))).toBe(true);
    await page.click('#tab-font');
    await expect(page.locator('#font-custom-tile')).toHaveClass(/is-selected/);
    expect(await page.evaluate(() => document.querySelector('#font-custom-swatch').style.fontFamily)).toContain('Georgia');
    await expect(page.locator('.option[data-setting="font"].is-selected')).toHaveCount(0);
  });
});

// ---- settings preview: fixed size + its own fit-to-box (#7 + #4) ----------------------------
// The preview box is a FIXED pixel size (~half the grown settings window) that must NOT track
// the real widget window, and the clock inside is scaled to FILL that box by app.js's own
// fit pass (independent of the widget's live #face scale).
test.describe('single-file: settings preview is fixed-size with its own fit', () => {
  const readPreview = (page) => page.evaluate(() => {
    const box = document.querySelector('#settings-preview');
    const br = box.getBoundingClientRect();
    const t = document.querySelector('#sp-time').getBoundingClientRect();
    const sw = document.querySelector('#sp-stopwatch').getBoundingClientRect();
    return { boxW: br.width, boxH: br.height, fontSize: parseFloat(getComputedStyle(box).fontSize), timeW: t.width, swW: sw.width };
  });

  async function openPreview(page, w, h) {
    await openWidget(page);
    await page.setViewportSize({ width: w, height: h });
    await press(page, 'settings');
    await expect(page.locator(SEL.panel)).toBeVisible();
    await advance(page, 200); // let a tick (and the open rAF) run the preview fit
    return page;
  }

  test('the preview box is a fixed px size (~360), not vmin, and does not track the widget window', async ({ page }) => {
    await openPreview(page, 960, 620);
    const a = await readPreview(page);
    // ~360px fixed (half the ~720 grown settings window), not the 62vmin-of-the-window it used to be.
    expect(a.boxW).toBeGreaterThan(330);
    expect(a.boxW).toBeLessThan(390);
    // Grow the "widget window" a lot: the preview box must NOT grow with it (it's fixed px).
    await page.setViewportSize({ width: 1400, height: 1000 });
    await advance(page, 200);
    const b = await readPreview(page);
    expect(Math.abs(b.boxW - a.boxW)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.boxH - a.boxH)).toBeLessThanOrEqual(1);
    // and the inner clock's baked font-size didn't change either (its box didn't change)
    expect(Math.abs(b.fontSize - a.fontSize)).toBeLessThanOrEqual(1);
  });

  test('the clock is scaled to FILL its own box (fits inside, and meaningfully fills it)', async ({ page }) => {
    await openPreview(page, 960, 620);
    const p = await readPreview(page);
    // the clock fits inside the fixed box...
    expect(p.timeW).toBeLessThanOrEqual(p.boxW + 0.5);
    expect(p.swW).toBeLessThanOrEqual(p.boxW + 0.5);
    // ...and it's actually filled (a real scale was applied, not left tiny at the base size)
    expect(p.fontSize).toBeGreaterThan(0);
    expect(Math.max(p.timeW, p.swW)).toBeGreaterThan(p.boxW * 0.4);
  });

  test('the preview fit is INDEPENDENT of the real widget #face scale', async ({ page }) => {
    // Resizing the widget re-scales the real #face (its baked font-size changes), but the
    // preview — a fixed box with its own fit — must keep its own font-size regardless.
    await openPreview(page, 900, 600);
    const faceFont1 = await page.evaluate(() => window.__episodeTimer.fit().fontSize);
    const pv1 = await readPreview(page);
    await page.setViewportSize({ width: 1300, height: 820 });
    // The ResizeObserver is driven by the compositor in real time (not the fake clock), so
    // wait for it to register the new width BEFORE advancing the fake clock to fire the
    // settle debounce (same pattern as the fit-to-fill hybrid suite).
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1300);
    await expect.poll(() => page.evaluate(() => window.__episodeTimer.fit().cw)).toBe(1300);
    await advance(page, 200);
    await expect.poll(() => page.evaluate(() => window.__episodeTimer.fit().settled)).toBe(true);
    const faceFont2 = await page.evaluate(() => window.__episodeTimer.fit().fontSize);
    const pv2 = await readPreview(page);
    // the real face DID rescale with the window...
    expect(parseFloat(faceFont2)).not.toBeCloseTo(parseFloat(faceFont1), 0);
    // ...while the preview's own font-size held steady.
    expect(Math.abs(pv2.fontSize - pv1.fontSize)).toBeLessThanOrEqual(1);
  });
});
