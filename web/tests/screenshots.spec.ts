import { test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Capture the images the README and the submission use.
 *
 * Separate from `viewports.spec.ts` because that suite asserts and this one
 * produces artefacts. Keeping them apart means a failing assertion never
 * leaves a half-written screenshot in `docs/`, and regenerating the images
 * never requires running the whole verification pass.
 *
 *   npx playwright test screenshots.spec.ts
 */

const OUT = '../docs/screenshots';

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // Trigger every reveal, then return to the top so the capture starts from a
  // settled page rather than mid-fade.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 500));
  });
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

/**
 * The banner.
 *
 * The hero at laptop width, cropped to the fold. This is the first thing a
 * judge sees in the repository, so it is the headline, the pitch and the token
 * and nothing below them.
 */
test('banner', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto('/');
  await settle(page);
  await page.screenshot({ path: `${OUT}/banner.png` });
});

/** The product shot: the ledger, with the in-flight row glowing. */
test('the circle', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await settle(page);
  const ledger = page.getByTestId('ledger');
  await ledger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await ledger.screenshot({ path: `${OUT}/circle.png` });
});

/**
 * The resolution moment.
 *
 * Captured before and after tapping the in-flight row, because the transition
 * is the product's signature and a single still cannot carry it.
 */
test('resolution', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await settle(page);

  const ledger = page.getByTestId('ledger');
  await ledger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await ledger.screenshot({ path: `${OUT}/recovering.png` });

  await page.getByTestId('row-inflight').click();
  // Past the 400ms resolution transition, so the mark has landed.
  await page.waitForTimeout(900);
  await ledger.screenshot({ path: `${OUT}/resolve.png` });
});

/** The proof page, which is the page for a reader who does not believe us. */
test('proof', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/proof');
  await settle(page);
  await page.screenshot({ path: `${OUT}/pay.png` });
  await page.screenshot({ path: `${OUT}/proof-full.png`, fullPage: true });
});

/** Phone width, for the mobile-first claim. */
test('mobile', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/');
  await settle(page);
  await page.screenshot({ path: `${OUT}/mobile-hero.png` });
  const ledger = page.getByTestId('ledger');
  await ledger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mobile-circle.png` });
});

/** Dark mode, because the brief requires it and judges toggle things. */
test('dark mode', async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/');
  await settle(page);
  await page.screenshot({ path: `${OUT}/dark-hero.png` });
  await context.close();
});

/** The resolution diagram, for review and for the README. */
test('diagram', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await settle(page);
  const section = page.locator('#how');
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await section.screenshot({ path: `${OUT}/diagram.png` });
});

/** The proof section, where the campaign table and experiments sit. */
test('campaign section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await settle(page);
  const section = page.locator('#proof');
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await section.screenshot({ path: `${OUT}/campaign.png` });
});

/** The judge demo: the app's own screens, driven by a scripted walkthrough. */
test('judge demo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await settle(page);
  const section = page.locator('#demo');
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await section.screenshot({ path: `${OUT}/demo.png` });

  // Step to the moment the phone dies, which is the frame that matters.
  await page.getByRole('button', { name: /Android kills the app/i }).click();
  await page.waitForTimeout(700);
  await section.screenshot({ path: `${OUT}/demo-killed.png` });
});
