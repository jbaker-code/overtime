// Launch the real app with an isolated userData dir (PLAN.md §5.3).
//
// Runs on the host AND inside this VM. The VM can't use node_modules/electron (the
// binary never installs there — the shared folder can't store the .app's symlinks),
// so we point Playwright at a REAL Electron binary resolved in this order:
//   1. $EPISODE_TIMER_ELECTRON_PATH  (explicit override)
//   2. ~/et-electron/Electron.app/Contents/MacOS/Electron  (VM: extracted locally, see HANDOFF.md)
//   3. require('electron')           (host: the npm package's bundled binary)
// The app code itself still loads from the repo (args:[ROOT]) in every case.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./paths');

const LOCAL_ELECTRON = path.join(os.homedir(), 'et-electron', 'Electron.app', 'Contents', 'MacOS', 'Electron');

/** Resolve a usable Electron executable -> { exe } or { reason } (never throws). */
function resolveElectron() {
  const override = process.env.EPISODE_TIMER_ELECTRON_PATH;
  if (override) {
    return fs.existsSync(override) ? { exe: override } : { reason: `EPISODE_TIMER_ELECTRON_PATH not found: ${override}` };
  }
  if (fs.existsSync(LOCAL_ELECTRON)) return { exe: LOCAL_ELECTRON }; // VM-local extraction
  try {
    const exe = require('electron'); // the npm package exports the binary path (host)
    if (typeof exe === 'string' && fs.existsSync(exe)) return { exe };
    return { reason: 'Electron binary not installed (npm install on the host, or extract to ~/et-electron)' };
  } catch (e) {
    return { reason: 'Electron not available (set EPISODE_TIMER_ELECTRON_PATH or extract to ~/et-electron)' };
  }
}

/** null when Electron is usable here (and the opt-out env var is unset); otherwise the skip reason. */
function electronUnavailableReason() {
  if (process.env.EPISODE_TIMER_SKIP_ELECTRON) return 'EPISODE_TIMER_SKIP_ELECTRON is set';
  if (!fs.existsSync(path.join(ROOT, 'main.js'))) return 'main.js not found';
  return resolveElectron().reason || null;
}

function makeUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-timer-ud-'));
}

/**
 * launch({ userData?, seedConfig? })
 *   seedConfig: object (JSON-stringified) OR a raw string (for the corrupt-file test),
 *   written to <userData>/config.json before the app starts.
 * Returns { app, page, userData, configPath, win(fn, arg), close() }.
 *   win(fn, arg): runs fn(browserWindow, arg, electronModule) in the MAIN process.
 */
async function launch({ userData, seedConfig } = {}) {
  const { _electron } = require('@playwright/test');
  userData = userData || makeUserData();
  fs.mkdirSync(userData, { recursive: true });
  const configPath = path.join(userData, 'config.json');
  if (seedConfig !== undefined) {
    fs.writeFileSync(configPath, typeof seedConfig === 'string' ? seedConfig : JSON.stringify(seedConfig));
  }
  const resolved = resolveElectron();
  const app = await _electron.launch({
    executablePath: resolved.exe, // real binary (VM: ~/et-electron; host: npm electron)
    args: [ROOT],
    env: { ...process.env, EPISODE_TIMER_USER_DATA: userData, EPISODE_TIMER_TEST: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const win = (fn, arg) =>
    app.evaluate(
      (electron, { src, arg }) => {
        const w = electron.BrowserWindow.getAllWindows()[0];
        return (0, eval)(`(${src})`)(w, arg, electron);
      },
      { src: fn.toString(), arg }
    );

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close().catch(() => {});
  };
  app.on('close', () => { closed = true; });
  return { app, page, userData, configPath, win, close };
}

module.exports = { launch, makeUserData, electronUnavailableReason, resolveElectron, LOCAL_ELECTRON };
