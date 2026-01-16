/**
 * Backend-agnostic actions for browser-use integration.
 *
 * These actions work with any BrowserBackend implementation,
 * enabling Sentience grounding with browser-use or other frameworks.
 *
 * Usage with browser-use:
 *   import { BrowserUseAdapter } from './backends/browser-use-adapter';
 *   import { click, typeText, scroll } from './backends/actions';
 *
 *   const adapter = new BrowserUseAdapter(session);
 *   const backend = await adapter.createBackend();
 *
 *   // Take snapshot and click element
 *   const snap = await snapshot(backend);
 *   const element = find(snap, 'role=button[name="Submit"]');
 *   await click(backend, element.bbox);
 */

import type { ActionResult, BBox } from '../types';
import type { BrowserBackend, MouseButton } from './protocol';
import type { CursorPolicy } from '../cursor-policy';
import { buildHumanCursorPath } from '../cursor-policy';

const cursorPosByBackend: WeakMap<object, { x: number; y: number }> = new WeakMap();

async function humanMoveBackendIfEnabled(
  backend: BrowserBackend,
  target: { x: number; y: number },
  cursorPolicy?: CursorPolicy
): Promise<Record<string, any> | undefined> {
  if (!cursorPolicy || cursorPolicy.mode !== 'human') return undefined;
  const key = backend as unknown as object;
  const prev = cursorPosByBackend.get(key);
  const from = prev ? prev : { x: target.x, y: target.y };

  const meta = buildHumanCursorPath([from.x, from.y], [target.x, target.y], cursorPolicy);
  const pts = meta.path || [];
  const durationMs = meta.duration_ms || 0;
  const perStepMs = durationMs > 0 ? durationMs / Math.max(1, pts.length) : 0;
  for (const p of pts) {
    await backend.mouseMove(p.x, p.y);
    if (perStepMs > 0) await sleep(perStepMs);
  }
  if (meta.pause_before_click_ms > 0) await sleep(meta.pause_before_click_ms);

  cursorPosByBackend.set(key, { x: target.x, y: target.y });
  return meta as any;
}

/**
 * Target type for coordinate resolution.
 * Can be a BBox (clicks center), {x, y} object, or [x, y] tuple.
 */
export type ClickTarget =
  | BBox
  | { x: number; y: number; width?: number; height?: number }
  | [number, number];

/**
 * Scroll behavior for scrollToElement.
 */
export type ScrollBehavior = 'smooth' | 'instant' | 'auto';

/**
 * Vertical alignment for scrollToElement.
 */
export type ScrollBlock = 'start' | 'center' | 'end' | 'nearest';

/**
 * Resolve target to (x, y) coordinates.
 *
 * - BBox: Returns center point
 * - {x, y, width?, height?}: Returns center if width/height present, else x/y directly
 * - [x, y]: Returns as-is
 */
function resolveCoordinates(target: ClickTarget): [number, number] {
  if (Array.isArray(target)) {
    return target;
  }

  if ('width' in target && 'height' in target) {
    // BBox or object with dimensions - compute center
    const x = (target.x || 0) + (target.width || 0) / 2;
    const y = (target.y || 0) + (target.height || 0) / 2;
    return [x, y];
  }

  // Simple {x, y} object
  return [target.x || 0, target.y || 0];
}

/**
 * Helper to measure duration
 */
function measureDuration(startTime: number): number {
  return Math.floor(Date.now() - startTime);
}

/**
 * Helper to create successful ActionResult
 */
function successResult(durationMs: number): ActionResult {
  return {
    success: true,
    duration_ms: durationMs,
    outcome: 'dom_updated',
  };
}

/**
 * Helper to create error ActionResult
 */
function errorResult(durationMs: number, code: string, reason: string): ActionResult {
  return {
    success: false,
    duration_ms: durationMs,
    outcome: 'error',
    error: { code, reason },
  };
}

/**
 * Click at coordinates using the backend.
 *
 * @param backend - BrowserBackend implementation
 * @param target - Click target - BBox (clicks center), dict with x/y, or (x, y) tuple
 * @param button - Mouse button to click
 * @param clickCount - Number of clicks (1=single, 2=double)
 * @param moveFirst - Whether to move mouse to position before clicking
 * @returns ActionResult with success status
 *
 * @example
 *   // Click at coordinates
 *   await click(backend, [100, 200]);
 *
 *   // Click element bbox center
 *   await click(backend, element.bbox);
 *
 *   // Double-click
 *   await click(backend, element.bbox, 'left', 2);
 */
export async function click(
  backend: BrowserBackend,
  target: ClickTarget,
  button: MouseButton = 'left',
  clickCount: number = 1,
  moveFirst: boolean = true,
  cursorPolicy?: CursorPolicy
): Promise<ActionResult> {
  const startTime = Date.now();

  const [x, y] = resolveCoordinates(target);
  let cursorMeta: Record<string, any> | undefined;

  try {
    // Optional mouse move for hover effects
    if (moveFirst) {
      cursorMeta = await humanMoveBackendIfEnabled(backend, { x, y }, cursorPolicy);
      if (!cursorMeta) {
        await backend.mouseMove(x, y);
        await sleep(20); // Brief pause for hover
      }
    }

    // Perform click
    await backend.mouseClick(x, y, button, clickCount);

    return { ...successResult(measureDuration(startTime)), cursor: cursorMeta };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ...errorResult(measureDuration(startTime), 'click_failed', reason),
      cursor: cursorMeta,
    };
  }
}

/**
 * Type text, optionally clicking a target first.
 *
 * @param backend - BrowserBackend implementation
 * @param text - Text to type
 * @param target - Optional click target before typing (BBox, dict, or tuple)
 * @param clearFirst - If true, select all and delete before typing
 * @returns ActionResult with success status
 *
 * @example
 *   // Type into focused element
 *   await typeText(backend, 'Hello World');
 *
 *   // Click input then type
 *   await typeText(backend, 'search query', searchBox.bbox);
 *
 *   // Clear and type
 *   await typeText(backend, 'new value', input.bbox, true);
 */
export async function typeText(
  backend: BrowserBackend,
  text: string,
  target?: ClickTarget,
  clearFirst: boolean = false
): Promise<ActionResult> {
  const startTime = Date.now();

  try {
    // Click target if provided
    if (target !== undefined) {
      const [x, y] = resolveCoordinates(target);
      await backend.mouseClick(x, y);
      await sleep(50); // Wait for focus
    }

    // Clear existing content if requested
    if (clearFirst) {
      // Select all and delete
      await backend.eval("document.execCommand('selectAll')");
      await sleep(20);
    }

    // Type the text
    await backend.typeText(text);

    return successResult(measureDuration(startTime));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(measureDuration(startTime), 'type_failed', reason);
  }
}

/**
 * Scroll the page or element.
 *
 * @param backend - BrowserBackend implementation
 * @param deltaY - Scroll amount (positive=down, negative=up)
 * @param target - Optional position for scroll (defaults to viewport center)
 * @returns ActionResult with success status
 *
 * @example
 *   // Scroll down 300px
 *   await scroll(backend, 300);
 *
 *   // Scroll up 500px
 *   await scroll(backend, -500);
 *
 *   // Scroll at specific position
 *   await scroll(backend, 200, [500, 300]);
 */
export async function scroll(
  backend: BrowserBackend,
  deltaY: number = 300,
  target?: ClickTarget
): Promise<ActionResult> {
  const startTime = Date.now();

  try {
    let x: number | undefined;
    let y: number | undefined;

    if (target !== undefined) {
      [x, y] = resolveCoordinates(target);
    }

    await backend.wheel(deltaY, x, y);

    // Wait for scroll to settle
    await sleep(100);

    return successResult(measureDuration(startTime));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(measureDuration(startTime), 'scroll_failed', reason);
  }
}

/**
 * Scroll element into view using JavaScript scrollIntoView.
 *
 * @param backend - BrowserBackend implementation
 * @param elementId - Element ID from snapshot (requires sentience_registry)
 * @param behavior - Scroll behavior
 * @param block - Vertical alignment
 * @returns ActionResult with success status
 */
export async function scrollToElement(
  backend: BrowserBackend,
  elementId: number,
  behavior: ScrollBehavior = 'instant',
  block: ScrollBlock = 'center'
): Promise<ActionResult> {
  const startTime = Date.now();

  try {
    const scrolled = await backend.eval(`
      (() => {
        const el = window.sentience_registry && window.sentience_registry[${elementId}];
        if (el && el.scrollIntoView) {
          el.scrollIntoView({
            behavior: '${behavior}',
            block: '${block}',
            inline: 'nearest'
          });
          return true;
        }
        return false;
      })()
    `);

    // Wait for scroll animation
    const waitTime = behavior === 'smooth' ? 300 : 50;
    await sleep(waitTime);

    const durationMs = measureDuration(startTime);

    if (scrolled) {
      return successResult(durationMs);
    } else {
      return errorResult(durationMs, 'scroll_failed', 'Element not found in registry');
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(measureDuration(startTime), 'scroll_failed', reason);
  }
}

/**
 * Wait for page to reach stable state.
 *
 * @param backend - BrowserBackend implementation
 * @param state - Target document.readyState
 * @param timeoutMs - Maximum wait time
 * @returns ActionResult with success status
 */
export async function waitForStable(
  backend: BrowserBackend,
  state: 'interactive' | 'complete' = 'complete',
  timeoutMs: number = 10000
): Promise<ActionResult> {
  const startTime = Date.now();

  try {
    await backend.waitReadyState(state, timeoutMs);

    return successResult(measureDuration(startTime));
  } catch (e) {
    const durationMs = measureDuration(startTime);
    const reason = e instanceof Error ? e.message : String(e);

    // Check if it's a timeout error
    if (reason.includes('Timed out')) {
      return errorResult(durationMs, 'timeout', reason);
    }

    return errorResult(durationMs, 'wait_failed', reason);
  }
}

/**
 * Helper sleep function.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
