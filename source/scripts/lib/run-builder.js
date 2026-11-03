'use strict';
/**
 * run-builder.js — shared wrapper around electron-builder's programmatic API.
 * Loaded lazily so `build:single` / `build:source` / `clean` work without it installed.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');
const config = require('./electron-builder.config');

/** Build one platform/arch as a `dir` target. Returns the electron-builder output dir. */
async function buildDir(platformName, archName) {
  // Never go hunting the keychain for a certificate or sign with one by accident.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  let eb;
  try {
    eb = require('electron-builder');
  } catch (e) {
    throw new Error('electron-builder is not installed. Run `npm install` in the overtime repo first (on the host).');
  }
  const platform = eb.Platform[platformName]; // MAC | WINDOWS
  const arch = eb.Arch[archName];             // arm64 | x64
  // electron-builder MUTATES the config object it receives (normalizes `files` into
  // FileSet objects, etc.). Reusing the same object for a second build() throws
  // "Cannot read properties of null (reading 'from')" — so give each build a fresh clone.
  await eb.build({
    projectDir: ROOT,
    targets: platform.createTarget(['dir'], arch),
    config: structuredClone(config),
    publish: 'never',
  });
  return config.directories.output;
}

/** Find the first directory entry in `dir` matching `pred` (throws with a helpful message). */
function findEntry(dir, pred, what) {
  if (!fs.existsSync(dir)) throw new Error(`Expected ${what} output dir missing: ${dir}`);
  const hit = fs.readdirSync(dir).find(pred);
  if (!hit) throw new Error(`Could not find ${what} in ${dir} (saw: ${fs.readdirSync(dir).join(', ')})`);
  return path.join(dir, hit);
}

module.exports = { buildDir, findEntry };
