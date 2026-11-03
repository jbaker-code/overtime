'use strict';
/**
 * electron-builder config (a JS file so the output dir can come from os.tmpdir()).
 *
 * Deliberately minimal: `dir` target only, on BOTH platforms. Unsigned. Our own scripts
 * stage + zip the result. Targets are chosen in the build scripts via the programmatic
 * API; they are repeated here so the config is self-describing.
 */
const path = require('path');
const { SCRATCH } = require('./paths');

module.exports = {
  appId: 'io.github.jbaker-code.overtime',
  productName: 'Overtime',
  directories: {
    output: path.join(SCRATCH, 'electron-builder'),
    buildResources: 'source/electron/build',
  },
  // Globs are relative to projectDir (the repo root). Mirrors the pre-reorg set
  // (main + preload + the two main-process modules + renderer/shared), now under source/.
  files: [
    'source/electron/main.js',
    'source/electron/preload.js',
    'source/electron/config.js',
    'source/electron/window-state.js',
    'source/app/**/*',
    'package.json',
  ],
  asar: true,
  npmRebuild: false, // no native deps; skip the slow step
  compression: 'normal',
  mac: {
    target: [{ target: 'dir', arch: ['arm64', 'x64'] }], // build-mac.js builds each arch in turn
    category: 'public.app-category.utilities',
    identity: null, // unsigned on purpose
    hardenedRuntime: false,
    gatekeeperAssess: false,
    extendInfo: { LSUIElement: true }, // menu-bar tray app: no Dock icon (packaged)
  },
  win: {
    target: [{ target: 'dir', arch: ['x64'] }],
    signAndEditExecutable: false, // no exe patching at all, so no extra tooling on macOS
  },
};
