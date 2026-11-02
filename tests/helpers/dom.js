// Selectors + small helpers shared by the browser and Electron widget specs.
// Everything here is written against the FROZEN DOM contract (PLAN.md §2.5).

// The on-pill control cluster (#controls with #btn-play/pause/reset/settings) is restored
// for the BROWSER build only (no #btn-quit — can't quit a web page); in Electron it's in the
// DOM but CSS-hidden, with the tray + native right-click menu driving the timer. On the pill:
// the two readouts, the settings panel, the resize grip, and (browser) the control cluster.
const SEL = {
  app: '#app', face: '#face', clock: '#clock', time: '#clock-time', meridiem: '#clock-meridiem',
  stopwatch: '#stopwatch', separator: '#separator', panel: '#settings-panel', close: '#settings-close',
  grip: '#grip', controls: '#controls',
};

// Fixed fake "now" for every test: local 10:42:00 on the day of this project's Episode 2.
const START_ISO = '2026-10-31T10:42:00';
const START_MS = new Date(START_ISO).getTime();
// Ticks are aligned to second boundaries (+5 ms, PLAN §2.6), so every advance gets a little
// slack to land just past the tick we're aiming at.
const SLACK = 50;

/** Freeze the fake clock at START+1s (after the page has loaded under page.clock.install). */
async function freezeClock(page) {
  // Reset to the base instant FIRST. Between clock.install({time: START_MS}) and
  // here, real wall-time elapses (page load, and a real Electron window boot can
  // take >1s under load), advancing the fake clock past START_MS+1000 — then
  // pauseAt(+1s) throws "Cannot fast-forward to the past" and flakes the suite.
  // setSystemTime can move the clock backward (pauseAt only forward), so rewinding
  // to START_MS makes the +1s pause target always reachable. End state is identical
  // to a fast boot: paused at START_MS+1000.
  await page.clock.setSystemTime(new Date(START_MS));
  await page.clock.pauseAt(new Date(START_MS + 1000));
}

/** Advance fake time by `ms` (+SLACK) so second-aligned ticks have fired. */
async function advance(page, ms) {
  await page.clock.runFor(ms + SLACK);
}

/** Put the mouse over the widget so data-hover flips true (reveals the grip, and
 *  paints the pill 50% black). */
async function hover(page) {
  await page.hover(SEL.app);
  await page.waitForFunction(() => document.querySelector('#app').dataset.hover === 'true');
}

/**
 * Drive the widget the way the Electron tray / right-click menu does, now that the
 * on-pill control buttons are gone. Both route through the renderer's command path;
 * the read/write debug hook (window.__episodeTimer) exposes exactly that path, and
 * it exists in BOTH the browser and Electron builds, so this is environment-agnostic.
 *   press(page, 'play' | 'pause' | 'reset')  -> runs the stopwatch transition
 *   press(page, 'settings')                  -> opens the settings panel
 */
async function press(page, name) {
  if (name === 'settings') {
    await page.evaluate(() => window.__episodeTimer.openSettings());
    return;
  }
  await page.evaluate((a) => window.__episodeTimer.command(a), name);
}

const fontSizePx = (page, sel = SEL.time) =>
  page.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize), sel);

module.exports = { SEL, START_ISO, START_MS, SLACK, freezeClock, advance, hover, press, fontSizePx };
