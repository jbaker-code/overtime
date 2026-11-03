'use strict';
/**
 * zip.js — zip a folder, and peek inside a zip.
 * macOS: `ditto` (the only tool that keeps .app symlinks, exec bits and resource forks).
 * Elsewhere: `tar -a -cf` (bsdtar writes zips from the extension).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Zip `srcDir` so unzipping yields ONE top-level folder named like srcDir. */
function zipDir(srcDir, destZip) {
  if (!fs.existsSync(srcDir)) throw new Error(`zipDir: nothing to zip at ${srcDir}`);
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  fs.rmSync(destZip, { force: true });
  if (process.platform === 'darwin') {
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', srcDir, destZip], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-a', '-cf', destZip, '-C', path.dirname(srcDir), path.basename(srcDir)], { stdio: 'inherit' });
  }
  if (!fs.existsSync(destZip)) throw new Error(`zip was not created: ${destZip}`);
  return fs.statSync(destZip).size;
}

/** List entry names in a zip (uses `unzip -Z1`, falling back to `tar -tf`). */
function listZip(zipPath) {
  let out;
  try {
    out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (_) {
    out = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
  }
  return out.split(/\r?\n/).filter(Boolean);
}

/** Throw unless the zip contains an entry ending with `suffix`. */
function assertZipContains(zipPath, suffix) {
  const entries = listZip(zipPath);
  if (!entries.some((e) => e.endsWith(suffix))) {
    throw new Error(`Sanity check failed: ${path.basename(zipPath)} has no entry ending in "${suffix}"`);
  }
}

module.exports = { zipDir, listZip, assertZipContains };
