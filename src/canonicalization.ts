/**
 * Shared canonicalization utilities for snapshot comparison and indexing.
 *
 * This module provides consistent normalization functions used by both:
 * - tracing/indexer.ts (for computing stable digests)
 * - snapshot-diff.ts (for computing diff_status labels)
 *
 * By sharing these helpers, we ensure consistent behavior:
 * - Same text normalization (whitespace, case, length)
 * - Same bbox rounding (2px precision)
 * - Same change detection thresholds
 */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualCues {
  is_primary?: boolean;
  is_clickable?: boolean;
}

export interface ElementData {
  id?: number;
  role?: string;
  text?: string | null;
  bbox?: BBox;
  visual_cues?: VisualCues;
  is_primary?: boolean;
  is_clickable?: boolean;
}

export interface CanonicalElement {
  id: number | undefined;
  role: string;
  text_norm: string;
  bbox: BBox;
  is_primary: boolean;
  is_clickable: boolean;
}

/**
 * Normalize text for canonical comparison.
 *
 * Transforms:
 * - Trims leading/trailing whitespace
 * - Collapses internal whitespace to single spaces
 * - Lowercases
 * - Caps length
 *
 * @param text - Input text (may be undefined/null)
 * @param maxLen - Maximum length to retain (default: 80)
 * @returns Normalized text string (empty string if input is falsy)
 *
 * @example
 * normalizeText("  Hello   World  ") // "hello world"
 * normalizeText(undefined) // ""
 */
export function normalizeText(text: string | undefined | null, maxLen: number = 80): string {
  if (!text) return '';

  // Trim and collapse whitespace
  let normalized = text.split(/\s+/).join(' ').trim();

  // Lowercase
  normalized = normalized.toLowerCase();

  // Cap length
  if (normalized.length > maxLen) {
    normalized = normalized.substring(0, maxLen);
  }

  return normalized;
}

/**
 * Round bbox coordinates to reduce noise.
 *
 * Snaps coordinates to grid of `precision` pixels to ignore
 * sub-pixel rendering differences.
 *
 * @param bbox - Bounding box with x, y, width, height
 * @param precision - Grid size in pixels (default: 2)
 * @returns Rounded bbox with integer coordinates
 *
 * @example
 * roundBBox({x: 101, y: 203, width: 50, height: 25})
 * // {x: 100, y: 202, width: 50, height: 24}
 */
export function roundBBox(bbox: Partial<BBox>, precision: number = 2): BBox {
  return {
    x: Math.round((bbox.x || 0) / precision) * precision,
    y: Math.round((bbox.y || 0) / precision) * precision,
    width: Math.round((bbox.width || 0) / precision) * precision,
    height: Math.round((bbox.height || 0) / precision) * precision,
  };
}

/**
 * Check if two bboxes are equal after rounding.
 *
 * @param bbox1 - First bounding box
 * @param bbox2 - Second bounding box
 * @param precision - Grid size for rounding (default: 2)
 * @returns True if bboxes are equal after rounding
 */
export function bboxEqual(
  bbox1: Partial<BBox>,
  bbox2: Partial<BBox>,
  precision: number = 2
): boolean {
  const r1 = roundBBox(bbox1, precision);
  const r2 = roundBBox(bbox2, precision);
  return r1.x === r2.x && r1.y === r2.y && r1.width === r2.width && r1.height === r2.height;
}

/**
 * Check if two bboxes differ after rounding.
 *
 * This is the inverse of bboxEqual, provided for semantic clarity
 * in diff detection code.
 *
 * @param bbox1 - First bounding box
 * @param bbox2 - Second bounding box
 * @param precision - Grid size for rounding (default: 2)
 * @returns True if bboxes differ after rounding
 */
export function bboxChanged(
  bbox1: Partial<BBox>,
  bbox2: Partial<BBox>,
  precision: number = 2
): boolean {
  return !bboxEqual(bbox1, bbox2, precision);
}

/**
 * Create canonical representation of an element for comparison/hashing.
 *
 * Extracts and normalizes the fields that matter for identity:
 * - id, role, normalized text, rounded bbox
 * - is_primary, is_clickable from visual_cues
 *
 * @param elem - Raw element object
 * @returns Canonical element object with normalized fields
 */
export function canonicalizeElement(elem: ElementData): CanonicalElement {
  // Extract is_primary and is_clickable from visual_cues if present
  const visualCues = elem.visual_cues || {};
  const isPrimary =
    typeof visualCues === 'object' && visualCues !== null
      ? visualCues.is_primary || false
      : elem.is_primary || false;
  const isClickable =
    typeof visualCues === 'object' && visualCues !== null
      ? visualCues.is_clickable || false
      : elem.is_clickable || false;

  return {
    id: elem.id,
    role: elem.role || '',
    text_norm: normalizeText(elem.text),
    bbox: roundBBox(elem.bbox || { x: 0, y: 0, width: 0, height: 0 }),
    is_primary: isPrimary,
    is_clickable: isClickable,
  };
}

/**
 * Check if two elements have equal content (ignoring position).
 *
 * Compares normalized text, role, and visual cues.
 *
 * @param elem1 - First element (raw or canonical)
 * @param elem2 - Second element (raw or canonical)
 * @returns True if content is equal after normalization
 */
export function contentEqual(elem1: ElementData, elem2: ElementData): boolean {
  // Normalize both elements
  const c1 = canonicalizeElement(elem1);
  const c2 = canonicalizeElement(elem2);

  return (
    c1.role === c2.role &&
    c1.text_norm === c2.text_norm &&
    c1.is_primary === c2.is_primary &&
    c1.is_clickable === c2.is_clickable
  );
}

/**
 * Check if two elements have different content (ignoring position).
 *
 * This is the inverse of contentEqual, provided for semantic clarity
 * in diff detection code.
 *
 * @param elem1 - First element
 * @param elem2 - Second element
 * @returns True if content differs after normalization
 */
export function contentChanged(elem1: ElementData, elem2: ElementData): boolean {
  return !contentEqual(elem1, elem2);
}
