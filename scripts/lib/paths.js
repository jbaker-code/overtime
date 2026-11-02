'use strict';
/**
 * paths.js — every path and artifact name the build pipeline uses, in one place,
 * plus the guard that stops us from ever deleting anything outside those places.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // the repo root (scripts/lib -> repo)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const VERSION = pkg.version;
const PRODUCT_NAME = pkg.productName || 'Overtime';

// Final artifacts go to <repo>/tmp/overtime-build-<YYYYMMDD-HHMMSS>-<slug>/dist/...
// (gitignored, old builds accumulate). Only plain files land there. The electron-builder
// SCRATCH below MUST stay on local disk: the unpacked .app is full of symlinks that a
// network/shared volume cannot store.
const REPO_TMP = path.join(ROOT, 'tmp'); // <repo>/tmp/ — build temp (gitignored)
const BUILD_PREFIX = 'overtime-build-';
const SLUG_RE = /^\d{8}-\d{6}-[a-z0-9]{5}$/;

function makeSlug() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return `${stamp}-${r}`;
}

// ONE slug per run: build-all generates it and hands it to children via this env var.
const SLUG = process.env.EPISODE_TIMER_BUILD_SLUG || makeSlug();
if (!SLUG_RE.test(SLUG)) throw new Error(`Bad EPISODE_TIMER_BUILD_SLUG "${SLUG}" (want YYYYMMDD-HHMMSS-xxxxx)`);
const BUILD_DIR = path.join(REPO_TMP, BUILD_PREFIX + SLUG);
const DIST = path.join(BUILD_DIR, 'dist');

// Scratch lives OUTSIDE the repo. Override with EPISODE_TIMER_SCRATCH (must still be
// inside the OS temp dir, enforced below).
const TMP = fs.realpathSync(os.tmpdir());
const SCRATCH = path.resolve(
  process.env.EPISODE_TIMER_SCRATCH || path.join(TMP, 'overtime-build-scratch')
);

const DIRS = {
  mac: path.join(DIST, 'mac'),
  windows: path.join(DIST, 'windows'),
  single: path.join(DIST, 'single-file'),
  source: path.join(DIST, 'source'),
};

const NAMES = {
  macZip: (arch) => `Overtime-mac-${arch}-v${VERSION}.zip`,
  winZip: `Overtime-windows-x64-v${VERSION}.zip`,
  sourceZip: `overtime-source-v${VERSION}.zip`,
  singleHtml: 'index.html',
};

/** True if `child` is `parent` itself or somewhere beneath it. */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Paranoia: refuse to even load if scratch is not strictly inside the temp dir.
if (!isInside(SCRATCH, TMP) || SCRATCH === TMP) {
  throw new Error(`Refusing to use scratch dir outside the OS temp dir: ${SCRATCH}`);
}

/**
 * The ONLY way scripts delete directories. Allowed: SCRATCH or <repo>/tmp/overtime-build-* (or
 * things inside them). Anything else throws. (ROOT itself and DIST's parents are never allowed.)
 */
function safeRemove(target) {
  const t = path.resolve(target);
  // Allowed area 2: <repo>/tmp/overtime-build-*/ (the folder itself or anything inside it).
  const rel = path.relative(REPO_TMP, t);
  const first = rel.split(path.sep)[0];
  const inBuild = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && first.startsWith(BUILD_PREFIX);
  // Allowed area 1: the OS-temp scratch (SCRATCH itself or inside).
  if (!isInside(t, SCRATCH) && !inBuild) {
    throw new Error(`safeRemove: refusing to delete outside scratch / tmp/${BUILD_PREFIX}*: ${t}`);
  }
  // maxRetries/retryDelay: tolerate transient ENOTEMPTY/EBUSY on network/virtual
  // filesystems (e.g. a VM shared folder) where recursive removal can briefly race.
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Every existing <repo>/tmp/overtime-build-* directory (used by clean). */
function listBuildDirs() {
  if (!fs.existsSync(REPO_TMP)) return [];
  return fs.readdirSync(REPO_TMP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name.startsWith(BUILD_PREFIX))
    .map((e) => path.join(REPO_TMP, e.name));
}

/** Empty a directory (delete + recreate) via the guard. */
function resetDir(dir) {
  safeRemove(dir);
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { ROOT, REPO_TMP, SLUG, BUILD_DIR, listBuildDirs, DIST, SCRATCH, TMP, DIRS, NAMES, VERSION, PRODUCT_NAME, isInside, safeRemove, resetDir };
