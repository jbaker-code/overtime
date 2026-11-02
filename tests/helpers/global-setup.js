// Builds the single-file page once, into <scratch>/test/index.html, via
// `node scripts/build-single-file.js --out <path>` (PLAN.md §4.3 / §5.1).
//
// It NEVER throws: the unit project must still be runnable if the build is broken. A build
// failure is written to build-error.txt and the single-file spec re-throws it loudly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, TEST_DIR, SINGLE_FILE, BUILD_ERROR_FILE } = require('./paths');

module.exports = async function globalSetup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  for (const f of [SINGLE_FILE, BUILD_ERROR_FILE]) fs.rmSync(f, { force: true });

  const script = path.join(ROOT, 'scripts', 'build-single-file.js');
  if (!fs.existsSync(script)) {
    fs.writeFileSync(BUILD_ERROR_FILE, `scripts/build-single-file.js not found at ${script}`);
    return;
  }
  const r = spawnSync(process.execPath, [script, '--out', SINGLE_FILE], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(SINGLE_FILE)) {
    fs.writeFileSync(
      BUILD_ERROR_FILE,
      `build-single-file failed (exit ${r.status})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
    );
  }
};
