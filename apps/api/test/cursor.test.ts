import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ApiProblem } from '../src/lib/errors';
import { decodeCursor, encodeCursor, type CursorKind } from '../src/lib/cursor';

function cursorPayload(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function expectInvalid(operation: () => unknown): ApiProblem {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiProblem);
    const problem = error as ApiProblem;
    expect(problem.statusCode).toBe(422);
    expect(problem.code).toBe('invalid_request');
    return problem;
  }
  throw new Error('expected the cursor operation to fail, but it succeeded');
}

describe('opaque keyset cursors', () => {
  it('round-trips a message position', () => {
    const input = {
      kind: 'message' as const,
      scope: randomUUID(),
      timestamp: new Date('2026-11-04T12:34:56.789Z'),
      id: randomUUID(),
    };
    const encoded = encodeCursor(input);

    expect(encoded).not.toContain('=');
    expect(cursorPayload(encoded)).toMatchObject({
      v: 1,
      k: 'message',
      s: input.scope,
      t: '2026-11-04T12:34:56.789Z',
      i: input.id,
    });
    expect(decodeCursor(encoded, { kind: 'message', scope: input.scope })).toEqual({
      timestamp: input.timestamp,
      id: input.id,
    });
  });

  it('round-trips a conversation position', () => {
    const scope = randomUUID();
    const id = randomUUID();
    const encoded = encodeCursor({
      kind: 'conversation',
      scope,
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
      id,
    });

    expect(decodeCursor(encoded, { kind: 'conversation', scope })).toEqual({
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
      id,
    });
  });

  it('rejects malformed and versionless cursors', () => {
    expectInvalid(() => decodeCursor('not-a-cursor', { kind: 'message', scope: 's' }));
    expectInvalid(() => decodeCursor('', { kind: 'message', scope: 's' }));
    expectInvalid(() => decodeCursor(encodePayload({}), { kind: 'message', scope: 's' }));
    expectInvalid(() =>
      decodeCursor(
        encodePayload({ v: 2, k: 'message', s: 's', t: '2026-01-01T00:00:00.000Z', i: 'id' }),
        { kind: 'message', scope: 's' },
      ),
    );
    expectInvalid(() =>
      decodeCursor(encodePayload({ v: 1, k: 'message', s: 's', t: 'yesterday', i: 'id' }), {
        kind: 'message',
        scope: 's',
      }),
    );
    expectInvalid(() =>
      decodeCursor(
        encodePayload({ v: 1, k: 'message', s: 's', t: '2026-01-01T00:00:00.000Z', i: '' }),
        { kind: 'message', scope: 's' },
      ),
    );
    expectInvalid(() =>
      decodeCursor(encodePayload({ v: 1, k: 'message', s: 's', t: '2026-01-01T00:00:00.000Z' }), {
        kind: 'message',
        scope: 's',
      }),
    );
  });

  it('rejects a cursor for another kind or scope', () => {
    const encoded = encodeCursor({
      kind: 'message',
      scope: 'conversation-a',
      timestamp: new Date(),
      id: randomUUID(),
    });

    const wrongKind = expectInvalid(() =>
      decodeCursor(encoded, { kind: 'conversation' as CursorKind, scope: 'conversation-a' }),
    );
    expect(wrongKind.message).toMatch(/different list/);
    const wrongScope = expectInvalid(() =>
      decodeCursor(encoded, { kind: 'message', scope: 'conversation-b' }),
    );
    expect(wrongScope.message).toMatch(/different list/);
  });

  it('keeps accepting a legacy plain ISO timestamp for message pages only', () => {
    const legacy = '2026-11-03T09:08:07.654Z';
    expect(decodeCursor(legacy, { kind: 'message', scope: 'conversation-a' })).toEqual({
      timestamp: new Date(legacy),
      id: null,
    });

    expectInvalid(() => decodeCursor(legacy, { kind: 'conversation', scope: 'owner:owner-a' }));
  });

  it('rejects truncated or non-JSON base64url tampering', () => {
    const encoded = encodeCursor({
      kind: 'message',
      scope: 'conversation-a',
      timestamp: new Date('2026-11-04T00:00:00.000Z'),
      id: randomUUID(),
    });

    expectInvalid(() =>
      decodeCursor(encoded.slice(0, 12), { kind: 'message', scope: 'conversation-a' }),
    );
    expectInvalid(() =>
      decodeCursor(
        encodePayload({
          v: 1,
          k: 'message',
          s: 'attacker-scope',
          t: '2026-11-04T00:00:00.000Z',
          i: randomUUID(),
        }),
        { kind: 'message', scope: 'conversation-a' },
      ),
    );
    expectInvalid(() =>
      decodeCursor(Buffer.from('plain text, not json').toString('base64url'), {
        kind: 'message',
        scope: 'conversation-a',
      }),
    );
  });
});
