// preload.js
// -----------------------------------------------------------------------------
// The ONE bridge between the sandboxed renderer and the main process.
//
// Security posture (PLAN §2.3): contextIsolation is ON and sandbox is ON, so
// the renderer gets no Node, no `remote`, no `require`. The only thing it can
// see from us is the single `window.episodeTimer` object defined here, and that
// object only ever calls the frozen IPC channels below. Nothing else leaks.
// -----------------------------------------------------------------------------
'use strict';

var electron = require('electron');
var contextBridge = electron.contextBridge;
var ipcRenderer = electron.ipcRenderer;

contextBridge.exposeInMainWorld('episodeTimer', {
  isElectron: true,
  platform: process.platform, // 'darwin' | 'win32' | 'linux'

  // --- episode stopwatch persistence ---
  // getTimer resolves to the saved (already-normalized) timer, or null if we've
  // never saved one. pushTimer is fire-and-forget (main debounces disk I/O).
  getTimer: function () { return ipcRenderer.invoke('timer:get'); },
  pushTimer: function (t) { ipcRenderer.send('timer:push', t); },

  // --- settings (wired now; no UI in v1) ---
  // getSettings always resolves to a COMPLETE settings object (defaults merged).
  // setSettings merges a partial, persists, applies main-side effects, and
  // resolves to the full normalized settings.
  getSettings: function () { return ipcRenderer.invoke('config:get-settings'); },
  setSettings: function (partial) { return ipcRenderer.invoke('config:set-settings', partial); },

  // Subscribe to main-broadcast settings changes. Returns an unsubscribe fn.
  onSettingsChanged: function (cb) {
    var listener = function (_event, settings) { cb(settings); };
    ipcRenderer.on('settings:changed', listener);
    return function () { ipcRenderer.removeListener('settings:changed', listener); };
  },

  // --- window controls ---
  // resizeBy drives the custom corner grip — of WHICHEVER window sent it: main
  // resolves the sender's BrowserWindow, so the same channel resizes the pill OR
  // the separate settings window (each has its own grip). quit is the legacy ×.
  resizeBy: function (dx, dy) { ipcRenderer.send('window:resize-by', { dx: dx, dy: dy }); },
  quit: function () { ipcRenderer.send('app:quit'); },

  // Ask main to open (or focus) the SEPARATE settings window. Used by the pill's
  // test/debug hook and anywhere a renderer wants to pop settings; the tray /
  // right-click "Settings…" calls the same main-side opener directly. (Replaces the
  // old window:settings-open grow round-trip — the pill no longer grows for settings.)
  openSettings: function () { ipcRenderer.send('window:open-settings'); },

  // Main -> renderer: the tray's Play/Pause/Reset. The renderer owns the
  // stopwatch state, so it runs the transition. cb receives 'play'|'pause'|'reset'.
  // Returns an unsubscribe function.
  onTimerCommand: function (cb) {
    var listener = function (_event, payload) { cb(payload && payload.action); };
    ipcRenderer.on('timer:command', listener);
    return function () { ipcRenderer.removeListener('timer:command', listener); };
  },

  // Main -> renderer: the hover fallback. The whole pill is -webkit-app-region: drag, and in
  // a frameless window that native drag region swallows the DOM mouseenter/leave the renderer
  // would otherwise use — so against a real OS cursor the hover tint never appeared. main
  // polls the OS cursor vs the window bounds and pushes the hover state here; the renderer
  // maps it to data-hover (the 50%-black grab tint). cb receives a boolean. Returns an
  // unsubscribe function, matching onSettingsChanged / onTimerCommand.
  onHoverChanged: function (cb) {
    var listener = function (_event, payload) { cb(!!(payload && payload.hover)); };
    ipcRenderer.on('hover:changed', listener);
    return function () { ipcRenderer.removeListener('hover:changed', listener); };
  }
});
