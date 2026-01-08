/**
 * Snapshot comparison utilities for diff_status detection.
 * Implements change detection logic for the Diff Overlay feature.
 *
 * Uses shared canonicalization helpers from canonicalization.ts to ensure
 * consistent comparison behavior with tracing/indexer.ts.
 */

import { bboxChanged, contentChanged, ElementData } from './canonicalization';
import { Element, Snapshot } from './types';

/**
 * Convert Element to ElementData for canonicalization helpers.
 */
function elementToData(el: Element): ElementData {
  return {
    id: el.id,
    role: el.role,
    text: el.text,
    bbox: {
      x: el.bbox.x,
      y: el.bbox.y,
      width: el.bbox.width,
      height: el.bbox.height,
    },
    visual_cues: {
      is_primary: el.visual_cues.is_primary,
      is_clickable: el.visual_cues.is_clickable,
    },
  };
}

export class SnapshotDiff {
  /**
   * Compare current snapshot with previous and set diff_status on elements.
   *
   * Uses canonicalized comparisons:
   * - Text is normalized (trimmed, collapsed whitespace, lowercased)
   * - Bbox is rounded to 2px grid to ignore sub-pixel differences
   *
   * @param current - Current snapshot
   * @param previous - Previous snapshot (undefined if this is the first snapshot)
   * @returns List of elements with diff_status set (includes REMOVED elements from previous)
   */
  static computeDiffStatus(current: Snapshot, previous: Snapshot | undefined): Element[] {
    // If no previous snapshot, all current elements are ADDED
    if (!previous) {
      return current.elements.map(el => ({
        ...el,
        diff_status: 'ADDED' as const,
      }));
    }

    // Build lookup maps by element ID
    const currentById = new Map(current.elements.map(el => [el.id, el]));
    const previousById = new Map(previous.elements.map(el => [el.id, el]));

    const currentIds = new Set(currentById.keys());
    const previousIds = new Set(previousById.keys());

    const result: Element[] = [];

    // Process current elements
    for (const el of current.elements) {
      if (!previousIds.has(el.id)) {
        // Element is new - mark as ADDED
        result.push({
          ...el,
          diff_status: 'ADDED',
        });
      } else {
        // Element existed before - check for changes using canonicalized comparisons
        const prevEl = previousById.get(el.id)!;

        // Convert to ElementData for canonicalization helpers
        const elData = elementToData(el);
        const prevElData = elementToData(prevEl);

        const hasBboxChanged = bboxChanged(elData.bbox!, prevElData.bbox!);
        const hasContentChanged = contentChanged(elData, prevElData);

        if (hasBboxChanged && hasContentChanged) {
          // Both position and content changed - mark as MODIFIED
          result.push({
            ...el,
            diff_status: 'MODIFIED',
          });
        } else if (hasBboxChanged) {
          // Only position changed - mark as MOVED
          result.push({
            ...el,
            diff_status: 'MOVED',
          });
        } else if (hasContentChanged) {
          // Only content changed - mark as MODIFIED
          result.push({
            ...el,
            diff_status: 'MODIFIED',
          });
        } else {
          // No change - don't set diff_status (frontend expects undefined)
          result.push({
            ...el,
            diff_status: undefined,
          });
        }
      }
    }

    // Process removed elements (existed in previous but not in current)
    for (const prevId of previousIds) {
      if (!currentIds.has(prevId)) {
        const prevEl = previousById.get(prevId)!;
        result.push({
          ...prevEl,
          diff_status: 'REMOVED',
        });
      }
    }

    return result;
  }
}
