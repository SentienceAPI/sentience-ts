/**
 * Snapshot functionality
 */

import { SentienceBrowser } from './browser';
import { Snapshot } from './types';

export interface SnapshotOptions {
  screenshot?: boolean | { format: 'png' | 'jpeg'; quality?: number };
  limit?: number;
  filter?: {
    min_area?: number;
    allowed_roles?: string[];
    min_z_index?: number;
  };
  license_key?: string;
}

export async function snapshot(
  browser: SentienceBrowser,
  options: SnapshotOptions = {}
): Promise<Snapshot> {
  const page = browser.getPage();

  // Build options object
  const opts: any = {};
  if (options.screenshot !== undefined) {
    opts.screenshot = options.screenshot;
  }
  if (options.limit !== undefined) {
    opts.limit = options.limit;
  }
  if (options.filter !== undefined) {
    opts.filter = options.filter;
  }
  if (options.license_key !== undefined) {
    opts.license_key = options.license_key;
  }

  // Call extension API
  const result = await page.evaluate((opts) => {
    return (window as any).sentience.snapshot(opts);
  }, opts);

  // Basic validation
  if (result.status !== 'success' && result.status !== 'error') {
    throw new Error(`Invalid snapshot status: ${result.status}`);
  }

  return result as Snapshot;
}

