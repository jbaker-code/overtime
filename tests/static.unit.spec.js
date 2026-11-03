// PRD acceptance: "OBS can capture it" (content protection must stay OFF) + DOM contract
// sanity + inliner contract.  PLAN §5.2 rows "OBS can capture", §4.4.  Project: unit.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers/paths');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test.describe('static source assertions', () => {
  test('main.js never enables content protection, and says so on purpose', () => {
    const src = read('source/electron/main.js');
    expect(src).not.toMatch(/setContentProtection\(\s*true/);
    expect(src).toMatch(/DELIBERATELY ABSENT/);
  });

  test('main.js grants ONLY the local-fonts permission (queryLocalFonts) on the window session, not a blanket grant', () => {
    const src = read('source/electron/main.js');
    expect(src).toMatch(/setPermissionRequestHandler/);
    expect(src).toMatch(/setPermissionCheckHandler/);
    // The decision is gated on the exact permission name, so it's not a blanket allow.
    expect((src.match(/permission === 'local-fonts'/g) || []).length).toBeGreaterThanOrEqual(2);
    // and it operates on the window's own session
    expect(src).toMatch(/win\.webContents\.session/);
  });

  test('main.js has no nodeIntegration / remote, contextIsolation on, transparent frameless window', () => {
    const src = read('source/electron/main.js');
    expect(src).not.toMatch(/nodeIntegration\s*:\s*true/);
    expect(src).toMatch(/contextIsolation\s*:\s*true/);
    expect(src).toMatch(/frame\s*:\s*false/);
    expect(src).toMatch(/transparent\s*:\s*true/);
    expect(src).toMatch(/alwaysOnTop/);
  });

  test('renderer index.html honours the inliner contract (relative assets only, no modules)', () => {
    const html = read('source/app/renderer/index.html');
    expect(html).not.toMatch(/type\s*=\s*["']module["']/);
    expect(html).not.toMatch(/(src|href)\s*=\s*["'](https?:)?\/\//i);
    const order = [...html.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/g)].map((m) => path.basename(m[1]));
    // format -> stopwatch -> bridge -> app, in document order (config-schema/settings-apply may interleave)
    const idx = (n) => order.indexOf(n);
    expect(idx('format.js')).toBeGreaterThanOrEqual(0);
    expect(idx('stopwatch.js')).toBeGreaterThanOrEqual(0);
    expect(idx('bridge.js')).toBeGreaterThan(idx('stopwatch.js'));
    expect(idx('app.js')).toBeGreaterThan(idx('bridge.js'));
  });

  test('renderer DOM contract ids are all present in index.html (readouts + grip)', () => {
    const html = read('source/app/renderer/index.html');
    for (const id of ['app', 'face', 'clock', 'clock-time', 'clock-meridiem', 'stopwatch',
      'separator', 'grip']) {
      expect(html, `#${id}`).toMatch(new RegExp(`id\\s*=\\s*["']${id}["']`));
    }
  });

  test('the browser-only on-pill controls are present in markup (Play/Pause/Reset/Settings), but NOT Quit', () => {
    // Pass C removed ALL on-pill controls (Electron drives everything from the tray +
    // right-click menu). This pass restored them for the BROWSER build only — a plain tab
    // has no tray/native menu — so #controls with Play/Pause/Reset/Settings is back in the
    // markup (CSS alone hides it in Electron). There is NO Quit button: you can't quit a web
    // page, and a Stop button never shipped.
    const html = read('source/app/renderer/index.html');
    for (const id of ['controls', 'btn-play', 'btn-pause', 'btn-reset', 'btn-settings']) {
      expect(html, `#${id} must be present`).toMatch(new RegExp(`id\\s*=\\s*["']${id}["']`));
    }
    for (const id of ['btn-quit', 'btn-stop']) {
      expect(html, `#${id} must be absent`).not.toMatch(new RegExp(`id\\s*=\\s*["']${id}["']`));
    }
  });

  test('styles.css: the on-pill controls use a POSITIVE data-env="browser" gate (shown ONLY in browser; electron/absent/garbage stay hidden)', () => {
    const css = read('source/app/renderer/styles.css');
    // The base rule hides the cluster — this is the SAFE DEFAULT, not the Electron protection:
    // a missing/garbage data-env falls through to it and stays hidden too.
    expect(css).toMatch(/#controls\s*\{[^}]*display:\s*none/);
    // The cluster is revealed ONLY by the POSITIVE gate — data-env must be exactly "browser".
    expect(css).toMatch(/#app\[data-env="browser"\]\s+#controls\b/);
    // the hover reveal rides the SAME positive gate + the shared data-hover attribute
    expect(css).toMatch(/#app\[data-env="browser"\]\[data-hover="true"\]\s+#controls\s*\{\s*opacity:\s*1/);
    // and the OLD negative gate must be gone: `:not([data-env="electron"])` reveals controls
    // for ANY non-electron value (absent/garbage included), which could leak them into the
    // Electron build if data-env were ever unset. It must not be how #controls is gated.
    expect(css).not.toMatch(/:not\(\[data-env="electron"\]\)\s+#controls\b/);
  });

  test('the hover tint has a main-process cursor-poll fallback (the drag region swallows DOM mouseenter/leave)', () => {
    // BUG: the whole pill is -webkit-app-region: drag; in a frameless window that native drag
    // region swallows the DOM mouseenter/leave the renderer uses, so against a real OS cursor
    // data-hover never flips and the 50%-black grab tint never appears. main polls the OS
    // cursor vs the window bounds and pushes the hover state over IPC. Assert that path exists.
    const main = read('source/electron/main.js');
    // polls the global cursor position and compares it to the window bounds
    expect(main).toMatch(/getCursorScreenPoint\(/);
    expect(main).toMatch(/win\.getBounds\(/);
    // broadcasts the hover state on a dedicated channel (noun:state, like settings:changed)
    expect(main).toMatch(/webContents\.send\(\s*['"]hover:changed['"]/);
    // scoped to while the window is visible (started on show, stopped on hide), and skipped
    // under test so a real-cursor poll can't fight the suite's synthetic hover.
    expect(main).toMatch(/startHoverPolling/);
    expect(main).toMatch(/stopHoverPolling/);
    expect(main).toMatch(/if\s*\(\s*IS_TEST\s*\)\s*return/);
  });

  test('preload exposes onHoverChanged on the hover:changed channel, and the bridge forwards it in BOTH envs', () => {
    const preload = read('source/electron/preload.js');
    expect(preload).toMatch(/onHoverChanged\s*:/);
    expect(preload).toMatch(/ipcRenderer\.on\(\s*['"]hover:changed['"]/);
    const bridge = read('source/app/renderer/bridge.js');
    // electron bridge forwards to the preload api; browser bridge returns a no-op unsubscribe
    expect((bridge.match(/onHoverChanged\s*:/g) || []).length).toBeGreaterThanOrEqual(2);
    // the renderer wires the fallback into the SAME data-hover attribute the DOM path uses
    const appjs = read('source/app/renderer/app.js');
    expect(appjs).toMatch(/bridge\.onHoverChanged\(/);
  });

  test('main.js builds ONE shared menu template used by both the tray and the right-click menu', () => {
    const src = read('source/electron/main.js');
    // a single builder...
    expect(src).toMatch(/function\s+buildMenuTemplate\s*\(/);
    // ...consumed by the tray (buildFromTemplate(buildMenuTemplate())) AND popped as the
    // native context menu on a 'context-menu' event.
    expect(src).toMatch(/buildFromTemplate\(\s*buildMenuTemplate\(\)\s*\)/);
    expect(src).toMatch(/webContents\.on\(\s*['"]context-menu['"]/);
    expect(src).toMatch(/\.popup\(/);
    // the renamed stopwatch items live in that one template
    expect(src).toContain("label: 'Start Stopwatch'");
    expect(src).toContain("label: 'Pause Stopwatch'");
    expect(src).toContain("label: 'Reset Stopwatch'");
  });

  test('layout DOM: #face.arrange with .r-clock, .r-sep, .r-sw', () => {
    const html = read('source/app/renderer/index.html');
    expect(html).toMatch(/id="face"[^>]*class="[^"]*\barrange\b/);
    expect(html).toMatch(/id="clock"[^>]*class="[^"]*\br-clock\b/);
    expect(html).toMatch(/id="separator"[^>]*class="[^"]*\br-sep\b/);
    expect(html).toMatch(/id="stopwatch"[^>]*class="[^"]*\br-sw\b/);
  });

  test('settings-panel.js / settings-apply.js are loaded in dependency order before app.js', () => {
    const html = read('source/app/renderer/index.html');
    const order = [...html.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/g)].map((m) => path.basename(m[1]));
    const idx = (n) => order.indexOf(n);
    expect(idx('config-schema.js')).toBeGreaterThan(idx('stopwatch.js'));
    expect(idx('settings-apply.js')).toBeGreaterThan(idx('config-schema.js'));
    expect(idx('settings-panel.js')).toBeGreaterThan(idx('settings-apply.js'));
    expect(idx('app.js')).toBeGreaterThan(idx('settings-panel.js'));
  });

  test('styles.css: the hover tint is an ::after overlay, and #app never transitions its background (no startup flash)', () => {
    const css = read('source/app/renderer/styles.css');
    // The hover tint is a pseudo-element overlay whose OPACITY animates...
    expect(css).toMatch(/#app::after\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/#app::after\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0?\.5\)/);
    expect(css).toMatch(/#app\[data-hover="true"\]::after\s*\{\s*opacity:\s*1/);
    // ...and #app itself must NOT animate `background` (the regression that flashed the
    // configured color in from default-black on every launch / settings change).
    expect(css).not.toMatch(/transition:\s*background\b/);
    // the old hover rule that swapped #app's own background is gone, too
    expect(css).not.toMatch(/#app\[data-hover="true"\]\s*\{\s*background:/);
  });

  test('styles.css: the Font tab name bar / Edit button are gone; a dashed Custom tile replaces them', () => {
    const css = read('source/app/renderer/styles.css');
    expect(css).not.toMatch(/\.font-namebar\b/);
    expect(css).not.toMatch(/\.font-edit-btn\b/);
    expect(css).toMatch(/\.option-custom\b/);
  });

  test('package.json wiring: test script runs playwright, main points at the Electron entry', () => {
    // After the Pass-L reorg, the Electron entry lives at source/electron/main.js and the
    // Playwright config moved into tests/, so `npm test` passes --config explicitly.
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.test).toBe('playwright test --config tests/playwright.config.js');
    expect(pkg.main).toBe('source/electron/main.js');
  });
});
