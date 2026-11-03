// REAL Electron via Playwright's _electron.  Project: electron.  HOST ONLY - this opens real
// windows for ~10-20 s ("headless" here means unattended). Skips cleanly when
// EPISODE_TIMER_SKIP_ELECTRON=1 or the Electron binary isn't installed (e.g. in the VM).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { launch, makeUserData, electronUnavailableReason } = require('./helpers/launch-electron');
const { SEL, START_MS, freezeClock, advance, press } = require('./helpers/dom');
const { registerSharedWidgetTests } = require('./helpers/widget-suite');

const skipReason = electronUnavailableReason();
test.skip(!!skipReason, `electron project skipped: ${skipReason}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readConfig = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const SETTINGS_KEYS = ['alwaysOnTop', 'bgColor', 'customBgColor', 'customFont', 'customTextColor', 'cutout', 'font', 'hour12', 'layout', 'opacity', 'showClock', 'showSeconds', 'showStopwatch', 'textColor', 'textOpacity', 'useCustomFont']; // all 16 settings (sorted)

let live = []; // everything launched in the current test, closed in afterEach
test.afterEach(async () => {
  for (const l of live) await l.close();
  live = [];
});

/** Launch + install fake clock + reload (firstWindow is already loaded) + freeze. */
async function open({ seedConfig, userData } = {}) {
  const l = await launch({ seedConfig, userData });
  live.push(l);
  await l.page.clock.install({ time: new Date(START_MS) });
  await l.page.reload();
  await expect(l.page.locator(SEL.app)).toBeVisible();
  await freezeClock(l.page);
  return l;
}

/** The pill's Page (always the app's FIRST window, even after a settings window opens). */
const pillPage = (l) => l.app.windows().find((w) => w.url().endsWith('index.html')) || l.page;

/** Open the SEPARATE settings window from the pill and return its Page (awaits the new window). */
async function openSettingsWindow(l) {
  const [sp] = await Promise.all([l.app.waitForEvent('window'), press(l.page, 'settings')]);
  await sp.waitForLoadState('domcontentloaded');
  await sp.locator(SEL.panel).waitFor();
  return sp;
}

/** Main-process bounds of a window found by its page URL suffix, or null.
 *  Needed because l.win() grabs getAllWindows()[0] (focus/z-order) — once the settings
 *  window is up that may NOT be the pill, so we resolve each window by its URL. */
const winBoundsByUrl = (l, suffix) =>
  l.app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith(s));
    return w ? w.getBounds() : null;
  }, suffix);
const settingsWinBounds = (l) => winBoundsByUrl(l, 'settings.html');
const pillWinBounds = (l) => winBoundsByUrl(l, 'index.html');

// ---- shared suite (same assertions as single-file) --------------------------------------
test.describe('electron: shared widget behaviour', () => {
  let cur;
  registerSharedWidgetTests(test, expect, {
    open: async ({ settings } = {}) => {
      cur = await open({ seedConfig: settings ? { schemaVersion: 1, settings } : undefined });
      return cur.page;
    },
    resize: async (page, w, h) => {
      await cur.win((win, { w, h }) => { win.setMinimumSize(1, 1); win.setSize(w, h); }, { w, h });
    },
    // Electron "Settings" is a SEPARATE window now. Triggering it from the pill (the
    // tray/right-click path) creates a second BrowserWindow; we await that window and
    // hand its Page back so the shared panel assertions run against the real settings UI.
    openSettings: async (page) => {
      const [sp] = await Promise.all([cur.app.waitForEvent('window'), press(page, 'settings')]);
      await sp.waitForLoadState('domcontentloaded');
      await sp.locator(SEL.panel).waitFor();
      return sp;
    },
    // Electron drives data-hover from main's cursor poll over IPC — NOT DOM events (the drag
    // region swallows those). The poll is off under test, so we send the same IPC it would.
    setHover: async (page, on) => {
      await cur.win((win, v) => win.webContents.send('hover:changed', { hover: v }), !!on);
      await page.waitForFunction((v) => document.querySelector('#app').dataset.hover === v, on ? 'true' : 'false');
    },
  }, 'electron');
});

// Reveal the pill's hover affordances (grip/tint) the way the real app does in Electron: via
// main's hover IPC, since the DOM hover path is intentionally not wired there (the drag region
// swallows it). Used by the grip tests below in place of page.hover.
async function hoverViaIpc(l, on = true) {
  await l.win((win, v) => win.webContents.send('hover:changed', { hover: v }), !!on);
  await l.page.waitForFunction((v) => document.querySelector('#app').dataset.hover === v, on ? 'true' : 'false');
}

// ---- window flags -----------------------------------------------------------------------
test.describe('electron: window behaviour', () => {
  // PRD: "Frameless, transparent, rounded"; "Always on top"; "resizable"; skipTaskbar.
  test('always-on-top, resizable, data-env=electron, transparent body', async () => {
    const l = await open();
    const flags = await l.win((w) => ({
      onTop: w.isAlwaysOnTop(), resizable: w.isResizable(),
      menuBar: w.isMenuBarVisible && w.isMenuBarVisible(),
    }));
    expect(flags.onTop).toBe(true);
    expect(flags.resizable).toBe(true);
    // (We set maximizable:false in main.js, but isMaximizable() is meaningless for a
    //  frameless/transparent window — there's no zoom button — and the OS reports it
    //  inconsistently, so we don't assert on it.)
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-env', 'electron');
    expect(await l.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  });

  test('visible on all workspaces (macOS only)', async () => {
    test.skip(process.platform !== 'darwin', 'macOS only');
    const l = await open();
    expect(await l.win((w) => w.isVisibleOnAllWorkspaces())).toBe(true);
  });

  test('on-pill controls exist in the DOM but are CSS-hidden in Electron; only the grip shows on hover', async () => {
    const l = await open();
    await hoverViaIpc(l); // Electron reveals hover affordances via main's cursor-poll IPC, not DOM hover
    await expect(l.page.locator(SEL.grip)).toBeVisible();
    // The browser-only control cluster is still in the shared markup, but in Electron CSS
    // keeps it display:none — control stays on the tray + native right-click menu. It must be
    // present (count 1) yet hidden, even while hovering.
    await expect(l.page.locator('#controls')).toHaveCount(1);
    await expect(l.page.locator('#controls')).toBeHidden();
    expect(await l.page.locator('#controls').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    for (const id of ['#btn-play', '#btn-pause', '#btn-reset', '#btn-settings']) {
      await expect(l.page.locator(id), id).toBeHidden();
    }
    // Quit never exists anywhere (can't quit a web page; Electron quits from the tray).
    await expect(l.page.locator('#btn-quit')).toHaveCount(0);
  });

  test('resize grip: dragging it grows the window', async () => {
    const l = await open();
    await hoverViaIpc(l); // reveal the grip via the Electron hover IPC (not DOM hover)
    const before = await l.win((w) => w.getBounds());
    const box = await l.page.locator(SEL.grip).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await l.page.mouse.move(cx, cy);
    await l.page.mouse.down();
    await l.page.mouse.move(cx + 30, cy + 16, { steps: 4 });
    await l.page.mouse.move(cx + 60, cy + 32, { steps: 4 });
    await l.page.mouse.up();
    await expect.poll(async () => (await l.win((w) => w.getBounds())).width).toBeGreaterThan(before.width);
    const after = await l.win((w) => w.getBounds());
    // Free resize: the grip drag moved +x AND +y, so both dimensions grew independently
    // (no aspect lock couples them any more).
    expect(after.height).toBeGreaterThan(before.height);
  });
});

// ---- hover fallback: main's cursor poll -> IPC -> data-hover ----------------------------
test.describe('electron: the hover IPC fallback drives data-hover (and the tint)', () => {
  // THE BUG: the whole pill is -webkit-app-region: drag, and in a frameless window that
  // native drag region swallows the DOM mouseenter/leave the renderer uses — so against a
  // REAL OS cursor data-hover never flipped and the 50%-black grab tint never appeared. The
  // fix is a main-process cursor poll that pushes the hover state over IPC ('hover:changed');
  // the renderer maps it to data-hover. We can't drive the OS cursor over a real drag region
  // headlessly (that's the very thing that doesn't work), and the poll is disabled under test
  // so it can't fight us — so we exercise the WIRING directly: main sends hover:changed, and
  // the preload -> bridge -> app path must flip data-hover and fade the ::after tint in/out.
  // (This confirms the IPC contract + renderer mapping; the real cursor->pixels path can only
  // be eyeballed on the host — see the handoff notes.)
  const afterOpacity = (page) =>
    page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#app'), '::after').opacity));
  const afterRing = (page) =>
    page.evaluate(() => getComputedStyle(document.querySelector('#app'), '::after').boxShadow);

  test('a hover:changed broadcast flips data-hover true/false and the overlay (tint + ring) in/out', async () => {
    const l = await open();
    // Start from a known not-hovered state (no synthetic hover in play).
    await l.page.dispatchEvent('html', 'mouseleave');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    await expect.poll(() => afterOpacity(l.page)).toBe(0);
    expect(await afterRing(l.page)).toBe('none'); // no edge ring until hover

    // main -> renderer: cursor entered the window bounds.
    await l.win((w) => w.webContents.send('hover:changed', { hover: true }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect.poll(() => afterOpacity(l.page)).toBe(1); // 50%-black tint faded fully in
    // the two-tone edge ring is drawn too (readable even on the default black pill) — confirmed
    // in a REAL Electron window, not just the browser build.
    const ring = await afterRing(l.page);
    expect(ring).toContain('inset');
    expect(ring).toContain('rgba(255, 255, 255, 0.6)');
    expect(ring).toContain('rgba(0, 0, 0, 0.5)');

    // main -> renderer: cursor left.
    await l.win((w) => w.webContents.send('hover:changed', { hover: false }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    await expect.poll(() => afterOpacity(l.page)).toBe(0);
    expect(await afterRing(l.page)).toBe('none');
  });

  test('STUCK-STATE REGRESSION: in Electron a DOM mouseleave does NOT clear a poll-set hover', async () => {
    // The bug: wireHover used to wire BOTH the DOM mouseenter/leave AND the IPC poll in Electron
    // (last-writer-wins). Moving the cursor onto the no-drag grip and back fires a documentElement
    // `mouseleave`, which cleared a poll-set hover MID-hover; the change-suppressed poll wouldn't
    // re-assert until a full exit+re-enter, so the tint/grip got stuck hidden. The fix gates the
    // driver per env — in Electron ONLY the IPC poll touches data-hover. So a stray DOM mouseleave
    // (what the grip round-trip produces) must be inert here.
    const l = await open();
    await l.win((w) => w.webContents.send('hover:changed', { hover: true }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect.poll(() => afterOpacity(l.page)).toBe(1);

    // Fire the spurious DOM mouseleave (grip round-trip). With the dual-driver bug this flipped
    // data-hover to false; with the per-env gate the DOM listener isn't wired, so hover HOLDS.
    await l.page.dispatchEvent('html', 'mouseleave');
    await l.page.waitForTimeout(150); // longer than the overlay transition; prove it doesn't drop
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect.poll(() => afterOpacity(l.page)).toBe(1);

    // And the poll remains authoritative: a real leave event still clears it.
    await l.win((w) => w.webContents.send('hover:changed', { hover: false }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
  });
});

// ---- resize is crash-proof (regression) -------------------------------------------------
test.describe('electron: resize-by never crashes', () => {
  // REGRESSION (the "conversion failure" crash): win.setSize needs finite INTEGERS, but grip
  // deltas arrive fractional and a stray NaN/Infinity is possible. Those used to throw and
  // could take the window down. main now coerces NaN->0, rounds, and guards against a
  // non-finite result. Fire a barrage of hostile deltas and assert the window survives with
  // valid integer bounds never below the 100x20 minimum (MIN_HEIGHT dropped 60 -> 20).
  test('fractional / NaN / Infinity / huge resize deltas never crash; size stays valid integers >= min', async () => {
    const l = await open();
    const deltas = [
      { dx: 12.37, dy: 4.91 },   // fractional (the common case)
      { dx: -9999, dy: -9999 },  // underflow -> clamps to min
      { dx: NaN, dy: 3.2 },      // NaN -> treated as 0
      { dx: Infinity, dy: -Infinity }, // non-finite -> guarded no-op
      { dx: 0.4, dy: 0.4 },      // sub-pixel
      { dx: 50000, dy: 50000 },  // huge (valid, just big)
      { dx: -0.1, dy: 7.9 },
    ];
    for (const d of deltas) {
      await l.page.evaluate((dd) => window.episodeTimer.resizeBy(dd.dx, dd.dy), d);
    }
    // Still alive and responsive, no renderer crash:
    await expect(l.page.locator(SEL.app)).toBeVisible();
    await expect(l.page.locator(SEL.time)).toHaveText(/^\d{2}:\d{2}$/);
    const size = await l.win((w) => w.getSize());
    expect(Number.isInteger(size[0]), `width ${size[0]} is an integer`).toBe(true);
    expect(Number.isInteger(size[1]), `height ${size[1]} is an integer`).toBe(true);
    expect(size[0]).toBeGreaterThanOrEqual(100);
    expect(size[1]).toBeGreaterThanOrEqual(20); // MIN_HEIGHT is now 20 (was 60)
  });
});

// ---- tray + right-click share ONE menu template -----------------------------------------
test.describe('electron: tray and context menu share one template', () => {
  // #4/#5: the tray menu template was factored into a single builder used by BOTH the Tray
  // and the pill's right-click context menu, so they can't drift; and the stopwatch items
  // were renamed. We can't reliably drive a real right-click popup headlessly, so we assert
  // (1) the SHARED builder (exposed to tests as global.__overtimeMenuTemplate) produces the
  // renamed labels, and (2) a 'context-menu' handler is actually registered on the window.
  test('builder has Start/Pause/Reset Stopwatch (+ Settings…/Quit) and a context-menu handler is wired', async () => {
    const l = await open();
    const labels = await l.app.evaluate(() =>
      (typeof global.__overtimeMenuTemplate === 'function' ? global.__overtimeMenuTemplate() : [])
        .map((i) => i.label).filter(Boolean)
    );
    expect(labels).toContain('Start Stopwatch');
    expect(labels).toContain('Pause Stopwatch');
    expect(labels).toContain('Reset Stopwatch');
    // the rest of the shared menu is intact
    expect(labels).toContain('Show clock');
    expect(labels).toContain('Show stopwatch');
    expect(labels).toContain('Settings…');
    expect(labels).toContain('Quit');
    // the old short labels are gone
    expect(labels).not.toContain('Play');
    expect(labels).not.toContain('Pause');
    expect(labels).not.toContain('Reset');

    // right-click handler registered on the pill's webContents (-> Menu.popup).
    const count = await l.win((w) => w.webContents.listenerCount('context-menu'));
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ---- the SEPARATE settings window (the big architectural change) ------------------------
test.describe('electron: settings open a SEPARATE window (no pill grow)', () => {
  // Settings is its own frameless/transparent window beside the pill now. Opening it must
  // create a SECOND BrowserWindow and leave the pill's own bounds untouched (the old
  // grow-the-pill hack is gone), so the real clock stays its small self over the wallpaper.
  test('opening Settings creates a second window; the pill does NOT grow', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    const before = await pillWinBounds(l); // resolve the pill by URL (not getAllWindows()[0])
    expect(l.app.windows().length).toBe(1);

    const sp = await openSettingsWindow(l);
    // A real second window now exists, hosting the same panel (built to fill it).
    expect(l.app.windows().length).toBe(2);
    await expect(sp.locator(SEL.panel)).toBeVisible();
    expect(sp.url().endsWith('settings.html')).toBe(true);

    // The pill is unchanged — it never grew for settings.
    const after = await pillWinBounds(l);
    expect(after).toMatchObject({ width: before.width, height: before.height });
  });

  test('choosing Settings again focuses the existing window (no duplicate)', async () => {
    const l = await open();
    const sp = await openSettingsWindow(l);
    expect(l.app.windows().length).toBe(2);
    // A second request must NOT spawn another window — main focuses the open one. No new
    // 'window' event should fire; assert the count stays at 2 after re-triggering.
    await press(l.page, 'settings');
    await l.page.waitForTimeout(300);
    expect(l.app.windows().length).toBe(2);
    await expect(sp.locator(SEL.panel)).toBeVisible();
  });

  test('closing the settings window (its ×) leaves the pill running', async () => {
    const l = await open();
    const sp = await openSettingsWindow(l);
    await sp.locator(SEL.close).click(); // the panel's × closes the WHOLE settings window
    await expect.poll(() => l.app.windows().length).toBe(1);
    // The pill is still alive and ticking.
    const pill = pillPage(l);
    await expect(pill.locator(SEL.app)).toBeVisible();
    await expect(pill.locator(SEL.time)).toHaveText(/^\d{2}:\d{2}$/);
  });

  test('editing a setting in the settings window updates the PILL live AND the window preview', async () => {
    const l = await open();
    const pill = pillPage(l);
    const sp = await openSettingsWindow(l);

    // Pick a layout tile in the settings window. It goes config:set-settings ->
    // settings:changed, broadcast to BOTH windows.
    await sp.click('#tab-layout');
    await sp.click('.option[data-setting="layout"][data-value="one-line"]');

    // The PILL re-applies live over the wallpaper (data-layout + the real face).
    await expect(pill.locator(SEL.app)).toHaveAttribute('data-layout', 'one-line');
    // The settings window's OWN #app (preview host) reflects it too.
    await expect(sp.locator(SEL.app)).toHaveAttribute('data-layout', 'one-line');

    // Now a Colors change: --pill-opacity must land on the PILL's :root live.
    await sp.click('#tab-colors');
    await sp.locator('#opacity-slider').evaluate((el) => { el.value = '0.3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect
      .poll(() => pill.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pill-opacity'))))
      .toBeCloseTo(0.3, 2);

    // And a bgColor change drives the pill's data-theme (derived from brightness).
    await sp.click('.option[data-setting="bgColor"][data-value="#ffffff"]');
    await expect(pill.locator(SEL.app)).toHaveAttribute('data-theme', 'light');
  });

  test('the color picker in the settings window commits a custom hex to the PILL live (Pass-H broadcast)', async () => {
    const l = await open();
    const pill = pillPage(l);
    const sp = await openSettingsWindow(l);
    await sp.click('#tab-colors');
    // Open the bg picker takeover in the SEPARATE settings window, mix an off-palette hex.
    await sp.click('#bg-color-picker');
    await expect(sp.locator(SEL.app)).toHaveAttribute('data-colorpicker', 'open');
    await expect(sp.locator('#cp-title')).toHaveText('Choose background color');
    await sp.locator('#cp-hex').fill('#3b82f6');
    // Before Save: the PILL's :root --bg-rgb is NOT yet the picked color (preview-only).
    expect(await pill.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').replace(/\s/g, ''))).not.toBe('59,130,246');
    // Save commits via config:set-settings -> broadcast: the PILL re-applies --bg-rgb live, and
    // both bgColor AND customBgColor persist as the hex.
    await sp.click('#cp-save');
    await expect(sp.locator(SEL.app)).not.toHaveAttribute('data-colorpicker', 'open');
    await expect
      .poll(() => pill.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').replace(/\s/g, '')))
      .toBe('59,130,246');
    const settings = await sp.evaluate(() => window.episodeTimer.getSettings());
    expect(settings.bgColor).toBe('#3b82f6');
    expect(settings.customBgColor).toBe('#3b82f6');
    // the picker swatch is the selected tile in the settings window
    await expect(sp.locator('#bg-color-picker')).toHaveClass(/is-selected/);
  });

  test('toggling Cutout in the settings window flips the PILL into knockout state live (Pass-H broadcast)', async () => {
    const l = await open();
    const pill = pillPage(l);
    const sp = await openSettingsWindow(l);
    await sp.click('#tab-colors');
    // OFF to start, on both windows.
    await expect(pill.locator(SEL.app)).toHaveAttribute('data-cutout', 'false');
    await expect(sp.locator(SEL.app)).toHaveAttribute('data-cutout', 'false');
    // Check the Cutout box in the settings window -> config:set-settings -> broadcast to the pill.
    await sp.locator('#cutout-checkbox').check();
    // The PILL re-applies live: data-cutout flips AND its knockout canvas is drawn with REAL
    // alpha-0 holes where the numerals are (the canvas readback proves the holes exist). The
    // actual desktop see-through over the wallpaper is host-visual only, but the holes
    // themselves are asserted here, not merely assumed.
    await expect(pill.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
    await expect.poll(() => pill.evaluate(() => {
      const c = [...document.querySelector('#app').children]
        .find((n) => n.tagName === 'CANVAS' && n.className.indexOf('et-cutout') !== -1);
      if (!c || !c.width || !c.height) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let holes = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) holes++;
      return holes;
    })).toBeGreaterThan(100);
    // the settings window preview reflects it too (its own data-cutout + canvas)
    await expect(sp.locator(SEL.app)).toHaveAttribute('data-cutout', 'true');
  });

  test('a tray/IPC settings change reaches the OPEN settings window preview too', async () => {
    const l = await open();
    const sp = await openSettingsWindow(l);
    // Simulate the tray "Show clock" toggle (applySettingsPatch broadcasts to both windows).
    await l.page.evaluate(() => window.episodeTimer.setSettings({ showClock: false }));
    // The settings window re-applied the broadcast -> its preview host hides the clock.
    await expect(sp.locator(SEL.app)).toHaveAttribute('data-show-clock', 'false');
  });
});

// ---- settings window: default size, clamp, bounds persistence, grip ---------------------
test.describe('electron: settings window geometry', () => {
  test('first open uses the ~1262x975 default, clamped to the display work area', async () => {
    const l = await open(); // no settingsWindow in config -> default size
    await openSettingsWindow(l);
    const b = await settingsWinBounds(l);
    const area = await l.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(b).not.toBeNull();
    // Clamped: never larger than the work area; == the default when the screen is big enough.
    expect(b.width).toBeLessThanOrEqual(area.width);
    expect(b.height).toBeLessThanOrEqual(area.height);
    expect(b.width).toBe(Math.min(1262, area.width));
    expect(b.height).toBe(Math.min(975, area.height));
    // And fully on-screen (never opens off the display).
    expect(b.x).toBeGreaterThanOrEqual(area.x);
    expect(b.y).toBeGreaterThanOrEqual(area.y);
    expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width);
    expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height);
  });

  test('a persisted settingsWindow size is restored on open', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, settingsWindow: { x: 60, y: 60, width: 640, height: 520 } } });
    await openSettingsWindow(l);
    const b = await settingsWinBounds(l);
    expect(b.width).toBe(640);
    expect(b.height).toBe(520);
  });

  test('moving/resizing the settings window persists its bounds under settingsWindow', async () => {
    const ud = makeUserData();
    const l = await open({ userData: ud });
    await openSettingsWindow(l);
    // Simulate an OS resize gesture (setBounds alone doesn't fire 'resized'; emit it like
    // the pill-persistence test does).
    await l.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('settings.html'));
      w.setBounds({ x: 120, y: 90, width: 700, height: 560 });
      w.emit('resized');
    });
    await sleep(900); // let the debounced trackBounds write hit disk (WRITE_DEBOUNCE_MS=500)
    const persisted = readConfig(l.configPath).settingsWindow;
    expect(persisted).toMatchObject({ width: 700, height: 560 });
  });

  test('the bottom-right grip resizes the settings window', async () => {
    // Seed a SMALL window well inside the display so the grip (bottom-right) has room to
    // drag in BOTH axes — at the clamped ~full-screen default, downward mouse moves get
    // clamped to the viewport and height wouldn't change.
    const l = await open({ seedConfig: { schemaVersion: 1, settingsWindow: { x: 40, y: 40, width: 560, height: 440 } } });
    const sp = await openSettingsWindow(l);
    const before = await settingsWinBounds(l);
    const grip = sp.locator('#settings-grip');
    await expect(grip).toBeVisible();
    const box = await grip.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await sp.mouse.move(cx, cy);
    await sp.mouse.down();
    await sp.mouse.move(cx + 40, cy + 30, { steps: 4 });
    await sp.mouse.move(cx + 80, cy + 60, { steps: 4 });
    await sp.mouse.up();
    await expect.poll(async () => (await settingsWinBounds(l)).width).toBeGreaterThan(before.width);
    expect((await settingsWinBounds(l)).height).toBeGreaterThan(before.height);
  });
});

// ---- tray commands drive the renderer ---------------------------------------------------
test.describe('electron: tray commands drive the renderer', () => {
  // The menu-bar tray's Play/Pause/Reset send 'timer:command' (main->renderer); the renderer
  // OWNS the stopwatch state, so we simulate exactly what the tray menu does --
  // webContents.send(...) from main -- and assert the renderer reacts through the same path
  // the on-pill buttons use. "Settings…" no longer routes through the renderer: it opens the
  // SEPARATE settings window directly (next test).
  const sendCmd = (l, action) => l.win((w, a) => w.webContents.send('timer:command', { action: a }), action);

  test('timer:command play/pause/reset runs the stopwatch', async () => {
    const l = await open();
    await sendCmd(l, 'play');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-status', 'running');
    await advance(l.page, 4_000);
    await sendCmd(l, 'pause');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
    await expect(l.page.locator(SEL.stopwatch)).toHaveText('00:00:04');
    await sendCmd(l, 'reset');
    await expect(l.page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-status', 'stopped');
  });

  test('"Settings…" opens the SEPARATE settings window (not an in-pill panel)', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    // The pill no longer hosts #settings-panel in Electron.
    await expect(l.page.locator(SEL.panel)).toHaveCount(0);
    const sp = await openSettingsWindow(l); // the tray/debug "Settings…" path -> new window
    await expect(sp.locator(SEL.panel)).toBeVisible();
    // The pill's bounds didn't grow — it stays its small self. (Resolve the pill by URL;
    // getAllWindows()[0] may now be the focused settings window.)
    expect((await pillWinBounds(l)).width).toBe(240);
  });
});

// ---- settings via IPC -------------------------------------------------------------------
test.describe('electron: settings over IPC', () => {
  test('setSettings({alwaysOnTop:false}) flips the window, then back to true', async () => {
    const l = await open();
    await l.page.evaluate(() => window.episodeTimer.setSettings({ alwaysOnTop: false }));
    await expect.poll(() => l.win((w) => w.isAlwaysOnTop())).toBe(false);
    await l.page.evaluate(() => window.episodeTimer.setSettings({ alwaysOnTop: true }));
    await expect.poll(() => l.win((w) => w.isAlwaysOnTop())).toBe(true);
  });

  test('settings:changed round-trip updates the DOM live', async () => {
    const l = await open();
    const full = await l.page.evaluate(() => window.episodeTimer.setSettings({ hour12: false, showSeconds: true, bgColor: '#ffffff', layout: 'one-line' }));
    expect(full).toMatchObject({ hour12: false, showSeconds: true, bgColor: '#ffffff', layout: 'one-line' });
    expect(Object.keys(full).sort()).toEqual(SETTINGS_KEYS); // always complete
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-theme', 'light');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-layout', 'one-line');
    await expect(l.page.locator(SEL.time)).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(l.page.locator(SEL.meridiem)).toBeHidden();
  });

  test('invalid values over IPC are normalized by main (opacity 7 -> 1; invalid hex dropped, not reset)', async () => {
    const l = await open();
    const out = await l.page.evaluate(() => window.episodeTimer.setSettings({ opacity: 7, bgColor: '#zzz' }));
    expect(out.opacity).toBe(1);
    expect(out.bgColor).toBe('#000000'); // unchanged (patch value dropped)
  });

  test('toggling showClock/showStopwatch over IPC hides/shows the readouts live (the tray path)', async () => {
    // The tray's "Show clock"/"Show stopwatch" checkboxes call the SAME applySettingsPatch
    // that this IPC uses, so this exercises the tray toggle end to end.
    const l = await open();
    await l.page.evaluate(() => window.episodeTimer.setSettings({ showClock: false }));
    await expect(l.page.locator(SEL.clock)).toBeHidden();
    await expect(l.page.locator(SEL.stopwatch)).toBeVisible();
    await l.page.evaluate(() => window.episodeTimer.setSettings({ showStopwatch: false }));
    await expect(l.page.locator(SEL.stopwatch)).toBeHidden(); // both off -> blank pill
    await l.page.evaluate(() => window.episodeTimer.setSettings({ showClock: true, showStopwatch: true }));
    await expect(l.page.locator(SEL.clock)).toBeVisible();
    await expect(l.page.locator(SEL.stopwatch)).toBeVisible();
  });
});

// ---- local-fonts permission + system-font browser --------------------------------------
test.describe('electron: local-fonts permission + system-font browser', () => {
  // HONEST NOTE ON SCOPE (see the handoff report): the Local Font Access API's REAL
  // enumeration (queryLocalFonts()) plus macOS's own font-access authorization can only
  // be fully confirmed on the Mac HOST. In this unattended VM the call is nondeterministic:
  // it returned ~528 families once, but usually hangs pending (the OS prompt has no one to
  // answer), and a pending call can even stall window-close. So we DON'T drive the real
  // enumeration here — that would make the suite flaky/hang. Instead we prove the wiring by
  // reliable means: (1) the API is exposed in the real renderer (secure context + our
  // 'local-fonts' permission handlers in main.js), and (2) the Custom tile is shown and
  // enabled in Electron (feature-detection). main.js's handler grants are also locked by a
  // static assertion (static.unit.spec.js), and the full Custom->choose->Save->fallback UI
  // flow is covered deterministically in the single-file suite with a stubbed queryLocalFonts.
  test('queryLocalFonts is exposed in the settings window and the Custom tile is shown + enabled', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    const sp = await openSettingsWindow(l); // the font browser lives in the SETTINGS window now
    // The Local Font Access API is present in the real settings-window renderer. This requires
    // a secure context AND that main.js granted 'local-fonts' on THIS window's own session
    // (installLocalFontsPermission is applied to the settings window too, not just the pill).
    expect(await sp.evaluate(() => typeof window.queryLocalFonts)).toBe('function');

    await sp.click('#tab-font');
    // Feature-detection shows + enables the Custom tile (it hides it only where the API is
    // absent). We deliberately do NOT click it here (that triggers the VM-blocking OS prompt).
    await expect(sp.locator('#font-custom-tile')).toBeVisible();
    expect(await sp.locator('#font-custom-tile').evaluate((el) => el.disabled)).toBe(false);
  });
});

// ---- config file I/O --------------------------------------------------------------------
test.describe('electron: config file', () => {
  // PRD: "Config must tolerate a missing or corrupt file ... never crash."
  test('corrupt config.json -> app starts with defaults AND keeps the bad file as config.json.corrupt-*', async () => {
    const l = await open({ seedConfig: '{not json' });
    await expect(l.page.locator(SEL.time)).toHaveText('10:42');
    await expect(l.page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    expect(fs.readdirSync(l.userData).filter((f) => f.startsWith('config.json.corrupt-')).length).toBeGreaterThanOrEqual(1);
  });

  test('missing config.json -> defaults, no crash', async () => {
    const l = await open();
    await expect(l.page.locator(SEL.stopwatch)).toHaveText('00:00:00');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-theme', 'dark');
  });

  test('after a transition config.json is valid, complete, and leaves no .tmp behind', async () => {
    const l = await open();
    await press(l.page, 'play');
    await advance(l.page, 3_000);
    await press(l.page, 'pause');
    await expect.poll(() => { try { return readConfig(l.configPath).timer.status; } catch { return null; } }, { timeout: 10_000 }).toBe('paused');
    const cfg = readConfig(l.configPath);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.window).toBeTruthy();
    expect(cfg.timer.accumulatedMs).toBeGreaterThanOrEqual(3000);
    expect(Object.keys(cfg.settings).sort()).toEqual(SETTINGS_KEYS);
    await l.close();
    expect(fs.readdirSync(l.userData).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ---- off-screen clamp -------------------------------------------------------------------
test.describe('electron: never opens off-screen', () => {
  // PRD: "Clamp to the currently-visible screen on restore ... never opens off-screen."
  test('saved position 99999,99999 is slid onto a display; saved size is kept', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 99999, y: 99999, width: 300, height: 163 } } });
    const { b, areas } = await l.win((w, _a, { screen }) => ({ b: w.getBounds(), areas: screen.getAllDisplays().map((d) => d.workArea) }));
    expect(b.width).toBe(300);
    const inside = areas.some((a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
    expect(inside, `bounds ${JSON.stringify(b)} not inside any of ${JSON.stringify(areas)}`).toBe(true);
  });

  test('garbage window bounds in config do not crash startup', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 'left', y: NaN, width: -5, height: 'tall' } } });
    await expect(l.page.locator(SEL.app)).toBeVisible();
  });
});

// ---- persistence across relaunch --------------------------------------------------------
test.describe('electron: persistence across relaunch', () => {
  // PRD: "Remembers window position/size and the episode's elapsed value between launches."
  test('paused value survives close + relaunch (restored as paused)', async () => {
    const ud = makeUserData();
    const a = await open({ userData: ud });
    await press(a.page, 'play');
    await advance(a.page, 5_000);
    await press(a.page, 'pause');
    await expect(a.page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await a.close();
    const b = await open({ userData: ud });
    await expect(b.page.locator(SEL.stopwatch)).toHaveText('00:00:05');
    await expect(b.page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
  });

  test('closing while RUNNING relaunches paused at the saved value; offline time not added (D6)', async () => {
    const ud = makeUserData();
    const a = await open({ userData: ud });
    await press(a.page, 'play');
    await advance(a.page, 6_000);
    const atClose = await a.page.locator(SEL.stopwatch).innerText();
    await a.close();
    await sleep(2500); // "offline" real time that must NOT be counted
    const b = await open({ userData: ud });
    await expect(b.page.locator(SEL.app)).toHaveAttribute('data-status', 'paused');
    const secs = (s) => s.split(':').reduce((t, n) => t * 60 + Number(n), 0);
    const restored = await b.page.locator(SEL.stopwatch).innerText();
    expect(Math.abs(secs(restored) - secs(atClose))).toBeLessThanOrEqual(1);
  });

  test('window position AND size are persisted (trackBounds) and the size is restored', async () => {
    const ud = makeUserData();
    const a = await open({ userData: ud });
    // A real drag/resize moves the window AND fires 'moved'/'resized', which is what
    // trackBounds debounces to disk. Programmatic setBounds does NOT fire those events,
    // so we emit 'moved' to simulate exactly the OS gesture a user makes.
    await a.win((w) => { w.setBounds({ x: 300, y: 200, width: 300, height: 163 }); w.emit('moved'); });
    await sleep(900); // let the debounced trackBounds write hit disk (WRITE_DEBOUNCE_MS=500)
    const saved = await a.win((w) => w.getBounds());
    // trackBounds persisted the live bounds — position AND size — to config.json.
    const persisted = readConfig(a.configPath).window;
    expect(persisted).toMatchObject({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
    await a.close();
    // On relaunch the saved SIZE is restored. (Exact live position-restore depends on the
    // OS honoring creation bounds — reliable on a real desktop; this VM re-places frameless
    // windows on show, so position is covered by the persisted-to-disk check above plus the
    // off-screen-clamp test, not the live x/y here.)
    const b = await open({ userData: ud });
    const bb = await b.win((w) => w.getBounds());
    expect(Math.abs(bb.width - saved.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(bb.height - saved.height)).toBeLessThanOrEqual(2);
  });
});
