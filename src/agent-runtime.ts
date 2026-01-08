/**
 * Agent runtime for verification loop support.
 *
 * This module provides a thin runtime wrapper that combines:
 * 1. Browser session management
 * 2. Snapshot/query helpers
 * 3. Tracer for event emission
 * 4. Assertion/verification methods
 *
 * The AgentRuntime is designed to be used in agent verification loops where
 * you need to repeatedly take snapshots, execute actions, and verify results.
 *
 * @example
 * ```typescript
 * import { SentienceBrowser } from './browser';
 * import { AgentRuntime } from './agent-runtime';
 * import { urlMatches, exists } from './verification';
 * import { Tracer, JsonlTraceSink } from './tracing';
 *
 * const browser = await SentienceBrowser.create();
 * const page = await browser.newPage();
 * await page.goto("https://example.com");
 *
 * const sink = new JsonlTraceSink("trace.jsonl");
 * const tracer = new Tracer("test-run", sink);
 *
 * const runtime = new AgentRuntime(browser, page, tracer);
 *
 * // Take snapshot and run assertions
 * await runtime.snapshot();
 * runtime.assert(urlMatches(/example\.com/), "on_homepage");
 * runtime.assert(exists("role=button"), "has_buttons");
 *
 * // Check if task is done
 * if (runtime.assertDone(exists("text~'Success'"), "task_complete")) {
 *   console.log("Task completed!");
 * }
 * ```
 */

import { Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { Snapshot } from './types';
import { AssertContext, Predicate } from './verification';
import { Tracer } from './tracing/tracer';

// Define a minimal browser interface to avoid circular dependencies
interface BrowserLike {
  snapshot(page: Page, options?: Record<string, any>): Promise<Snapshot>;
}

/**
 * Assertion record for accumulation and step_end emission.
 */
export interface AssertionRecord {
  label: string;
  passed: boolean;
  required: boolean;
  reason: string;
  details: Record<string, any>;
}

/**
 * Runtime wrapper for agent verification loops.
 *
 * Provides ergonomic methods for:
 * - snapshot(): Take page snapshot
 * - assert(): Evaluate assertion predicates
 * - assertDone(): Assert task completion (required assertion)
 *
 * The runtime manages assertion state per step and emits verification events
 * to the tracer for Studio timeline display.
 */
export class AgentRuntime {
  /** Browser instance for taking snapshots */
  readonly browser: BrowserLike;
  /** Playwright Page for browser interaction */
  readonly page: Page;
  /** Tracer for event emission */
  readonly tracer: Tracer;

  /** Current step identifier */
  stepId: string | null = null;
  /** Current step index (0-based) */
  stepIndex: number = 0;
  /** Most recent snapshot (for assertion context) */
  lastSnapshot: Snapshot | null = null;

  /** Assertions accumulated during current step */
  private assertionsThisStep: AssertionRecord[] = [];
  /** Task completion tracking */
  private taskDone: boolean = false;
  private taskDoneLabel: string | null = null;

  /**
   * Create a new AgentRuntime.
   *
   * @param browser - Browser instance for taking snapshots
   * @param page - Playwright Page for browser interaction
   * @param tracer - Tracer for emitting verification events
   */
  constructor(browser: BrowserLike, page: Page, tracer: Tracer) {
    this.browser = browser;
    this.page = page;
    this.tracer = tracer;
  }

  /**
   * Build assertion context from current state.
   */
  private ctx(): AssertContext {
    let url: string | null = null;
    if (this.lastSnapshot) {
      url = this.lastSnapshot.url;
    } else if (this.page) {
      url = this.page.url();
    }

    return {
      snapshot: this.lastSnapshot,
      url,
      stepId: this.stepId,
    };
  }

  /**
   * Take a snapshot of the current page state.
   *
   * This updates lastSnapshot which is used as context for assertions.
   *
   * @param options - Options passed through to browser.snapshot()
   * @returns Snapshot of current page state
   */
  async snapshot(options?: Record<string, any>): Promise<Snapshot> {
    this.lastSnapshot = await this.browser.snapshot(this.page, options);
    return this.lastSnapshot;
  }

  /**
   * Begin a new step in the verification loop.
   *
   * This:
   * - Generates a new stepId
   * - Clears assertions from previous step
   * - Increments stepIndex (or uses provided value)
   *
   * @param goal - Description of what this step aims to achieve
   * @param stepIndex - Optional explicit step index (otherwise auto-increments)
   * @returns Generated stepId
   */
  beginStep(goal: string, stepIndex?: number): string {
    // Clear previous step state
    this.assertionsThisStep = [];

    // Generate new stepId
    this.stepId = uuidv4();

    // Update step index
    if (stepIndex !== undefined) {
      this.stepIndex = stepIndex;
    } else {
      this.stepIndex += 1;
    }

    return this.stepId;
  }

  /**
   * Evaluate an assertion against current snapshot state.
   *
   * The assertion result is:
   * 1. Accumulated for inclusion in step_end.data.verify.signals.assertions
   * 2. Emitted as a dedicated 'verification' event for Studio timeline
   *
   * @param predicate - Predicate function to evaluate
   * @param label - Human-readable label for this assertion
   * @param required - If true, this assertion gates step success (default: false)
   * @returns True if assertion passed, false otherwise
   */
  assert(predicate: Predicate, label: string, required: boolean = false): boolean {
    const outcome = predicate(this.ctx());

    const record: AssertionRecord = {
      label,
      passed: outcome.passed,
      required,
      reason: outcome.reason,
      details: outcome.details,
    };
    this.assertionsThisStep.push(record);

    // Emit dedicated verification event (Option B from design doc)
    // This makes assertions visible in Studio timeline
    this.tracer.emit(
      'verification',
      {
        kind: 'assert',
        passed: outcome.passed,
        label,
        required,
        reason: outcome.reason,
        details: outcome.details,
      },
      this.stepId || undefined
    );

    return outcome.passed;
  }

  /**
   * Assert task completion (required assertion).
   *
   * This is a convenience wrapper for assert() with required=true.
   * When the assertion passes, it marks the task as done.
   *
   * Use this for final verification that the agent's goal is complete.
   *
   * @param predicate - Predicate function to evaluate
   * @param label - Human-readable label for this assertion
   * @returns True if task is complete (assertion passed), false otherwise
   */
  assertDone(predicate: Predicate, label: string): boolean {
    const ok = this.assert(predicate, label, true);

    if (ok) {
      this.taskDone = true;
      this.taskDoneLabel = label;

      // Emit task_done verification event
      this.tracer.emit(
        'verification',
        {
          kind: 'task_done',
          passed: true,
          label,
        },
        this.stepId || undefined
      );
    }

    return ok;
  }

  /**
   * Get assertions data for inclusion in step_end.data.verify.signals.
   *
   * This is called when building the step_end event to include
   * assertion results in the trace.
   *
   * @returns Object with 'assertions', 'task_done', 'task_done_label' keys
   */
  getAssertionsForStepEnd(): {
    assertions: AssertionRecord[];
    task_done?: boolean;
    task_done_label?: string;
  } {
    const result: {
      assertions: AssertionRecord[];
      task_done?: boolean;
      task_done_label?: string;
    } = {
      assertions: [...this.assertionsThisStep],
    };

    if (this.taskDone) {
      result.task_done = true;
      result.task_done_label = this.taskDoneLabel || undefined;
    }

    return result;
  }

  /**
   * Get and clear assertions for current step.
   *
   * Call this at step end to get accumulated assertions
   * for the step_end event, then clear for next step.
   *
   * @returns List of assertion records from this step
   */
  flushAssertions(): AssertionRecord[] {
    const assertions = [...this.assertionsThisStep];
    this.assertionsThisStep = [];
    return assertions;
  }

  /**
   * Check if task has been marked as done via assertDone().
   */
  get isTaskDone(): boolean {
    return this.taskDone;
  }

  /**
   * Reset task_done state (for multi-task runs).
   */
  resetTaskDone(): void {
    this.taskDone = false;
    this.taskDoneLabel = null;
  }

  /**
   * Check if all assertions in current step passed.
   *
   * @returns True if all assertions passed (or no assertions made)
   */
  allAssertionsPassed(): boolean {
    return this.assertionsThisStep.every(a => a.passed);
  }

  /**
   * Check if all required assertions in current step passed.
   *
   * @returns True if all required assertions passed (or no required assertions)
   */
  requiredAssertionsPassed(): boolean {
    const required = this.assertionsThisStep.filter(a => a.required);
    return required.every(a => a.passed);
  }
}
