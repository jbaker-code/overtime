// main.js
// -----------------------------------------------------------------------------
// Electron MAIN process entry (package.json "main"). Responsibilities:
//   * create the one frameless/transparent/always-on-top widget window
//   * restore + persist its bounds (clamped on-screen)
//   * wire the frozen IPC channels (timer, settings, resize, quit)
//   * flush config on quit
//
// The renderer owns the stopwatch state machine; main just persists what the
// renderer hands it and applies the handful of main-side settings effects
// (window level). See PLAN §2.1/§2.3.
// -----------------------------------------------------------------------------
'use strict';

var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipcMain = electron.ipcMain;
var Menu = electron.Menu;
var Tray = electron.Tray;
var nativeImage = electron.nativeImage;
// electron.screen is only valid after app 'ready'; read it lazily in the hover poll.
var path = require('path');
var fs = require('fs');

var config = require('./src/main/config');
var windowState = require('./src/main/window-state');
var schema = require('./src/shared/config-schema');
var stopwatch = require('./src/shared/stopwatch');

// Test/dev knobs.
var IS_TEST = process.env.EPISODE_TIMER_TEST === '1';
var WANT_DEVTOOLS = process.argv.indexOf('--devtools') !== -1;

// Before app is ready: let tests/dev point userData somewhere disposable.
if (process.env.EPISODE_TIMER_USER_DATA) {
  app.setPath('userData', process.env.EPISODE_TIMER_USER_DATA);
}

// macOS: run as an accessory app with NO Dock icon — the widget lives in the
// menu-bar tray instead (see createTray). Hiding the dock is also what lets the
// window float over another app's fullscreen Space. Skipped under test so a test
// run doesn't fiddle with the dock. (Always-on-top over fullscreen still relies
// on the 'screen-saver' level + setVisibleOnAllWorkspaces in createWindow.)
if (process.platform === 'darwin' && app.dock && !IS_TEST) {
  app.dock.hide();
}

// Single-instance lock: two floating clocks is a bug, not a feature. Second
// launch just focuses the first. Skipped under test so parallel launches work.
var win = null;

if (!IS_TEST) {
  var gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', function () {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

// Settings-mode window grow (Electron-only). While the settings panel is open we
// temporarily grow the window to a comfortable editing size, remembering the
// user's real widget bounds so we can restore them EXACTLY on close. We never
// persist the grown size — only the user's real widget size is ever saved.
var SETTINGS_W = 720;
var SETTINGS_H = 620;
var preSettingsBounds = null; // the user's widget bounds before we grew
var settingsGrown = false; // true while grown -> suppresses bounds persistence
var tray = null; // the menu-bar tray (Electron-only; created in whenReady)

function createWindow() {
  config.load(); // never throws

  var settings = config.get('settings'); // defaults merged in
  var bounds = windowState.restoreBounds(config, { width: 240, height: 130 }); // clamped on-screen (D15)

  win = new BrowserWindow(Object.assign({}, bounds, {
    minWidth: schema.MIN_WIDTH,
    minHeight: schema.MIN_HEIGHT, // mirrors config-schema (now 20, ~1/3 of the old 60);
                                  // macOS may enforce its own small floor underneath this.
    frame: false, // no OS chrome, ever — the pill is our whole UI (right-click for the menu)
    transparent: true, // rounded dark pill, see-through corners
    hasShadow: false,
    resizable: true, // native edge resize where the OS allows it (D10)
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    title: 'Overtime',
    show: false, // show on ready-to-show to avoid a white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // keep ticking at 1 Hz when occluded/unfocused
    }
  }));

  // local-fonts permission: the Font tab's system-font browser calls the
  // renderer's queryLocalFonts() to enumerate installed families, which Chromium
  // gates behind the 'local-fonts' permission. Grant ONLY that on this window's
  // session (the user gesture is the "Edit" click), and deny everything else — a
  // frameless desktop clock needs no camera/mic/geolocation/etc., so this keeps
  // the secure default posture rather than blanket-granting. There was no prior
  // handler to preserve; if one is ever added, chain it in the `else` branch.
  var ses = win.webContents.session;
  ses.setPermissionRequestHandler(function (_wc, permission, callback) {
    callback(permission === 'local-fonts');
  });
  ses.setPermissionCheckHandler(function (_wc, permission) {
    return permission === 'local-fonts';
  });

  // Top-most window level so we float above basically everything.
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  // Over Spaces / other apps' fullscreen (macOS/Linux; not a Windows concept).
  if (process.platform !== 'win32') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // No aspect-ratio lock: the host wants FREE resize — right edge changes width,
  // bottom edge changes height, corner changes both independently (native
  // frameless-window behavior). The vmin-based content just re-fills whatever
  // shape it's given.

  // Content protection: DELIBERATELY ABSENT — never enabled, so OBS and any
  // other screen recorder can capture this widget. That is the whole point of
  // putting a timer on screen. Do not turn screen-capture blocking on here.
  // (A test greps this file to be sure it never creeps back in.)

  win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  win.once('ready-to-show', function () { win.show(); startHoverPolling(); });

  // Keep the hover poll scoped to when the widget is actually on screen: a hidden or
  // minimized widget can't be hovered, so there's nothing to detect (and no reason to
  // burn a timer). Re-arm when it comes back.
  win.on('show', startHoverPolling);
  win.on('restore', startHoverPolling);
  win.on('hide', stopHoverPolling);
  win.on('minimize', stopHoverPolling);

  // Right-click anywhere on the pill -> the native context menu, mirroring the
  // tray exactly (shared buildMenuTemplate). Now that the on-pill control icons
  // are gone, this (and the tray) is how the user drives the timer / opens
  // settings / quits. Main-side event, so it works through the frameless window's
  // drag region without any renderer wiring.
  win.webContents.on('context-menu', function () { popupContextMenu(); });

  // Persist position + size as the user drags the widget around / resizes it —
  // but NOT while we've temporarily grown the window for the settings panel
  // (that grown size must never reach disk).
  windowState.trackBounds(win, config, { shouldSkipSave: function () { return settingsGrown; } });

  if (WANT_DEVTOOLS) {
    // Note: the window goes opaque while DevTools is open — a documented
    // Electron limitation for transparent windows, not a bug in our CSS.
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('closed', function () { stopHoverPolling(); win = null; });
}

// --- hover fallback: cursor polling (PLAN §2.6) ------------------------------
// WHY this exists: the ENTIRE pill is -webkit-app-region: drag so the user can grab it
// anywhere to move the frameless window. But in a frameless window that native drag region
// SWALLOWS the mouse events the renderer's documentElement mouseenter/mouseleave listeners
// rely on — so against a real OS cursor they never fire, data-hover never flips, and the
// 50%-black grab tint (plus the resize grip) never appears. The host hit exactly this: no
// visible pill to grab. (A plain browser tab has no drag region, so the renderer's DOM path
// works there; only the Electron build needs this.) Main CAN still see the cursor via
// screen.getCursorScreenPoint(), so we poll it against the window bounds and push a hover
// boolean to the renderer, which maps it to data-hover.
//
// Throttling: we poll on a modest interval and only SEND on a change (not every tick), so the
// renderer sees one message per enter and one per leave, never a stream. The poll is scoped to
// while the window is visible (started on show, stopped on hide/minimize/close).
var HOVER_POLL_MS = 120;   // responsive enough to feel instant; negligible cost at 1 point/tick
var hoverTimer = null;
var lastHoverSent = null;  // last boolean we emitted (null = nothing sent yet)

// Is the OS cursor currently within the widget's screen rectangle? Global coords on both
// sides (getCursorScreenPoint and getBounds are both in screen space), so no DPI/offset math.
function cursorIsOverWindow() {
  if (!win || win.isDestroyed()) return false;
  var p = electron.screen.getCursorScreenPoint();
  var b = win.getBounds();
  return p.x >= b.x && p.x < b.x + b.width &&
         p.y >= b.y && p.y < b.y + b.height;
}

function pollHoverOnce() {
  if (!win || win.isDestroyed()) return;
  var over;
  try { over = cursorIsOverWindow(); } catch (e) { return; } // never let a poll tick throw
  if (over !== lastHoverSent) {
    lastHoverSent = over;
    win.webContents.send('hover:changed', { hover: over });
  }
}

function startHoverPolling() {
  // Under test the suite drives the hover IPC directly (Playwright's synthetic hover also
  // flips data-hover via the DOM path); a real-cursor poll would fight both, so skip it.
  if (IS_TEST) return;
  if (hoverTimer) return; // already running
  lastHoverSent = null;   // force the first observed state to be sent
  hoverTimer = setInterval(pollHoverOnce, HOVER_POLL_MS);
  if (hoverTimer.unref) hoverTimer.unref(); // a lone poll must never keep the app alive
}

function stopHoverPolling() {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  lastHoverSent = null;
}

// --- IPC wiring (frozen channel names, PLAN §2.3) ----------------------------

function wireIpc() {
  // timer:get -> the saved (normalized) timer, or null if never saved.
  ipcMain.handle('timer:get', function () {
    var t = config.get('timer');
    return t || null;
  });

  // timer:push -> validate (never trust the renderer, even though it's ours),
  // then store. config.set debounces the atomic disk write.
  ipcMain.on('timer:push', function (_event, payload) {
    var clean = stopwatch.fromPersisted(payload); // type-checks + clamps
    config.set('timer', clean);
  });

  // config:get-settings -> the complete settings object.
  ipcMain.handle('config:get-settings', function () {
    return config.get('settings');
  });

  // config:set-settings -> merge a validated partial, persist, apply main-side
  // effects, broadcast to the renderer, return full settings.
  ipcMain.handle('config:set-settings', function (_event, partial) {
    return applySettingsPatch(partial);
  });

  // window:resize-by -> grow/shrink from the corner grip. FREE resize now that
  // the aspect lock is gone: dx changes width, dy changes height, independently.
  ipcMain.on('window:resize-by', function (_event, delta) {
    if (!win || win.isDestroyed()) return;
    var dx = (delta && Number(delta.dx)) || 0;
    var dy = (delta && Number(delta.dy)) || 0;

    var size = win.getSize();
    var w = size[0] + dx;
    var h = size[1] + dy;

    // Clamp each dimension to its own minimum (no coupling between them).
    if (w < schema.MIN_WIDTH) w = schema.MIN_WIDTH;
    if (h < schema.MIN_HEIGHT) h = schema.MIN_HEIGHT;

    // setSize's native binding requires finite INTEGERS. Rapid resizing can leave
    // w or h as a float (grip deltas aren't whole pixels), and a stray Infinity is
    // possible — either throws "conversion failure". Round + guard before the call.
    w = Math.round(w);
    h = Math.round(h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    win.setSize(w, h, false);
  });

  // app:quit -> a renderer-initiated quit. The on-pill × button that used to call
  // this is gone (Quit now lives in the tray + right-click menu, which call
  // app.quit() directly), but the bridge still exposes quit(), so we keep the
  // channel wired rather than leave a dangling API.
  ipcMain.on('app:quit', function () { app.quit(); });

  // window:settings-open -> the renderer tells us when the settings panel opens
  // (payload.open === true) or closes. On open we grow the window to a
  // comfortable editing size (remembering the user's real size); on close we
  // restore it exactly. The grown size is never persisted (settingsGrown gates
  // trackBounds). Electron-only; browser mode never sends this.
  ipcMain.on('window:settings-open', function (_event, payload) {
    if (!win || win.isDestroyed()) return;
    var open = !!(payload && payload.open);
    if (open) growForSettings();
    else restoreFromSettings();
  });
}

// Grow the window up to the settings editing size if it's currently smaller,
// keeping its top-left and clamping the bigger rectangle onto the display.
function growForSettings() {
  if (settingsGrown) return; // already grown
  var cur = win.getBounds();
  var targetW = Math.max(cur.width, SETTINGS_W);
  var targetH = Math.max(cur.height, SETTINGS_H);
  if (targetW === cur.width && targetH === cur.height) return; // already comfy

  preSettingsBounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
  settingsGrown = true; // gate persistence before we change the size

  var grown = windowState.clampBounds({ x: cur.x, y: cur.y, width: targetW, height: targetH });
  win.setBounds(grown, false);
}

// Restore the user's real widget bounds saved at open time.
function restoreFromSettings() {
  if (!settingsGrown) return;
  var restore = preSettingsBounds;
  settingsGrown = false;
  preSettingsBounds = null;
  if (restore) win.setBounds(restore, false);
}

// Apply the settings that only main can enforce. Today that's just the window
// level; adding more later (e.g. click-through) happens here.
function applyMainSideSettings(settings) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!settings.alwaysOnTop, 'screen-saver');
}

// Shared "write a settings patch" path used by BOTH the renderer IPC and the
// tray's Float-on-top toggle: validate -> merge -> persist -> apply main-side
// effects -> broadcast to the renderer -> keep the tray menu's checkmark in
// sync. Returns the full normalized settings.
function applySettingsPatch(partial) {
  var patch = schema.normalizeSettingsPatch(partial); // only valid known keys
  var merged = Object.assign({}, config.get('settings'), patch);
  config.set('settings', merged);
  applyMainSideSettings(merged);
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings:changed', merged); // renderer re-applies CSS/clock
  }
  updateTrayMenu(); // reflect alwaysOnTop (and anything else) on the tray
  return merged;
}

// --- menu-bar tray (macOS/Win/Linux; Electron-only) -------------------------

// Bring the widget to the front: restore if minimized, then show + focus.
function showAndFocus() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (typeof win.moveTop === 'function') win.moveTop();
}

// Tell the renderer (which OWNS the stopwatch state) to run a transition. Main
// never mutates timer state itself.
function sendTimerCommand(action) {
  if (win && !win.isDestroyed()) win.webContents.send('timer:command', { action: action });
}

// Ask the renderer to open the settings panel (it also triggers the window grow
// via the existing window:settings-open round-trip).
function requestOpenSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('ui:open-settings');
}

// Load the tray icon: a monochrome *Template image (macOS auto-inverts it for
// light/dark menu bars) if the host has dropped one in build/trayTemplate.png;
// otherwise an empty image (we add a short text title below so it's still
// visible and nothing ever crashes).
function trayImage() {
  try {
    var p = path.join(__dirname, 'build', 'trayTemplate.png');
    if (fs.existsSync(p)) {
      var img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        img.setTemplateImage(true); // macOS: auto light/dark inversion
        return img;
      }
    }
  } catch (e) { /* fall through to placeholder */ }
  return nativeImage.createEmpty();
}

// The ONE menu template, shared by BOTH the menu-bar tray and the pill's
// right-click context menu (buildFromTemplate is cheap, and reading config fresh
// each call keeps every checkmark current). Factoring it into a single builder is
// deliberate: the tray and the context menu must never drift — same items, same
// order, same labels. The stopwatch items read "Start/Pause/Reset Stopwatch" (the
// on-pill control icons are gone, so this menu is now the primary way to drive the
// timer, and the verbose labels make that obvious in a bare OS menu).
function buildMenuTemplate() {
  var s = config.get('settings');
  var floating = !!s.alwaysOnTop;
  // showClock/showStopwatch default to true for older configs that predate them.
  var showClock = s.showClock !== false;
  var showStopwatch = s.showStopwatch !== false;
  return [
    { label: 'Start Stopwatch', click: function () { sendTimerCommand('play'); } },
    { label: 'Pause Stopwatch', click: function () { sendTimerCommand('pause'); } },
    { label: 'Reset Stopwatch', click: function () { sendTimerCommand('reset'); } },
    { type: 'separator' },
    {
      label: 'Show clock',
      type: 'checkbox',
      checked: showClock,
      click: function (item) { applySettingsPatch({ showClock: !!item.checked }); }
    },
    {
      label: 'Show stopwatch',
      type: 'checkbox',
      checked: showStopwatch,
      click: function (item) { applySettingsPatch({ showStopwatch: !!item.checked }); }
    },
    { type: 'separator' },
    { label: 'Settings…', click: function () { showAndFocus(); requestOpenSettings(); } },
    { label: 'Show / Bring to Front', click: showAndFocus },
    {
      label: 'Float on top',
      type: 'checkbox',
      checked: floating,
      click: function (item) { applySettingsPatch({ alwaysOnTop: !!item.checked }); }
    },
    { type: 'separator' },
    { label: 'Quit', click: function () { app.quit(); } }
  ];
}

function buildTrayMenu() {
  return Menu.buildFromTemplate(buildMenuTemplate());
}

// Build + pop the native right-click context menu on the pill. Same template as
// the tray, so they can't diverge. Main-side only: no renderer IPC needed — the
// webContents 'context-menu' event already carries the right-click.
function popupContextMenu() {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
}

// Expose the template builder to the electron test suite so it can assert the
// shared labels (incl. the renamed stopwatch items) without a real right-click,
// which isn't reliably drivable headlessly. Test-only; never touched in prod.
if (IS_TEST) { global.__overtimeMenuTemplate = buildMenuTemplate; }

// Rebuild the tray menu so the Float-on-top / show-* checkmarks reflect current
// state. Called after any settings change (applySettingsPatch) and on startup.
// (The context menu rebuilds itself on every right-click, so it needs no refresh.)
function updateTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  var img = trayImage();
  try {
    tray = new Tray(img);
  } catch (e) {
    tray = null; // never let a tray failure take down the app
    return;
  }
  tray.setToolTip('Overtime');
  // Fallback label so the menu-bar entry is visible even without an icon asset
  // (macOS shows the title text next to/instead of the icon).
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
    tray.setTitle(img.isEmpty() ? '⏱' : '');
  }
  updateTrayMenu();
  // Left-click brings the widget to the front (on platforms where a click
  // doesn't auto-open the context menu).
  tray.on('click', showAndFocus);
}

// A minimal menu so Cmd/Ctrl+Q works when the widget is focused. The tray and the
// pill's right-click menu are the in-UI ways out now that the × button is gone.
function installMenu() {
  var template = [{ role: 'appMenu' }];
  if (process.platform !== 'darwin') {
    // On Win/Linux there's no app menu; a bare quit accelerator is enough.
    template = [{ label: 'File', submenu: [{ role: 'quit' }] }];
  }
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch (e) {
    // If the template isn't valid on this platform, a null menu is fine —
    // Cmd/Ctrl+Q still works via the default accelerator on macOS.
    Menu.setApplicationMenu(null);
  }
}

// --- lifecycle ---------------------------------------------------------------

app.whenReady().then(function () {
  installMenu();
  wireIpc();
  createWindow();
  createTray(); // menu-bar tray (no Dock icon — we're an accessory app)

  app.on('activate', function () {
    // macOS: re-create the window if it was closed but the app is still alive.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// A widget with no window is pointless — quit on all platforms (overrides the
// macOS stay-alive default).
app.on('window-all-closed', function () { app.quit(); });

// Flush whatever the renderer last pushed before we exit.
app.on('before-quit', function () {
  try { config.flushSync(); } catch (e) {}
});
