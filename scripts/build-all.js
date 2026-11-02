#!/usr/bin/env node
'use strict';
/**
 * build:all — single, source (fast, offline) then mac, then win. Stops at first failure
 * and prints a summary table. Extra CLI args are forwarded to build-mac (mac builds arm64 + x64 by default).
 */
const path = require('path');
const { spawnSync } = require('child_process');
const log = require('./lib/log');
// Compute the slug ONCE (paths.js generates it) and share it with every child process
// so all four targets land in the same tmp/overtime-build-<slug>/dist/ folder.
const { SLUG, BUILD_DIR } = require('./lib/paths');
process.env.EPISODE_TIMER_BUILD_SLUG = SLUG;
console.log(`Build folder: ${BUILD_DIR}\n`);

const extra = process.argv.slice(2);
const STEPS = [
  ['single-file', 'build-single-file.js', []],
  ['source zip', 'build-source-zip.js', []],
  ['macOS', 'build-mac.js', extra],
  ['Windows', 'build-win.js', []],
];

const results = [];
let failed = false;
for (const [label, file, args] of STEPS) {
  log.step(`${label}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', env: process.env });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ label, ok, secs });
  if (!ok) { failed = true; break; }
}

console.log('\n--- build summary ---');
console.log(`build folder: ${BUILD_DIR}`);
for (const r of results) console.log(`${r.ok ? ' ok   ' : ' FAIL '} ${r.label.padEnd(12)} ${r.secs}s`);
for (const [label] of STEPS.slice(results.length)) console.log(` skip  ${label}`);
const fs = require('fs');
const { DIRS } = require('./lib/paths');
for (const [label, dir] of [['mac', DIRS.mac], ['windows', DIRS.windows]]) {
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) console.log(`       ${label}: ${f}`);
}
console.log(failed ? '\nBuild FAILED (see above).' : '\nAll builds done. Output is in ' + BUILD_DIR + '/dist/');
process.exit(failed ? 1 : 0);
