/**
 * Human-like cursor movement demo (TypeScript SDK).
 *
 * This example shows how to opt into human-like mouse movement before clicking,
 * and how to read the returned cursor metadata for tracing/debugging.
 */

import { CursorPolicy, SentienceBrowser, click, find, snapshot } from '../src';

async function main() {
  const browser = new SentienceBrowser();
  await browser.start();
  const page = browser.getPage();
  if (!page) throw new Error('Browser started but no page is available');

  try {
    await page.goto('https://example.com');
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    const snap = await snapshot(browser);
    const link = find(snap, 'role=link');
    if (!link) throw new Error('No link found on page');

    const policy: CursorPolicy = {
      mode: 'human',
      steps: 18,
      durationMs: 350,
      jitterPx: 1.2,
      overshootPx: 6.0,
      pauseBeforeClickMs: 30,
      seed: 123, // optional: deterministic for demos/tests
    };

    const result = await click(browser, link.id, true, false, policy);
    console.log('clicked:', result.success, 'outcome:', result.outcome);
    console.log('cursor meta:', result.cursor);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

