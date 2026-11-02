#!/usr/bin/env node
'use strict';
/**
 * build:single — inline src/renderer/index.html (+ CSS + JS) into ONE index.html.
 * Output: dist/single-file/index.html   (or --out <path> to write elsewhere, e.g. tests)
 */
const fs = require('fs');
const path = require('path');
const { ROOT, DIRS, NAMES, VERSION, resetDir } = require('./lib/paths');
const { inlineHtml } = require('./lib/inline-html');
const log = require('./lib/log');

function parseOut(argv) {
  const i = argv.findIndex((a) => a === '--out' || a.startsWith('--out='));
  if (i === -1) return null;
  const v = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  if (!v) throw new Error('--out needs a path');
  return path.resolve(v);
}

log.run(async () => {
  if (!process.argv.includes('--out')) log.info('Build folder: ' + require('./lib/paths').BUILD_DIR);
  const srcHtml = path.join(ROOT, 'src', 'renderer', 'index.html');
  if (!fs.existsSync(srcHtml)) throw new Error(`Renderer page not found: ${srcHtml}`);

  const banner = [
    `Overtime v${VERSION} - single-file browser build, generated ${new Date().toISOString()}`,
    'Everything (HTML, CSS, JS) is inlined into this one file. Do not edit; rebuild with `npm run build:single`.',
    'Browser-mode limits: no always-on-top, no frameless window, no drag-to-move, no quit button / resize grip.',
    'Clock, stopwatch and hover controls work; state persists via localStorage (per browser, per origin).',
  ].join('\n');

  const html = inlineHtml(fs.readFileSync(srcHtml, 'utf8'), {
    baseDir: path.dirname(srcHtml),
    readFile: (p) => {
      if (!fs.existsSync(p)) throw new Error(`index.html references a missing file: ${p}`);
      return fs.readFileSync(p, 'utf8');
    },
    banner,
  });

  const explicit = parseOut(process.argv.slice(2));
  let out;
  if (explicit) {
    fs.mkdirSync(path.dirname(explicit), { recursive: true });
    out = explicit;
  } else {
    resetDir(DIRS.single);
    out = path.join(DIRS.single, NAMES.singleHtml);
  }
  fs.writeFileSync(out, html);
  log.ok(`${out} (${log.size(Buffer.byteLength(html))})`);
});
