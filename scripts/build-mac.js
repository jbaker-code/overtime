#!/usr/bin/env node
'use strict';
/**
 * build:mac — Overtime.app (unsigned, `dir` target) -> zip with README.txt.
 * Output: dist/mac/Overtime-mac-arm64-v<version>.zip AND ...-x64-v<version>.zip
 * Both architectures are always built (the old --x64 flag is a harmless no-op).
 */
const fs = require('fs');
const path = require('path');
const { ROOT, DIRS, NAMES, PRODUCT_NAME, resetDir, SCRATCH, safeRemove } = require('./lib/paths');
const { buildDir, findEntry } = require('./lib/run-builder');
const { stageAndZip } = require('./lib/stage');
const { assertZipContains } = require('./lib/zip');
const log = require('./lib/log');

log.run(async () => {
  log.info('Build folder: ' + require('./lib/paths').BUILD_DIR);
  // Both architectures, every time. (--x64 is accepted but is now a no-op.)
  const archs = ['arm64', 'x64'];
  resetDir(DIRS.mac);
  const outputs = [];

  for (const arch of archs) {
    // electron-builder reuses the same output folder, so clear it per arch.
    safeRemove(path.join(SCRATCH, 'electron-builder'));
    log.step(`electron-builder: macOS ${arch} (dir target, unsigned)`);
    const ebOut = await buildDir('MAC', arch);
    const app = findEntry(path.join(ebOut, arch === 'arm64' ? 'mac-arm64' : 'mac'),
      (n) => n.endsWith('.app'), '.app bundle');

    const outZip = path.join(DIRS.mac, NAMES.macZip(arch));
    const bytes = stageAndZip({
      appDir: app,
      appDestName: `${PRODUCT_NAME}.app`,
      usageDoc: path.join(ROOT, 'docs', 'usage-mac.txt'),
      stagingName: `${PRODUCT_NAME} (macOS ${arch})`,
      outZip,
    });
    assertZipContains(outZip, `${PRODUCT_NAME}.app/Contents/MacOS/${PRODUCT_NAME}`);
    log.ok(`${outZip} (${log.size(bytes)})`);
    outputs.push(outZip);
  }
  log.info('Unsigned on purpose. If macOS balks: right-click -> Open (see README.txt in the zip).');
  return outputs;
});
