#!/usr/bin/env node
'use strict';
/**
 * clean — wipe (1) the OS-temp scratch dir and (2) ALL <repo-root>/tmp/overtime-build-*
 * folders (accumulated builds). Nothing else; safeRemove in lib/paths.js throws otherwise.
 */
const fs = require('fs');
const { SCRATCH, listBuildDirs, safeRemove } = require('./lib/paths');
const log = require('./lib/log');

log.run(async () => {
  const targets = [SCRATCH, ...listBuildDirs()];
  for (const target of targets) {
    if (fs.existsSync(target)) { safeRemove(target); log.ok(`removed ${target}`); }
    else log.info(`already clean: ${target}`);
  }
  if (targets.length === 1) log.info('no tmp/overtime-build-* folders found');
});
