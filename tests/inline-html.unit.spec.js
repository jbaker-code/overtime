// PLAN §5.2 "Single-file build correctness": tags replaced in order, no src=/href= left,
// "</script" escaped, absolute URL -> throws.  Project: unit.
//
// Signature (scripts/lib/inline-html.js): inlineHtml(html, { baseDir, readFile, banner }).
// `readFile` is REQUIRED (the inliner does no disk access itself), so we inject fs here.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inlineHtml } = require('../scripts/lib/inline-html.js');

const inline = (html, baseDir) => inlineHtml(html, { baseDir, readFile: (p) => fs.readFileSync(p, 'utf8') });

let dir;
test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-spec-'));
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.mkdirSync(path.join(dir, 'renderer'));
  fs.writeFileSync(path.join(dir, 'renderer', 'styles.css'), 'body{color:red}/*CSS_MARK*/');
  fs.writeFileSync(path.join(dir, 'shared', 'a.js'), 'window.A=1;/*A_MARK*/');
  fs.writeFileSync(path.join(dir, 'renderer', 'b.js'), 'window.B=2;/*B_MARK*/');
  fs.writeFileSync(path.join(dir, 'renderer', 'evil.js'), 'var s="</script><b>x</b>";/*EVIL_MARK*/');
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = () => path.join(dir, 'renderer');
const page = (body) => `<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body>${body}</body></html>`;

test.describe('inline-html', () => {
  test('replaces <link> and <script src> with inline content, preserving document order', () => {
    const out = inline(page('<script src="../shared/a.js"></script><script src="./b.js"></script>'), base());
    expect(out).toContain('CSS_MARK');
    expect(out.indexOf('A_MARK')).toBeGreaterThan(-1);
    expect(out.indexOf('B_MARK')).toBeGreaterThan(out.indexOf('A_MARK'));
    expect(out).toMatch(/<style[^>]*>[^]*CSS_MARK[^]*<\/style>/);
  });
  test('no src= or href= attributes remain', () => {
    const out = inline(page('<script src="../shared/a.js"></script><script src="./b.js"></script>'), base());
    expect(out).not.toMatch(/\ssrc\s*=/);
    expect(out).not.toMatch(/\shref\s*=/);
  });
  test('"</script" inside inlined JS is escaped so the page does not terminate early', () => {
    const out = inline(page('<script src="./evil.js"></script>'), base());
    expect(out).toContain('EVIL_MARK');
    const body = out.slice(out.indexOf('<script'));
    // exactly one real closing tag for the one script we inlined
    expect((body.match(/<\/script/gi) || []).length).toBe(1);
  });
  test('absolute / http(s) references make it throw (fails loudly)', () => {
    expect(() => inline(page('<script src="https://cdn.example.com/x.js"></script>'), base())).toThrow();
    expect(() => inline('<html><head><link rel="stylesheet" href="http://example.com/x.css"></head></html>', base())).toThrow();
  });
});
