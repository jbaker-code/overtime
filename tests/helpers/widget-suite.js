// The assertions that are IDENTICAL in single-file (browser) and Electron mode. Each spec
// calls registerSharedWidgetTests(...) with a `ctx` that knows how to open/resize its world:
//
//   ctx.open({ settings? }) -> Promise<Page>   fresh widget, fake clock installed + frozen at
//                                              10:42:01, optional settings pre-seeded
//   ctx.resize(page, w, h)  -> Promise<void>   resize the "window" to w x h
//
// Maps to the PRD acceptance checklist (PRD.md "Acceptance checklist") - see comments.
const { SEL, advance, press, fontSizePx, hover } = require('./dom');

function registerSharedWidgetTests(test, expect, ctx, label) {
  test.describe(`${label}: wall clock`, () => {
    // PRD: "Wall clock HH:MM + small AM/PM, updating each second."
    test('renders HH:MM and AM/PM from the (fake) current time', async () => {
      const page = await ctx.open();
      await expect(page.locator(SEL.time)).toHaveText('10:42');
      await expect(page.locator(SEL.meridiem)).toHaveText('AM');
    });

    test('AM/PM is rendered smaller than the time', async () => {
      const page = await ctx.open();
      expect(await fontSizePx(page, SEL.meridiem)).toBeLessThan(await fontSizePx(page, SEL.time));
    });

    test('ticks: advancing 60 s moves the minute forward', async () => {
      const page = await ctx.open();
      await advance(page, 60_000);
      await expect(page.locator(SEL.time)).toHaveText('10:43');
    });

    test('crosses noon: 11:59 AM -> 12:00 PM', async () => {
      const page = await ctx.open();
      // JUMP the fake clock rather than running ~4,600 one-second ticks: setSystemTime
      // doesn't fire the intervening timers, and with per-tick fit-to-fill that burst is
      // needlessly slow (and flaky under load). Pump a single tick after each jump so the
      // display refreshes at the new time.
      await page.clock.setSystemTime(new Date('2026-10-31T11:59:00'));
      await advance(page, 1_000);
      await expect(page.locator(SEL.time)).toHaveText('11:59');
      await expect(page.locator(SEL.meridiem)).toHaveText('AM');
      await page.clock.setSystemTime(new Date('2026-10-31T12:00:00'));
      await advance(page, 1_000);
      await expect(page.locator(SEL.time)).toHaveText('12:00');
      await expect(page.locator(SEL.meridiem)).toHaveText('PM');
    });
  });

  test.describe(`${label}: episode stopwatch`, () => {
    // PRD: "Episode stopwatch HH:MM:SS with working Play/Pause/Reset."
    // Driven via the tray / right-click command path (the on-pill buttons are gone).
    // (Stop was removed on camera — Pause covers halt-and-keep; sw.stop() still lives
    // in the stopwatch MODEL, see stopwatch.unit.spec.js.)
    test('starts stopped at 00:00:00', async () => {
      const page = await ctx.open();
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
    });

    test('Play -> running, counts, 3661 s shows 01:01:01', async () => {
      const page = await ctx.open();
      await press(page, 'play');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
      await advance(page, 5_000);
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:05');
      await advance(page, 3_656_000);
      await expect(page.locator(SEL.stopwatch)).toHaveText('01:01:01');
    });

    test('Pause freezes the value; Play resumes from it (no catch-up)', async () => {
      const page = await ctx.open();
      await press(page, 'play');
      await advance(page, 10_000);
      await press(page, 'pause');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:10');
      await advance(page, 30_000); // paused: must not move
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:10');
      await press(page, 'play');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
      await advance(page, 5_000);
      // Display updates on a second-aligned tick (~5 ms after the boundary), so right after
      // 5 s of fake time it may still show the previous second: 14.x -> 15 either way is fine
      // as long as it resumed from 10 s (no catch-up for the 30 s paused). Pump one more tick
      // interval and the value must be exactly 15 or 16 s, never 10 + 35.
      await advance(page, 1_005);
      await expect(page.locator(SEL.stopwatch)).toHaveText(/^00:00:1[56]$/);
    });

    // Pass C removed ALL on-pill controls; this pass restored Play/Pause/Reset/Settings for
    // the BROWSER build only (a plain tab has no tray/native menu to drive the timer). The
    // cluster + its four buttons live in the DOM in BOTH builds — CSS alone decides whether
    // they show (visible-on-hover in browser, display:none in Electron), which each env's own
    // spec asserts. Here we lock the SHARED DOM truth: the cluster exists, there is NO Quit
    // (can't quit a web page) and NO Stop (never shipped), and the grip is still present.
    // The MODEL keeps sw.stop() — see stopwatch.unit.spec.js.
    test('the on-pill controls exist in the DOM (Play/Pause/Reset/Settings; no Quit/Stop); grip present', async () => {
      const page = await ctx.open();
      for (const id of ['#controls', '#btn-play', '#btn-pause', '#btn-reset', '#btn-settings']) {
        await expect(page.locator(id), id).toHaveCount(1);
      }
      for (const id of ['#btn-quit', '#btn-stop']) {
        await expect(page.locator(id), id).toHaveCount(0);
      }
      await expect(page.locator(SEL.grip)).toHaveCount(1); // grip is still in the DOM
    });

    test('Reset while RUNNING zeroes but KEEPS RUNNING (new behavior)', async () => {
      // New on-camera behavior: Reset mid-record restarts the count from zero WITHOUT
      // pausing — status stays running, elapsed re-anchors to now and keeps climbing.
      const page = await ctx.open();
      await press(page, 'play');
      await advance(page, 9_000);
      await press(page, 'reset');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
      // Still running -> climbs AGAIN FROM ZERO (not frozen, not continuing from ~9 s).
      // Reset lands at a non-second-aligned fake instant, so after 3 s the last
      // second-aligned tick shows 02 or 03 — either proves it restarted from zero.
      await advance(page, 3_000);
      await expect(page.locator(SEL.stopwatch)).toHaveText(/^00:00:0[23]$/);
    });

    test('Reset from Paused -> 00:00:00 (stopped)', async () => {
      const page = await ctx.open();
      await press(page, 'play');
      await advance(page, 9_000);
      await press(page, 'pause');
      await press(page, 'reset');
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
    });

    test('the wall clock keeps running regardless of stopwatch state', async () => {
      const page = await ctx.open();
      await advance(page, 120_000);
      await expect(page.locator(SEL.time)).toHaveText('10:44');
      await expect(page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    });
  });

  test.describe(`${label}: hover tints the pill via a 50%-black overlay`, () => {
    // The on-pill controls are gone; hover now fades in a 50%-black OVERLAY (#app::after)
    // so the user has a visible surface to grab/drag even over a transparent background.
    // It's an overlay (not a background swap) specifically so the CONFIGURED background
    // never animates — that was causing a startup/settings flash (see the no-flash test).
    const afterOpacity = (page) =>
      page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#app'), '::after').opacity));

    test('hover fades in the ::after overlay (50% black) WITHOUT changing #app background; leave fades it out', async () => {
      // Seed a NON-black opaque background so a hover tint would be obvious if it (wrongly)
      // landed on #app's own background. The whole point of the refactor is that it does NOT.
      const page = await ctx.open({ settings: { bgColor: '#1a1a2e', opacity: 1 } });
      await page.dispatchEvent('html', 'mouseleave');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
      // #app's OWN background stays the configured navy in BOTH states (no flash).
      await expect(page.locator(SEL.app)).toHaveCSS('background-color', 'rgb(26, 26, 46)');
      // The overlay is a separate layer: 50% black, hidden (opacity 0) when not hovered.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app'), '::after').backgroundColor)).toBe('rgba(0, 0, 0, 0.5)');
      await expect.poll(() => afterOpacity(page)).toBe(0);
      await hover(page);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
      await expect(page.locator(SEL.app)).toHaveCSS('background-color', 'rgb(26, 26, 46)'); // unchanged -> no flash
      await expect.poll(() => afterOpacity(page)).toBe(1); // overlay faded fully in
      await page.dispatchEvent('html', 'mouseleave');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
      await expect.poll(() => afterOpacity(page)).toBe(0); // and back out
    });

    test('no startup flash: #app has no background transition and the configured bg is applied immediately', async () => {
      const page = await ctx.open({ settings: { bgColor: '#1a1a2e', opacity: 1 } });
      // The regression was `#app { transition: background 150ms }` animating the configured
      // color in from default-black. The transition must NOT include background/background-color.
      const trans = await page.evaluate(() => getComputedStyle(document.querySelector('#app')).transitionProperty);
      expect(trans).not.toMatch(/\bbackground(-color)?\b/);
      // The configured color is present right away (no mid-animation value).
      await expect(page.locator(SEL.app)).toHaveCSS('background-color', 'rgb(26, 26, 46)');
    });

    test('readouts keep their size on hover (the hover tint must not resize the clock)', async () => {
      // The hover tint is a pure background change (no layout), so the readouts — which
      // fill the window via fitFace — must keep their size when hovering.
      const page = await ctx.open();
      const rect = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, sel);
      await page.dispatchEvent('html', 'mouseleave');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
      const idle = await rect(SEL.time);
      await page.hover(SEL.app);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
      await expect.poll(() => rect(SEL.time)).toBeCloseTo(idle, 0);
    });
  });

  test.describe(`${label}: resize scales content`, () => {
    // PRD: "resizable, and everything scales with the window."
    // NOTE: fit-to-fill is now a HYBRID (app.js). While the window is actively
    // resizing, #face is scaled with a cheap `transform: scale()` (instant, no
    // reflow); a short debounce after the last size change "settles" by baking the
    // scale into a real `font-size` (crisp glyphs) and clearing the transform.
    // Either way the face fills the window, so we measure the RENDERED box
    // (getBoundingClientRect reflects BOTH transforms and font-size). These tests
    // don't advance the fake clock, so they observe the mid-resize transform state;
    // the dedicated "hybrid" suite below locks the settle/at-rest behavior.
    const renderedW = (page, sel = SEL.time) =>
      page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, sel);

    test('doubling the window ~doubles the rendered type size (fit-to-fill)', async () => {
      const page = await ctx.open();
      await ctx.resize(page, 240, 130);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240);
      const small = await renderedW(page);
      await ctx.resize(page, 480, 260);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480);
      await expect.poll(async () => (await renderedW(page)) / small).toBeGreaterThan(1.8);
      expect((await renderedW(page)) / small).toBeLessThan(2.2);
    });

    test('stopwatch and meridiem scale too', async () => {
      const page = await ctx.open();
      await ctx.resize(page, 240, 130);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240);
      const [s1, m1] = [await renderedW(page, SEL.stopwatch), await renderedW(page, SEL.meridiem)];
      await ctx.resize(page, 480, 260);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480);
      await expect.poll(async () => (await renderedW(page, SEL.stopwatch)) / s1).toBeGreaterThan(1.8);
      expect((await renderedW(page, SEL.meridiem)) / m1).toBeGreaterThan(1.8);
    });
  });

  // Scoped to single-file: the fit machinery is pure renderer JS (app.js) shared
  // BYTE-FOR-BYTE by both builds, and headless Chromium lets us drive the ~120 ms
  // settle debounce deterministically with the fake clock — the right place to
  // assert settle timing. Re-running these as real-Electron window launches tests
  // nothing new in the renderer and only adds boot time + exposes the open() helper's
  // clock-install race ("cannot fast-forward to the past"). The live transform path
  // is still confirmed in the real app by the Electron "resize scales content" tests.
  var describeHybrid = (label === 'single-file') ? test.describe : test.describe.skip;
  describeHybrid(`${label}: fit-to-fill hybrid (smooth while resizing, crisp at rest)`, () => {
    // Locks the two-mode scaling that fixes (1) laggy resize and (2) soft/jaggy
    // text: a transform during an active resize (GPU composite, no reflow) and a
    // baked font-size once the drag goes quiet (re-rasterized, crisp). The fake
    // clock drives the ~120 ms settle debounce, so advancing it past SETTLE_MS is
    // what "settles" the fit here.
    const fitInfo = (page) => page.evaluate(() => window.__episodeTimer.fit());
    const isCleared = (t) => t === 'none' || t === '' || t === 'scale(1)';

    // Drive to a known settled state: resize, wait for the ResizeObserver to
    // register the new size (so the settle timer is actually armed for THIS size —
    // the RO callback is async and must land before we advance the fake clock),
    // then let the debounce fire.
    async function settleAt(page, w, h) {
      await ctx.resize(page, w, h);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(w);
      await expect.poll(async () => (await fitInfo(page)).cw).toBe(w);
      await advance(page, 200); // > SETTLE_MS -> the bake fires
      await expect.poll(async () => (await fitInfo(page)).settled).toBe(true);
      return fitInfo(page);
    }

    test('DURING a resize the face scales via transform, at the base font (no bake yet)', async () => {
      const page = await ctx.open();
      await settleAt(page, 240, 130);   // known settled starting point
      await ctx.resize(page, 480, 260); // begin a NEW resize; do NOT advance the clock
      await expect.poll(async () => (await fitInfo(page)).transform).toMatch(/scale\(/);
      const info = await fitInfo(page);
      expect(info.settled).toBe(false);
      // While dragging, the font-size drops back to the 100px base and the transform
      // carries the scale (so it's a pure composite, no per-frame reflow).
      expect(parseFloat(info.fontSize)).toBeCloseTo(100, 0);
      expect(info.transform).not.toBe('none');
    });

    test('AT REST the scale is baked into a real font-size and the transform is cleared', async () => {
      const page = await ctx.open();
      const small = await settleAt(page, 240, 130);
      expect(small.settled).toBe(true);
      expect(isCleared(small.transform), `transform at rest: ${small.transform}`).toBe(true);
      expect(parseFloat(small.fontSize)).toBeGreaterThan(0);
      expect(small.fontSize).not.toMatch(/NaN/);
      // A bigger pill settles to a BIGGER baked font-size (the face fills more pill).
      const big = await settleAt(page, 480, 260);
      expect(isCleared(big.transform)).toBe(true);
      expect(parseFloat(big.fontSize)).toBeGreaterThan(parseFloat(small.fontSize) * 1.5);
    });

    test('TABULAR font: the once-a-second tick forces NO re-measure (steady state is reflow-free)', async () => {
      // The default system font IS tabular, so the per-tick fast path applies: digit
      // churn keeps the length signature constant -> no reflow. (The proportional
      // counterpart below proves the correctness path for fonts that aren't.)
      const page = await ctx.open();
      await settleAt(page, 300, 200);
      expect((await fitInfo(page)).tabular, 'default font must probe as tabular').toBe(true);
      const before = (await fitInfo(page)).measureCount;
      await advance(page, 60_000); // 60 ticks, no resize
      expect((await fitInfo(page)).measureCount).toBe(before); // not one extra measurement
    });

    test('PROPORTIONAL font (serif): same-length, width-growing ticks re-fit and never clip the pill', async () => {
      // REGRESSION (the reviewer's confirmed bug): serif/Georgia ignores tabular-nums,
      // so "11:11:11" and "20:48:40" are the same length but different widths. The old
      // length-only signature never set dirty, the baked font-size went stale, and the
      // face grew past #app and was clipped by overflow:hidden. The face must keep
      // fitting as the clock ticks across such transitions.
      const page = await ctx.open({ settings: { font: 'serif', hour12: false, showSeconds: true } });
      await settleAt(page, 320, 150);
      expect((await fitInfo(page)).tabular, 'serif must probe as PROPORTIONAL').toBe(false);

      const faceVsApp = () => page.evaluate(() => {
        const f = document.querySelector('#face').getBoundingClientRect();
        const a = document.querySelector('#app');
        return { fw: f.width, fh: f.height, cw: a.clientWidth, ch: a.clientHeight };
      });

      // Narrow time first (all 1s) -> fit.
      await page.clock.setSystemTime(new Date('2026-10-31T11:11:10'));
      await advance(page, 1_000);
      await expect(page.locator(SEL.time)).toHaveText('11:11:11');
      const narrow = await faceVsApp();
      expect(narrow.fw).toBeLessThanOrEqual(narrow.cw + 0.5);
      const mcBefore = (await fitInfo(page)).measureCount;

      // Jump to a WIDER same-length time. Old code: no dirty, no re-measure, clip.
      await page.clock.setSystemTime(new Date('2026-10-31T20:48:39'));
      await advance(page, 1_000);
      await expect(page.locator(SEL.time)).toHaveText('20:48:40');
      // It must have RE-MEASURED (the content-based signature caught the width change)…
      expect((await fitInfo(page)).measureCount).toBeGreaterThan(mcBefore);
      // …and the rendered face must STILL fit inside the pill (never clipped).
      const wide = await faceVsApp();
      expect(wide.fw, `face width ${wide.fw} must fit app ${wide.cw}`).toBeLessThanOrEqual(wide.cw + 0.5);
      expect(wide.fh).toBeLessThanOrEqual(wide.ch + 0.5);
    });

    test('rapid resizes do NOT re-measure (natural ratio is cached; only the transform moves)', async () => {
      // This is the perf heart of the fix: a drag storm must not force a reflow per
      // frame. The natural box is measured once (font-independent), so every size
      // change after that is a cached-math + transform, zero re-measures.
      const page = await ctx.open();
      await settleAt(page, 300, 200);
      const before = (await fitInfo(page)).measureCount;
      for (const [w, h] of [[220, 120], [500, 300], [260, 180], [640, 200], [300, 300]]) {
        await ctx.resize(page, w, h);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(w);
      }
      expect((await fitInfo(page)).measureCount).toBe(before);
    });

    test('both readouts hidden: settling the blank pill never yields a NaN font-size or throws', async () => {
      const page = await ctx.open({ settings: { showClock: false, showStopwatch: false } });
      await ctx.resize(page, 360, 200);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(360);
      await advance(page, 200);
      const info = await fitInfo(page);
      expect(info.fontSize).not.toMatch(/NaN/);
      expect(info.transform).not.toMatch(/NaN/);
      await expect(page.locator(SEL.app)).toBeVisible();
    });
  });

  test.describe(`${label}: settings are wired (no UI)`, () => {
    // PRD: "forward-looking settings object ... wire the plumbing now."
    const SEED = { hour12: false, showSeconds: true, opacity: 0.9, bgColor: '#ffffff', textColor: '#111111', font: 'mono', layout: 'clock-hero' };

    test('seeded settings are applied to the DOM / CSS', async () => {
      const page = await ctx.open({ settings: SEED });
      await expect(page.locator(SEL.time)).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
      await expect(page.locator(SEL.meridiem)).toBeHidden();
      await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'light'); // DERIVED from bgColor luminance
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'clock-hero');
      const css = await page.evaluate(() => ({
        bgRgb: getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim(),
        opacity: getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity').trim(),
        font: getComputedStyle(document.querySelector('#app')).fontFamily,
      }));
      expect(parseFloat(css.opacity)).toBeCloseTo(0.9, 5);
      expect(css.font).toMatch(/Menlo|monospace/i);
      expect(css.bgRgb.replace(/\s/g, '')).toBe('255,255,255');
      expect(css.text.toLowerCase()).toBe('#111111');
    });

    test('24-hour + seconds use the fake time: 10:42:01', async () => {
      const page = await ctx.open({ settings: { hour12: false, showSeconds: true } });
      // freezeClock pauses at exactly :01.000; the aligned tick fires at :01.005, so pump a hair.
      await advance(page, 0);
      await expect(page.locator(SEL.time)).toHaveText('10:42:01');
    });

    test('defaults when nothing is seeded: black pill/white text/stack layout (derived theme dark), 12-hour, no seconds', async () => {
      const page = await ctx.open();
      await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator(SEL.time)).toHaveText(/^\d{2}:\d{2}$/);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'stack');
      const v = await page.evaluate(() => ({
        op: getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity').trim(),
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim(),
      }));
      expect(parseFloat(v.op)).toBeCloseTo(1.0, 5);
      expect(v.bg.replace(/\s/g, '')).toBe('0,0,0');
      expect(v.text.toLowerCase()).toBe('#ffffff');
    });

    test('out-of-range opacity clamped (7 -> 1); invalid layout/bgColor fall back to defaults', async () => {
      const page = await ctx.open({ settings: { opacity: 7, layout: 'diagonal', bgColor: '#123456' } });
      const op = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity').trim());
      expect(parseFloat(op)).toBe(1);
      await expect(page.locator(SEL.app)).toHaveAttribute('data-layout', 'stack'); // invalid enum -> default
      await expect(page.locator(SEL.app)).toHaveAttribute('data-theme', 'dark');
    });
  });

  test.describe(`${label}: clock / stopwatch visibility (tray toggles)`, () => {
    // Two boolean settings (default on), toggled from the menu-bar tray. Each hides its
    // own readout (and the separator); with BOTH off the pill is intentionally blank.
    test('defaults: both readouts visible', async () => {
      const page = await ctx.open();
      await expect(page.locator(SEL.app)).toHaveAttribute('data-show-clock', 'true');
      await expect(page.locator(SEL.app)).toHaveAttribute('data-show-stopwatch', 'true');
      await expect(page.locator(SEL.clock)).toBeVisible();
      await expect(page.locator(SEL.stopwatch)).toBeVisible();
    });

    test('showClock:false hides the clock, keeps the stopwatch', async () => {
      const page = await ctx.open({ settings: { showClock: false } });
      await expect(page.locator(SEL.app)).toHaveAttribute('data-show-clock', 'false');
      await expect(page.locator(SEL.clock)).toBeHidden();
      await expect(page.locator(SEL.stopwatch)).toBeVisible();
    });

    test('showStopwatch:false hides the stopwatch, keeps the clock', async () => {
      const page = await ctx.open({ settings: { showStopwatch: false } });
      await expect(page.locator(SEL.app)).toHaveAttribute('data-show-stopwatch', 'false');
      await expect(page.locator(SEL.stopwatch)).toBeHidden();
      await expect(page.locator(SEL.clock)).toBeVisible();
    });

    test('both off -> a blank pill (neither readout visible, window still fine)', async () => {
      const page = await ctx.open({ settings: { showClock: false, showStopwatch: false } });
      await expect(page.locator(SEL.clock)).toBeHidden();
      await expect(page.locator(SEL.stopwatch)).toBeHidden();
      await expect(page.locator(SEL.app)).toBeVisible();
    });
  });

  test.describe(`${label}: settings panel (UI)`, () => {
    // The v2 tabbed panel: the gear opens it; tabs are Layout / Font / Colors (NO
    // "Advanced" tab — float-on-top moved to the Electron menu-bar tray); the Colors
    // tab carries the opacity slider; a live preview mirrors the real clock. (Opening
    // it also grows the Electron window — that's covered by a dedicated electron test.)
    async function openPanel(page) {
      await press(page, 'settings'); // open programmatically (the tray/right-click path)
      await expect(page.locator(SEL.panel)).toBeVisible();
      return page;
    }

    test('opening the panel shows exactly three tabs (Layout/Font/Colors), no Advanced', async () => {
      const page = await openPanel(await ctx.open());
      await expect(page.locator('#tab-layout')).toBeVisible();
      await expect(page.locator('#tab-font')).toBeVisible();
      await expect(page.locator('#tab-colors')).toBeVisible();
      await expect(page.locator('#tab-advanced')).toHaveCount(0);
      await expect(page.locator('#float-on-top-toggle')).toHaveCount(0);
      expect(await page.locator('#settings-panel .settings-tabs .tab').count()).toBe(3);
    });

    test('clicking the Font tab activates the font panel', async () => {
      const page = await openPanel(await ctx.open());
      await expect(page.locator('#panel-layout')).toHaveClass(/is-active/);
      await page.click('#tab-font');
      await expect(page.locator('#panel-font')).toHaveClass(/is-active/);
      await expect(page.locator('#panel-layout')).not.toHaveClass(/is-active/);
    });

    test('the Colors-tab opacity slider changes --pill-opacity live', async () => {
      const page = await openPanel(await ctx.open());
      await page.click('#tab-colors');
      const slider = page.locator('#opacity-slider');
      await expect(slider).toBeVisible();
      // fill() refuses range inputs, so set the value and fire the input event directly.
      await slider.evaluate((el) => { el.value = '0.3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await expect
        .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity'))))
        .toBeCloseTo(0.3, 2);
    });

    test('the live preview mirrors the real clock value', async () => {
      const page = await openPanel(await ctx.open());
      await expect(page.locator('#settings-preview')).toBeVisible();
      const shown = await page.locator(SEL.time).innerText();
      await expect(page.locator('#sp-time')).toHaveText(shown);
    });
  });

  test.describe(`${label}: draggable by the face`, () => {
    // PRD: "Draggable by the clock face" — the whole pill (and the face) is a drag
    // region; the only interactive bit left on the pill, the grip, opts out with no-drag.
    test('#app and #face are -webkit-app-region:drag; the grip is no-drag', async () => {
      const page = await ctx.open();
      const region = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).getPropertyValue('-webkit-app-region'), sel);
      expect(await region(SEL.app)).toBe('drag');
      expect(await region(SEL.face)).toBe('drag');
      expect(await region(SEL.grip)).toBe('no-drag');
    });
  });

  test.describe(`${label}: look`, () => {
    // PRD: "Frameless, transparent, rounded; no OS chrome visible when idle."
    test('page/window background is transparent; the pill is rounded and SOLID by default', async () => {
      const page = await ctx.open();
      const s = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        html: getComputedStyle(document.documentElement).backgroundColor,
        radius: parseFloat(getComputedStyle(document.querySelector('#app')).borderTopLeftRadius),
        pill: getComputedStyle(document.querySelector('#app')).backgroundColor,
        op: getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity').trim(),
      }));
      expect(s.body).toBe('rgba(0, 0, 0, 0)'); // frameless/transparent window
      expect(s.html).toBe('rgba(0, 0, 0, 0)');
      expect(s.radius).toBeGreaterThan(0);      // rounded pill
      expect(s.pill).toMatch(/^rgba?\(/);       // a real background color
      expect(parseFloat(s.op)).toBeCloseTo(1, 5); // opacity now defaults to 1.0 (was 0.55)
    });

    test('the pill supports OS-level translucency (opacity < 1 -> alpha channel)', async () => {
      // The default is solid, but lowering opacity must make the pill genuinely see-through
      // (the OS-transparency feature the host wanted); the alpha lands in the computed color.
      const page = await ctx.open({ settings: { opacity: 0.4 } });
      const pill = await page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor);
      const m = pill.match(/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)$/);
      expect(m, `expected an rgba() with alpha, got "${pill}"`).not.toBeNull();
      expect(parseFloat(m[1])).toBeGreaterThan(0);
      expect(parseFloat(m[1])).toBeLessThan(1);
    });
  });
}

module.exports = { registerSharedWidgetTests };
