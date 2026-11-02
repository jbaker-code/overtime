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
const SETTINGS_KEYS = ['alwaysOnTop', 'bgColor', 'customFont', 'font', 'hour12', 'layout', 'opacity', 'showClock', 'showSeconds', 'showStopwatch', 'textColor', 'textOpacity']; // all settings (sorted)

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
  }, 'electron');
});

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
    await l.page.hover(SEL.app);
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
    await l.page.hover(SEL.app);
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

  test('a hover:changed broadcast flips data-hover true/false and the overlay opacity 1/0', async () => {
    const l = await open();
    // Start from a known not-hovered state (no synthetic hover in play).
    await l.page.dispatchEvent('html', 'mouseleave');
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    await expect.poll(() => afterOpacity(l.page)).toBe(0);

    // main -> renderer: cursor entered the window bounds.
    await l.win((w) => w.webContents.send('hover:changed', { hover: true }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'true');
    await expect.poll(() => afterOpacity(l.page)).toBe(1); // 50%-black tint faded fully in

    // main -> renderer: cursor left.
    await l.win((w) => w.webContents.send('hover:changed', { hover: false }));
    await expect(l.page.locator(SEL.app)).toHaveAttribute('data-hover', 'false');
    await expect.poll(() => afterOpacity(l.page)).toBe(0);
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

// ---- settings panel grows the window ----------------------------------------------------
test.describe('electron: settings panel grows + restores the window', () => {
  // Opening settings on a tiny widget would leave the panel unusable, so main grows the
  // window to a comfortable editing size and restores the exact prior bounds on close. The
  // grown size must NEVER be persisted (settingsGrown gates bounds tracking).
  test('opening grows to ~720x620, closing restores, and the grown size is not persisted', async () => {
    const ud = makeUserData();
    const l = await open({ userData: ud, seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    const before = await l.win((w) => w.getBounds());
    expect(before.width).toBeLessThan(400); // started small

    await press(l.page, 'settings'); // gear -> open (same round-trip the tray uses)
    await expect(l.page.locator(SEL.panel)).toBeVisible();
    await expect.poll(async () => (await l.win((w) => w.getBounds())).width).toBeGreaterThanOrEqual(700);
    expect((await l.win((w) => w.getBounds())).height).toBeGreaterThanOrEqual(600);

    await l.page.locator(SEL.close).click(); // the panel's × -> close
    await expect.poll(async () => (await l.win((w) => w.getBounds())).width).toBe(before.width);
    expect((await l.win((w) => w.getBounds())).height).toBe(before.height);

    await l.close();
    const saved = readConfig(l.configPath);
    expect(saved.window.width).toBe(240);  // the grown 720x620 must not have leaked to disk
    expect(saved.window.height).toBe(130);
  });
});

// ---- tray commands drive the renderer ---------------------------------------------------
test.describe('electron: tray commands drive the renderer', () => {
  // The menu-bar tray's Play/Pause/Reset send 'timer:command' (main->renderer) and
  // "Settings…" sends 'ui:open-settings'. The renderer OWNS the stopwatch state, so we
  // simulate exactly what the tray menu does -- webContents.send(...) from main -- and
  // assert the renderer reacts through the same path the on-pill buttons use.
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

  test('ui:open-settings opens the panel (and grows the window)', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    await l.win((w) => w.webContents.send('ui:open-settings'));
    await expect(l.page.locator(SEL.panel)).toBeVisible();
    await expect.poll(async () => (await l.win((w) => w.getBounds())).width).toBeGreaterThanOrEqual(700);
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
  test('queryLocalFonts is exposed in the real renderer and the Custom tile is shown + enabled', async () => {
    const l = await open({ seedConfig: { schemaVersion: 1, window: { x: 200, y: 150, width: 240, height: 130 } } });
    // The Local Font Access API is present in the real Electron renderer. This requires a
    // secure context AND that our main.js permission wiring didn't blanket-deny it away.
    expect(await l.page.evaluate(() => typeof window.queryLocalFonts)).toBe('function');

    await press(l.page, 'settings'); // open the panel (also grows the window)
    await expect(l.page.locator(SEL.panel)).toBeVisible();
    await l.page.click('#tab-font');
    // Feature-detection shows + enables the Custom tile in Electron (it hides it only where the
    // API is absent). We deliberately do NOT click it here (that triggers the VM-blocking OS prompt).
    await expect(l.page.locator('#font-custom-tile')).toBeVisible();
    expect(await l.page.locator('#font-custom-tile').evaluate((el) => el.disabled)).toBe(false);
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
