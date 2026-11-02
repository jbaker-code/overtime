// Shared paths for the test suite. Mirrors scripts/lib/paths.js (PLAN.md §4.1) without
// importing it, so tests still load if the build scripts are missing/broken.
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.EPISODE_TIMER_SCRATCH || path.join(os.tmpdir(), 'overtime-build-scratch');
const TEST_DIR = path.join(SCRATCH, 'test');
const SINGLE_FILE = path.join(TEST_DIR, 'index.html');
const BUILD_ERROR_FILE = path.join(TEST_DIR, 'build-error.txt');
const STORAGE_KEY = 'episode-timer.config.v1';

module.exports = { ROOT, SCRATCH, TEST_DIR, SINGLE_FILE, BUILD_ERROR_FILE, STORAGE_KEY };
