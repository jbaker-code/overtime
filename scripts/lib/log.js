'use strict';
/** log.js — tiny coloured step/ok/warn/fail logger. No deps. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

module.exports = {
  step: (m) => console.log(c(36, '==> ') + m),
  info: (m) => console.log('    ' + m),
  ok: (m) => console.log(c(32, ' ok ') + m),
  warn: (m) => console.warn(c(33, 'warn ') + m),
  fail: (m) => console.error(c(31, 'FAIL ') + m),
  /** Human-readable file size. */
  size(bytes) {
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  /** Run an async main() and exit non-zero with a clear message on failure. */
  run(main) {
    Promise.resolve().then(main).catch((e) => {
      console.error(c(31, 'FAIL ') + (e && e.message ? e.message : e));
      if (process.env.DEBUG) console.error(e && e.stack);
      process.exit(1);
    });
  },
};
