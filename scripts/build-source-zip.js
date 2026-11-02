#!/usr/bin/env node
'use strict';
/**
 * build:source — zip the project source (file-walk, NOT git archive, so uncommitted
 * files are included). Top-level folder inside the zip: overtime-source/
 * Output: dist/source/overtime-source-v<version>.zip
 */
const fs = require('fs');
const path = require('path');
const { ROOT, SCRATCH, DIRS, NAMES, resetDir, safeRemove } = require('./lib/paths');
const { zipDir } = require('./lib/zip');
const log = require('./lib/log');

// Exclude deps, build output (dist + the per-build tmp/), the committed binary
// releases, VCS, and OS cruft — the source zip is SOURCE, not artifacts.
const IGNORE_NAMES = new Set(['node_modules', 'dist', 'tmp', 'releases', 'test-results', 'playwright-report', '.git', '.DS_Store']);
const ignored = (name) => IGNORE_NAMES.has(name) || name.endsWith('.log');

/** Recursive copy honouring the ignore list; symlinks are skipped. */
function walkCopy(src, dest, counter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignored(ent.name) || ent.isSymbolicLink()) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) walkCopy(s, d, counter);
    else if (ent.isFile()) { fs.copyFileSync(s, d); counter.n++; }
  }
}

log.run(async () => {
  log.info('Build folder: ' + require('./lib/paths').BUILD_DIR);
  const stage = path.join(SCRATCH, 'stage', 'overtime-source');
  safeRemove(stage);
  const counter = { n: 0 };
  log.step('Collecting source files');
  walkCopy(ROOT, stage, counter);

  resetDir(DIRS.source);
  const out = path.join(DIRS.source, NAMES.sourceZip);
  const bytes = zipDir(stage, out);
  log.ok(`${out} (${counter.n} files, ${log.size(bytes)})`);
});
