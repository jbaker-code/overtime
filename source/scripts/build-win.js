#!/usr/bin/env node
'use strict';
/**
 * build:win — win-unpacked folder (unsigned, `dir` target, exe left untouched) -> zip.
 * Output: dist/windows/Overtime-windows-x64-v<version>.zip
 */
const path = require('path');
const { ROOT, DIRS, NAMES, PRODUCT_NAME, resetDir, SCRATCH, safeRemove } = require('./lib/paths');
const { buildDir } = require('./lib/run-builder');
const { stageAndZip } = require('./lib/stage');
const { assertZipContains } = require('./lib/zip');
const log = require('./lib/log');

log.run(async () => {
  log.info('Build folder: ' + require('./lib/paths').BUILD_DIR);
  resetDir(DIRS.windows);
  safeRemove(path.join(SCRATCH, 'electron-builder'));

  log.step('electron-builder: Windows x64 (dir target, no exe patching)');
  const ebOut = await buildDir('WINDOWS', 'x64');
  const unpacked = path.join(ebOut, 'win-unpacked');

  const outZip = path.join(DIRS.windows, NAMES.winZip);
  const bytes = stageAndZip({
    appDir: unpacked,
    appDestName: PRODUCT_NAME, // win-unpacked renamed to "Overtime"
    usageDoc: path.join(ROOT, 'docs', 'usage-windows.txt'),
    stagingName: `${PRODUCT_NAME} (Windows x64)`,
    outZip,
  });
  assertZipContains(outZip, `${PRODUCT_NAME}/${PRODUCT_NAME}.exe`);
  log.ok(`${outZip} (${log.size(bytes)})`);
  log.warn('Built on macOS, NOT run. Smoke-test on a Windows machine before telling viewers it is great.');
});
