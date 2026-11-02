'use strict';
/**
 * inline-html.js — the single-file inliner. Pure function: no disk access of its own;
 * the caller supplies `readFile`. Unit-testable.
 *
 * Replaces, in document order:
 *   <link rel="stylesheet" href="REL">  ->  <style>…</style>
 *   <script src="REL"></script>         ->  <script>…</script>
 * Relative paths only. http(s):, //, data:, absolute paths -> throws (none allowed).
 */
const path = require('path');

/** Escape sequences that would end the surrounding <script>/<style> early. */
function escapeScript(js) {
  // `</script` (any case) ends the element; `<!--` can trigger legacy script-data quirks.
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}
function escapeStyle(css) {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function assertRelative(ref, what) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref)) {
    throw new Error(`Inliner: ${what} must be a relative path, got "${ref}"`);
  }
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}

/**
 * @param {string} html
 * @param {{baseDir:string, readFile:(absPath:string)=>string, banner?:string}} opts
 */
function inlineHtml(html, { baseDir, readFile, banner = '' }) {
  const read = (ref) => readFile(path.resolve(baseDir, ref));

  // NOTE: replacer callbacks (not replacement strings) so "$&" etc. in JS is left alone.
  let out = html.replace(/<script\b[^>]*>\s*<\/script\s*>/gi, (tag) => {
    const src = attr(tag, 'src');
    if (src === null) return tag; // an inline script already; leave it
    assertRelative(src, '<script src>');
    return `<script>\n${escapeScript(read(src))}\n</script>`;
  });

  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attr(tag, 'rel');
    if (!rel || !/\bstylesheet\b/i.test(rel)) return tag;
    const href = attr(tag, 'href');
    if (href === null) return tag;
    assertRelative(href, '<link href>');
    return `<style>\n${escapeStyle(read(href))}\n</style>`;
  });

  // Anything still pointing outside the file is a contract violation.
  const leftover = /<(?:script|img|link|source|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = leftover.exec(out))) {
    if (/^(https?:)?\/\//i.test(m[1]) || /^\.{0,2}\//.test(m[1]) || /\.(js|css|png|jpe?g|svg|woff2?)$/i.test(m[1])) {
      throw new Error(`Inliner: unresolved external reference left in output: "${m[1]}"`);
    }
  }

  if (banner) {
    const b = `<!--\n${banner.replace(/--/g, '- -')}\n-->\n`;
    out = /^\s*<!doctype[^>]*>/i.test(out) ? out.replace(/^(\s*<!doctype[^>]*>\s*)/i, (d) => d + b) : b + out;
  }
  return out;
}

module.exports = { inlineHtml, escapeScript, escapeStyle };
