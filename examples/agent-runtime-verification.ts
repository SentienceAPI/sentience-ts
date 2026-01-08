/**
 * Example: Agent Runtime with Verification Loop
 *
 * Demonstrates how to use AgentRuntime for runtime verification in agent loops.
 * The AgentRuntime provides assertion predicates to verify browser state during execution.
 *
 * Key features:
 * - Predicate helpers: urlMatches, urlContains, exists, notExists, elementCount
 * - Combinators: allOf, anyOf for complex conditions
 * - Task completion: assertDone() for goal verification
 * - Trace integration: Assertions emitted to trace for Studio timeline
 *
 * Requirements:
 * - SENTIENCE_API_KEY (Pro or Enterprise tier)
 *
 * Usage:
 *   ts-node examples/agent-runtime-verification.ts
 *   or
 *   npm run example:agent-runtime
 */

import { Page } from 'playwright';
import { SentienceBrowser } from '../src/browser';
import { Snapshot } from '../src/types';
import {
  AgentRuntime,
  urlContains,
  urlMatches,
  exists,
  notExists,
  allOf,
} from '../src';
import { createTracer } from '../src/tracing/tracer-factory';

/**
 * Adapter to make SentienceBrowser compatible with AgentRuntime's BrowserLike interface.
 * AgentRuntime expects snapshot(page, options) but SentienceBrowser has snapshot(options).
 */
function createBrowserAdapter(browser: SentienceBrowser) {
  return {
    snapshot: async (_page: Page, options?: Record<string, any>): Promise<Snapshot> => {
      return await browser.snapshot(options);
    },
  };
}

async function main() {
  // Get API key from environment
  const sentienceKey = process.env.SENTIENCE_API_KEY;

  if (!sentienceKey) {
    console.error('Error: SENTIENCE_API_KEY not set');
    process.exit(1);
  }

  console.log('Starting Agent Runtime Verification Demo\n');

  // 1. Create tracer for verification event emission
  const runId = 'verification-demo';
  const tracer = await createTracer({
    apiKey: sentienceKey,
    runId: runId,
    uploadTrace: false,
  });
  console.log(`Run ID: ${runId}\n`);

  // 2. Create and start browser
  const browser = new SentienceBrowser(sentienceKey, undefined, false);
  await browser.start();
  const page = browser.getPage();

  try {
    // 3. Create AgentRuntime with browser adapter, page, and tracer
    const browserAdapter = createBrowserAdapter(browser);
    const runtime = new AgentRuntime(browserAdapter, page, tracer);

    // 4. Navigate to a page
    console.log('Navigating to example.com...\n');
    await page.goto('https://example.com');
    await page.waitForLoadState('networkidle');

    // Wait for extension to inject
    try {
      await page.waitForFunction(
        () => typeof (window as any).sentience !== 'undefined',
        { timeout: 10000 }
      );
    } catch {
      console.warn('Extension not ready, continuing anyway...');
    }

    // 5. Begin a verification step
    runtime.beginStep('Verify page loaded correctly');

    // 6. Take a snapshot (required for element assertions)
    const snapshot = await runtime.snapshot();
    console.log(`Snapshot taken: ${snapshot.elements.length} elements found\n`);

    // 7. Run assertions against current state
    console.log('Running assertions:\n');

    // URL assertions
    const urlOk = runtime.assert(urlContains('example.com'), 'on_example_domain');
    console.log(`  [${urlOk ? 'PASS' : 'FAIL'}] on_example_domain`);

    const urlMatch = runtime.assert(urlMatches(/https:\/\/.*example\.com/), 'url_is_https');
    console.log(`  [${urlMatch ? 'PASS' : 'FAIL'}] url_is_https`);

    // Element assertions
    const hasHeading = runtime.assert(exists('role=heading'), 'has_heading');
    console.log(`  [${hasHeading ? 'PASS' : 'FAIL'}] has_heading`);

    const noError = runtime.assert(notExists("text~'Error'"), 'no_error_message');
    console.log(`  [${noError ? 'PASS' : 'FAIL'}] no_error_message`);

    // Combined assertion with allOf
    const pageReady = runtime.assert(
      allOf(urlContains('example'), exists('role=link')),
      'page_fully_ready'
    );
    console.log(`  [${pageReady ? 'PASS' : 'FAIL'}] page_fully_ready`);

    // 8. Check if task is done (required assertion)
    const taskComplete = runtime.assertDone(
      exists("text~'Example Domain'"),
      'reached_example_page'
    );
    console.log(`\n  [${taskComplete ? 'DONE' : 'NOT DONE'}] reached_example_page`);

    // 9. Get accumulated assertions for step_end event
    const assertionsData = runtime.getAssertionsForStepEnd();
    console.log(`\nTotal assertions: ${assertionsData.assertions.length}`);
    console.log(`Task done: ${assertionsData.task_done ?? false}`);

    // 10. Check overall status
    console.log('\nVerification Summary:');
    console.log(`  All passed: ${runtime.allAssertionsPassed()}`);
    console.log(`  Required passed: ${runtime.requiredAssertionsPassed()}`);
    console.log(`  Task complete: ${runtime.isTaskDone}`);

  } catch (error: any) {
    console.error(`\nError during execution: ${error.message}`);
    throw error;
  } finally {
    // Close tracer and browser
    console.log('\nClosing tracer...');
    await tracer.close(true);
    console.log(`Trace saved to: ~/.sentience/traces/${runId}.jsonl`);

    await browser.close();
    console.log('Done!');
  }
}

main().catch(console.error);
