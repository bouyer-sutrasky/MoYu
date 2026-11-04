import { Buffer } from 'node:buffer';

import { ApiProblem } from './errors';

/**
 * Pagination cursors are opaque keyset positions. The encoding stays private so
 * the page boundary can carry both the sort timestamp and the row id that breaks
 * ties when several rows share a timestamp.
 */
export type CursorKind = 'message' | 'conversation';

export interface EncodeCursorInput {
  kind: CursorKind;
  /** The list the cursor belongs to (a conversation id, repository id or owner id). */
  scope: string;
  timestamp: Date;
  id: string;
}

export interface CursorPosition {
  timestamp: Date;
  /** Null only for a legacy plain-timestamp `before` cursor. */
  id: string | null;
}

/** The same position before the timestamp is narrowed to JavaScript milliseconds. */
export interface CursorValuePosition {
  timestamp: string;
  id: string | null;
}

export interface EncodeCursorValueInput {
  kind: CursorKind;
  scope: string;
  timestamp: string;
  id: string;
}

const CURSOR_VERSION = 1;

/**
 * ISO-8601 instants accepted as legacy cursors. Legacy clients sent the
 * timestamp of the oldest message they had seen instead of an opaque cursor.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function malformedCursor(): ApiProblem {
  return ApiProblem.invalid('Invalid pagination cursor');
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
    return null;
  }
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * Encodes a position while keeping the timestamp text exactly as the database
 * rendered it. PostgreSQL timestamps carry microseconds; narrowing to a `Date`
 * first would turn two messages in the same millisecond into non-matching
 * keyset boundaries and could skip the rest of their tie group.
 */
export function encodeCursorValue(input: EncodeCursorValueInput): string {
  const timestamp = isoTimestamp(input.timestamp);
  if (!timestamp) {
    throw new Error('Cursor timestamps must be ISO-8601 instants');
  }
  const payload = {
    v: CURSOR_VERSION,
    k: input.kind,
    s: input.scope,
    t: timestamp,
    i: input.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function encodeCursor(input: EncodeCursorInput): string {
  return encodeCursorValue({ ...input, timestamp: input.timestamp.toISOString() });
}

/**
 * Decodes one cursor and verifies it belongs to the requested kind and scope.
 * A cursor from another conversation, repository or owner is rejected instead
 * of being silently applied to the wrong list. Plain ISO timestamps remain valid
 * for legacy `before` message requests, with strict timestamp comparison.
 */
export function decodeCursorValue(
  value: string,
  expected: { kind: CursorKind; scope: string },
): CursorValuePosition {
  let decoded: string | null = null;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    decoded = null;
  }

  if (decoded !== null && decoded.length > 0) {
    let payload: unknown;
    try {
      payload = JSON.parse(decoded);
    } catch {
      payload = null;
    }
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (record.v !== CURSOR_VERSION) {
        throw malformedCursor();
      }
      if (record.k !== expected.kind) {
        throw ApiProblem.invalid('Pagination cursor belongs to a different list');
      }
      if (record.s !== expected.scope) {
        throw ApiProblem.invalid('Pagination cursor belongs to a different list');
      }
      const timestamp = isoTimestamp(record.t);
      if (!timestamp || typeof record.i !== 'string' || record.i.length === 0) {
        throw malformedCursor();
      }
      return { timestamp, id: record.i };
    }
  }

  if (expected.kind === 'message') {
    const timestamp = isoTimestamp(value);
    if (timestamp) {
      return { timestamp, id: null };
    }
  }

  throw malformedCursor();
}

export function decodeCursor(
  value: string,
  expected: { kind: CursorKind; scope: string },
): CursorPosition {
  const position = decodeCursorValue(value, expected);
  return { timestamp: new Date(position.timestamp), id: position.id };
}
