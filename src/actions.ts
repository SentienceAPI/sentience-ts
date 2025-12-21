/**
 * Actions v1 - click, type, press
 */

import { SentienceBrowser } from './browser';
import { ActionResult, Snapshot } from './types';
import { snapshot } from './snapshot';

export async function click(
  browser: SentienceBrowser,
  elementId: number,
  takeSnapshot: boolean = false
): Promise<ActionResult> {
  const page = browser.getPage();
  const startTime = Date.now();
  const urlBefore = page.url();

  // Call extension click method
  const success = await page.evaluate((id) => {
    return (window as any).sentience.click(id);
  }, elementId);

  // Wait a bit for navigation/DOM updates
  await page.waitForTimeout(500);

  const durationMs = Date.now() - startTime;
  const urlAfter = page.url();
  const urlChanged = urlBefore !== urlAfter;

  // Determine outcome
  let outcome: 'navigated' | 'dom_updated' | 'no_change' | 'error' | undefined;
  if (urlChanged) {
    outcome = 'navigated';
  } else if (success) {
    outcome = 'dom_updated';
  } else {
    outcome = 'error';
  }

  // Optional snapshot after
  let snapshotAfter: Snapshot | undefined;
  if (takeSnapshot) {
    snapshotAfter = await snapshot(browser);
  }

  return {
    success,
    duration_ms: durationMs,
    outcome,
    url_changed: urlChanged,
    snapshot_after: snapshotAfter,
    error: success
      ? undefined
      : { code: 'click_failed', reason: 'Element not found or not clickable' },
  };
}

export async function typeText(
  browser: SentienceBrowser,
  elementId: number,
  text: string,
  takeSnapshot: boolean = false
): Promise<ActionResult> {
  const page = browser.getPage();
  const startTime = Date.now();
  const urlBefore = page.url();

  // Focus element first
  const focused = await page.evaluate((id) => {
    const el = (window as any).sentience_registry[id];
    if (el) {
      el.focus();
      return true;
    }
    return false;
  }, elementId);

  if (!focused) {
    return {
      success: false,
      duration_ms: Date.now() - startTime,
      outcome: 'error',
      error: { code: 'focus_failed', reason: 'Element not found' },
    };
  }

  // Type using Playwright keyboard
  await page.keyboard.type(text);

  const durationMs = Date.now() - startTime;
  const urlAfter = page.url();
  const urlChanged = urlBefore !== urlAfter;

  const outcome = urlChanged ? 'navigated' : 'dom_updated';

  let snapshotAfter: Snapshot | undefined;
  if (takeSnapshot) {
    snapshotAfter = await snapshot(browser);
  }

  return {
    success: true,
    duration_ms: durationMs,
    outcome,
    url_changed: urlChanged,
    snapshot_after: snapshotAfter,
  };
}

export async function press(
  browser: SentienceBrowser,
  key: string,
  takeSnapshot: boolean = false
): Promise<ActionResult> {
  const page = browser.getPage();
  const startTime = Date.now();
  const urlBefore = page.url();

  // Press key using Playwright
  await page.keyboard.press(key);

  // Wait a bit for navigation/DOM updates
  await page.waitForTimeout(500);

  const durationMs = Date.now() - startTime;
  const urlAfter = page.url();
  const urlChanged = urlBefore !== urlAfter;

  const outcome = urlChanged ? 'navigated' : 'dom_updated';

  let snapshotAfter: Snapshot | undefined;
  if (takeSnapshot) {
    snapshotAfter = await snapshot(browser);
  }

  return {
    success: true,
    duration_ms: durationMs,
    outcome,
    url_changed: urlChanged,
    snapshot_after: snapshotAfter,
  };
}

