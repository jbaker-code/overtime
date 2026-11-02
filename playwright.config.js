// Playwright config for the Overtime acceptance suite (PLAN.md §5.1).
//
// Three projects:
//   unit        - pure Node. Shared modules (stopwatch / config-schema / format), the
//                 inliner, and static source assertions. No browser. Runs in the VM.
//   single-file - the BUILT single-file index.html in headless Chromium. Runs in the VM
//                 (uses the cached Playwright Chromium).
//   electron    - the real app via Playwright's _electron. HOST ONLY. Skips itself
//                 cleanly if EPISODE_TIMER_SKIP_ELECTRON=1 or Electron isn't installed.
//
// Handy:  npx playwright test --project=unit
//         npx playwright test --project=single-file
//         EPISODE_TIMER_SKIP_ELECTRON=1 npm test      (what the VM should use)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // Electron launches real windows; keep everything serial
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Builds the single-file page to <scratch>/test/index.html (never dirties dist/).
  globalSetup: require.resolve('./tests/helpers/global-setup.js'),
  projects: [
    { name: 'unit', testMatch: /.*\.unit\.spec\.js/ },
    {
      name: 'single-file',
      testMatch: /widget\.browser\.spec\.js/,
      use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 240, height: 130 } },
    },
    { name: 'electron', testMatch: /widget\.electron\.spec\.js/, timeout: 60_000 },
  ],
});
