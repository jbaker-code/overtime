// source/app/renderer/bridge.js
// -----------------------------------------------------------------------------
// One API, two environments. The rest of the renderer (app.js) never touches
// window.episodeTimer or localStorage directly — it goes through
// window.EpisodeTimerBridge, which looks identical whether we're running inside
// Electron or as a plain browser tab (the single-file build).
//
//   Electron  -> forwards to the preload's window.episodeTimer (real IPC).
//   Browser   -> a localStorage-backed fallback using the SAME shared schema,
//                so persistence behaves the same (minus window bounds, which
//                are meaningless in a tab). always-on-top / frameless / resize /
//                quit don't exist in a browser, so those degrade to no-ops and
//                the renderer hides the affordances.
//
// Depends on window.EpisodeTimerConfigSchema (load config-schema.js first).
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  var schema = root.EpisodeTimerConfigSchema;
  var LS_KEY = 'episode-timer.config.v1';

  // --- Electron bridge: thin forwarder over the preload object ---------------
  function makeElectronBridge(api) {
    return {
      env: 'electron',
      getTimer: function () { return api.getTimer(); },
      pushTimer: function (t) { api.pushTimer(t); },
      getSettings: function () { return api.getSettings(); },
      setSettings: function (partial) { return api.setSettings(partial); },
      onSettingsChanged: function (cb) { return api.onSettingsChanged(cb); },
      resizeBy: function (dx, dy) { api.resizeBy(dx, dy); },
      quit: function () { api.quit(); },
      // Ask main to open/focus the SEPARATE settings window (Electron only).
      openSettings: function () { api.openSettings(); },
      onTimerCommand: function (cb) { return api.onTimerCommand(cb); },
      // Main's cursor-poll hover fallback (the drag region swallows DOM mouseenter/leave).
      onHoverChanged: function (cb) { return api.onHoverChanged(cb); }
    };
  }

  // --- Browser bridge: localStorage + the shared normalizer ------------------
  function makeBrowserBridge() {
    var listeners = [];

    // Read the whole config blob from localStorage, normalized. Any failure
    // (no storage, bad JSON, private mode) -> defaults. Never throws.
    function readBlob() {
      var raw = null;
      try { raw = root.localStorage.getItem(LS_KEY); } catch (e) {}
      var parsed = null;
      if (raw) { try { parsed = JSON.parse(raw); } catch (e) {} }
      return schema.normalizeConfig(parsed);
    }

    function writeBlob(blob) {
      try { root.localStorage.setItem(LS_KEY, JSON.stringify(blob)); } catch (e) {}
    }

    return {
      env: 'browser',

      // Promises everywhere so the two bridges have the exact same async shape.
      getTimer: function () {
        return Promise.resolve(readBlob().timer || null);
      },
      pushTimer: function (t) {
        var blob = readBlob();
        blob.timer = t;
        blob = schema.normalizeConfig(blob); // keep it honest
        writeBlob(blob);
      },
      getSettings: function () {
        return Promise.resolve(readBlob().settings);
      },
      setSettings: function (partial) {
        var blob = readBlob();
        var patch = schema.normalizeSettingsPatch(partial);
        blob.settings = Object.assign({}, blob.settings, patch);
        writeBlob(blob);
        // Fire change listeners, mirroring Electron's settings:changed broadcast.
        var merged = blob.settings;
        listeners.forEach(function (cb) { try { cb(merged); } catch (e) {} });
        return Promise.resolve(merged);
      },
      onSettingsChanged: function (cb) {
        listeners.push(cb);
        return function () {
          var i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        };
      },

      // No OS window in a tab — these simply do nothing (the panel already
      // overlays the page in browser mode, so there's nothing to grow/move).
      resizeBy: function () {},
      quit: function () {},
      setSettingsOpen: function () {},
      // Browser mode opens the IN-PAGE panel directly (app.js openSettings() ->
      // panel.open()), so this external-window opener is never reached here; keep a
      // no-op so the API shape matches the Electron bridge.
      openSettings: function () {},
      // No tray in a browser tab — this never fires. Return a no-op unsubscribe.
      onTimerCommand: function () { return function () {}; },
      // No cursor poll in a browser tab: a plain page has no drag region, so the renderer's
      // own DOM mouseenter/leave drive data-hover directly. No-op subscription.
      onHoverChanged: function () { return function () {}; }
    };
  }

  // Pick the environment once, at load.
  var bridge;
  if (root.episodeTimer && root.episodeTimer.isElectron) {
    bridge = makeElectronBridge(root.episodeTimer);
  } else {
    bridge = makeBrowserBridge();
  }

  root.EpisodeTimerBridge = bridge;
}(typeof self !== 'undefined' ? self : this));
