import { z } from 'zod';

export const uuidSchema = z.uuid();

/**
 * ISO-8601 timestamps are exchanged as UTC strings. Parsing is intentionally
 * permissive about the offset so tests and clients can send `Z` or `+00:00`.
 */
export const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 timestamp',
});

/**
 * Event sequence numbers are exchanged as decimal strings to avoid the
 * JavaScript integer precision limit.
 */
export const eventSeqSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, {
  message: 'must be a decimal string without leading zeros',
});

/**
 * An opaque keyset-pagination cursor. Clients pass a server-returned cursor
 * back unchanged; the encoding is deliberately not public so a timestamp
 * alone never has to identify a page boundary when rows share it.
 */
export const pageCursorSchema = z.string().min(1).max(512);
