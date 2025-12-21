/**
 * Wait functionality
 */

import { SentienceBrowser } from './browser';
import { WaitResult, Element, QuerySelector } from './types';
import { snapshot } from './snapshot';
import { find } from './query';

export async function waitFor(
  browser: SentienceBrowser,
  selector: QuerySelector,
  timeout: number = 10000,
  interval: number = 250
): Promise<WaitResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Take snapshot
    const snap = await snapshot(browser);

    // Try to find element
    const element = find(snap, selector);

    if (element) {
      const durationMs = Date.now() - startTime;
      return {
        found: true,
        element,
        duration_ms: durationMs,
        timeout: false,
      };
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  // Timeout
  const durationMs = Date.now() - startTime;
  return {
    found: false,
    element: undefined,
    duration_ms: durationMs,
    timeout: true,
  };
}

