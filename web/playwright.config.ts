import { defineConfig, devices } from '@playwright/test';

/**
 * Viewport and behaviour verification for the landing page and the proof page.
 *
 * The suite asserts the things the design brief makes non-negotiable, on every
 * route at every size: no horizontal scroll, no overlapping elements, every
 * font actually loaded, no console errors, and contrast meeting WCAG AA.
 *
 * It runs against a production build rather than the dev server, because the
 * dev server injects an overlay and development-only warnings that would make
 * the console assertions meaningless.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The fonts are served from the app itself, so a slow first paint is a
    // real failure rather than a flake to be waited out.
    actionTimeout: 10_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  /*
   * Tested against a production build, not the dev server.
   *
   * Two reasons. The dev server injects an overlay and development-only
   * warnings that would make the console assertions meaningless. And Next 15's
   * dev mode cannot resolve some of its own webpack loaders under pnpm's
   * isolated layout, while the production build is unaffected — so this is
   * also the only mode that runs here.
   */
  webServer: {
    command: 'pnpm run build && pnpm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
