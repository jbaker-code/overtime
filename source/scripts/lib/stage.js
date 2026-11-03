'use strict';
/**
 * stage.js — build <SCRATCH>/stage/<stagingName>/ holding the app + README.txt,
 * then zip it so unzipping yields one tidy folder.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, SCRATCH, safeRemove } = require('./paths');
const { zipDir } = require('./zip');
const log = require('./log');

/** Copy a file or directory preserving symlinks (important for .app bundles). */
function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

/**
 * @param {object} o
 * @param {string} o.appDir       built app (the .app bundle, or the win-unpacked folder)
 * @param {string} o.appDestName  name it gets inside the staging folder
 * @param {string} o.usageDoc     path to docs/usage-*.txt (copied as README.txt; skipped if missing)
 * @param {string} o.stagingName  top-level folder name inside the zip
 * @param {string} o.outZip       destination zip
 * @returns {number} zip size in bytes
 */
function stageAndZip({ appDir, appDestName, usageDoc, stagingName, outZip }) {
  if (!fs.existsSync(appDir)) throw new Error(`Built app not found: ${appDir}`);
  const stageRoot = path.join(SCRATCH, 'stage');
  const stage = path.join(stageRoot, stagingName);
  safeRemove(stage);
  fs.mkdirSync(stage, { recursive: true });

  log.step(`Staging ${stagingName}`);
  copyTree(appDir, path.join(stage, appDestName));

  if (usageDoc && fs.existsSync(usageDoc)) {
    fs.copyFileSync(usageDoc, path.join(stage, 'README.txt'));
  } else {
    log.warn(`${path.relative(ROOT, usageDoc || 'docs/usage-*.txt')} not found, zip will have no README.txt`);
  }
  const license = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(stage, 'LICENSE'));

  log.step(`Zipping -> ${outZip}`);
  return zipDir(stage, outZip);
}

module.exports = { stageAndZip, copyTree };
