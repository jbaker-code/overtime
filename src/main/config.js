// src/main/config.js
// -----------------------------------------------------------------------------
// THE config module (main-process side). One JSON file in userData, written
// atomically (tmp file + rename), tolerant of a missing or corrupt file, with
// in-memory get/set/update and a debounced disk write. See PLAN §2.4.
//
//   macOS:   ~/Library/Application Support/Overtime/config.json
//   Windows: %APPDATA%\Overtime\config.json
//   tests:   EPISODE_TIMER_USER_DATA overrides the folder.
//
// Shape/validation live in the shared schema so main, renderer and browser mode
// all agree. This module is the ONLY thing that touches the file.
// -----------------------------------------------------------------------------
'use strict';

var fs = require('fs');
var path = require('path');
var schema = require('../shared/config-schema');

// Resolve the userData directory lazily. In Electron we ask `app` (main.js has
// already honored EPISODE_TIMER_USER_DATA via app.setPath before we load). We
// also read the env var directly as a belt-and-suspenders fallback.
function userDataDir() {
  if (process.env.EPISODE_TIMER_USER_DATA) return process.env.EPISODE_TIMER_USER_DATA;
  try {
    // Lazy require so `node --check`/requiring shared modules never drags Electron in.
    var app = require('electron').app;
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) { /* not in Electron; fall through */ }
  // Last resort (shouldn't happen in normal use): cwd.
  return process.cwd();
}

function filePath() { return path.join(userDataDir(), 'config.json'); }
function tmpPath() { return filePath() + '.tmp'; }

var WRITE_DEBOUNCE_MS = 500;

// Module state.
var data = schema.clone(schema.DEFAULT_CONFIG); // current in-memory config
var writeTimer = null; // pending debounced write
var loaded = false;

function log(msg) { try { console.log('[config] ' + msg); } catch (e) {} }

// Read a dotted path, e.g. get('settings.hour12'). No path -> whole config.
function getAt(obj, dotted) {
  if (!dotted) return obj;
  var parts = dotted.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// Set a dotted path, creating intermediate objects as needed.
function setAt(obj, dotted, value) {
  var parts = dotted.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    var k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

// --- loading ----------------------------------------------------------------

// load() — never throws. ENOENT -> defaults. Parse error / non-object -> defaults
// AND move the bad file aside as config.json.corrupt-<ts> so nothing is silently
// destroyed. Always normalizes through the shared schema.
function load() {
  var fp = filePath();
  var raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      log('no config file yet -> starting from defaults (' + fp + ')');
    } else {
      log('could not read config (' + (e && e.code) + ') -> defaults');
    }
    data = schema.clone(schema.DEFAULT_CONFIG);
    loaded = true;
    return data;
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    quarantineCorrupt(fp, 'invalid JSON');
    data = schema.clone(schema.DEFAULT_CONFIG);
    loaded = true;
    return data;
  }

  // A valid-JSON-but-wrong-type file (e.g. `[]` or `"hello"`) is also corrupt
  // for our purposes — set it aside too.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    quarantineCorrupt(fp, 'not an object');
    data = schema.clone(schema.DEFAULT_CONFIG);
    loaded = true;
    return data;
  }

  data = schema.normalizeConfig(parsed);
  loaded = true;
  log('loaded config from ' + fp);
  return data;
}

function quarantineCorrupt(fp, why) {
  var dest = fp + '.corrupt-' + Date.now();
  try {
    fs.renameSync(fp, dest);
    log('corrupt config (' + why + ') moved to ' + dest + ' -> using defaults');
  } catch (e) {
    log('corrupt config (' + why + ') and could not move it (' + (e && e.code) + ') -> using defaults');
  }
}

// --- reading / writing in memory --------------------------------------------

function get(dotted) {
  if (!loaded) load();
  return getAt(data, dotted);
}

// set(path, value) — writes into memory then schedules a debounced disk flush.
function set(dotted, value) {
  if (!loaded) load();
  setAt(data, dotted, value);
  scheduleWrite();
  return data;
}

// update(partial) — shallow-merge a partial config at the top level (and one
// level into `settings`), then schedule a write.
function update(partial) {
  if (!loaded) load();
  if (partial && typeof partial === 'object') {
    Object.keys(partial).forEach(function (k) {
      if (k === 'settings' && partial.settings && typeof partial.settings === 'object') {
        data.settings = Object.assign({}, data.settings, partial.settings);
      } else {
        data[k] = partial[k];
      }
    });
  }
  scheduleWrite();
  return data;
}

// --- disk I/O (atomic) -------------------------------------------------------

function scheduleWrite() {
  if (writeTimer) return; // already pending; coalesce
  writeTimer = setTimeout(function () {
    writeTimer = null;
    writeNow();
  }, WRITE_DEBOUNCE_MS);
  // Don't let a pending write keep the process alive on quit.
  if (writeTimer && typeof writeTimer.unref === 'function') writeTimer.unref();
}

// The atomic write: stringify -> write a .tmp -> rename over the real file.
// rename() is atomic on the same filesystem, so a reader never sees a
// half-written file and a crash mid-write leaves the previous good file intact.
function writeNow() {
  var fp = filePath();
  var tmp = tmpPath();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (e) {
    log('write failed (' + (e && e.code) + ')');
    // Best-effort cleanup of a stray tmp file.
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }
}

// flushSync() — write immediately (used from before-quit). Cancels any pending
// debounced write first so we don't double-write.
function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  writeNow();
}

module.exports = {
  load: load,
  get: get,
  set: set,
  update: update,
  flushSync: flushSync,
  filePath: filePath
};
