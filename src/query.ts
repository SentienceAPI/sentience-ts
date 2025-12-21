/**
 * Query engine v1 - semantic selector matching
 */

import { Snapshot, Element, QuerySelector, QuerySelectorObject } from './types';

export function parseSelector(selector: string): QuerySelectorObject {
  const query: QuerySelectorObject = {};

  // Split by spaces (preserve quoted strings)
  const parts = selector.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const part of parts) {
    // Handle negation
    if (part.includes('!=')) {
      const [key, value] = part.split('!=', 2);
      const cleanKey = key.trim();
      const cleanValue = value.trim().replace(/^["']|["']$/g, '');

      if (cleanKey === 'role') {
        // For negation, we'll handle in matchElement
        (query as any).role_exclude = cleanValue;
      } else if (cleanKey === 'clickable') {
        query.clickable = false;
      }
      continue;
    }

    // Handle = (exact match)
    if (part.includes('=')) {
      const [key, value] = part.split('=', 2);
      const cleanKey = key.trim();
      const cleanValue = value.trim().replace(/^["']|["']$/g, '');

      if (cleanKey === 'role') {
        query.role = cleanValue;
      } else if (cleanKey === 'clickable') {
        query.clickable = cleanValue.toLowerCase() === 'true';
      } else if (cleanKey === 'name' || cleanKey === 'text') {
        query.text = cleanValue;
      }
      continue;
    }

    // Handle ~ (contains match)
    if (part.includes('~')) {
      const [key, value] = part.split('~', 2);
      const cleanKey = key.trim();
      const cleanValue = value.trim().replace(/^["']|["']$/g, '');

      if (cleanKey === 'text' || cleanKey === 'name') {
        (query as any).text_contains = cleanValue;
      }
      continue;
    }
  }

  return query;
}

function matchElement(element: Element, query: QuerySelectorObject & { role_exclude?: string; text_contains?: string }): boolean {
  // Role exact match
  if (query.role !== undefined) {
    if (element.role !== query.role) {
      return false;
    }
  }

  // Role exclusion
  if (query.role_exclude !== undefined) {
    if (element.role === query.role_exclude) {
      return false;
    }
  }

  // Clickable
  if (query.clickable !== undefined) {
    if (element.visual_cues.is_clickable !== query.clickable) {
      return false;
    }
  }

  // Text exact match
  if (query.text !== undefined) {
    if (!element.text || element.text !== query.text) {
      return false;
    }
  }

  // Text contains (case-insensitive)
  if (query.text_contains !== undefined) {
    if (!element.text) {
      return false;
    }
    if (!element.text.toLowerCase().includes(query.text_contains.toLowerCase())) {
      return false;
    }
  }

  return true;
}

export function query(snapshot: Snapshot, selector: QuerySelector): Element[] {
  // Parse selector if string
  const queryObj = typeof selector === 'string' ? parseSelector(selector) : selector;

  // Filter elements
  const matches = snapshot.elements.filter((el) => matchElement(el, queryObj));

  // Sort by importance (descending)
  matches.sort((a, b) => b.importance - a.importance);

  return matches;
}

export function find(snapshot: Snapshot, selector: QuerySelector): Element | null {
  const results = query(snapshot, selector);
  return results[0] || null;
}

