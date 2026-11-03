import { describe, expect, it } from 'vitest';

import {
  apiErrorResponseSchema,
  createMessageInputSchema,
  errorResponse,
  eventSeqSchema,
  healthDataSchema,
  healthResponseSchema,
  successResponse,
  uuidSchema,
  workspaceEventSchema,
} from '../src/index';

describe('API envelopes', () => {
  it('builds and parses a success envelope', () => {
    const body = successResponse({ ok: true }, 'req-1');

    expect(body).toEqual({ data: { ok: true }, requestId: 'req-1' });
  });

  it('builds and parses an error envelope', () => {
    const body = errorResponse('conflict', 'duplicate clientMessageId', false, 'req-2');

    expect(apiErrorResponseSchema.parse(body)).toEqual(body);
  });
});

describe('health contract', () => {
  it('accepts a valid health response', () => {
    const body = successResponse(
      {
        status: 'ok' as const,
        service: 'moyu-api' as const,
        version: '0.1.0',
        uptimeSeconds: 12,
        timestamp: '2026-11-03T08:00:00.000Z',
      },
      'req-3',
    );

    expect(healthResponseSchema.parse(body).data.service).toBe('moyu-api');
  });

  it('rejects a health payload without a version', () => {
    expect(() =>
      healthDataSchema.parse({
        status: 'ok',
        service: 'moyu-api',
        uptimeSeconds: 1,
        timestamp: '2026-11-03T08:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('message input contract', () => {
  it('accepts the minimal payload', () => {
    const input = createMessageInputSchema.parse({
      clientMessageId: 'client-1',
      text: 'hello',
    });

    expect(input.clientMessageId).toBe('client-1');
  });

  it('rejects blank text and oversized clientMessageId', () => {
    expect(() =>
      createMessageInputSchema.parse({ clientMessageId: 'client-1', text: '   ' }),
    ).toThrow();
    expect(() =>
      createMessageInputSchema.parse({ clientMessageId: 'x'.repeat(129), text: 'hello' }),
    ).toThrow();
  });
});

describe('event contract', () => {
  it('keeps seq as a decimal string', () => {
    expect(eventSeqSchema.parse('9007199254740993')).toBe('9007199254740993');
    expect(() => eventSeqSchema.parse('01')).toThrow();
    expect(() => eventSeqSchema.parse(1)).toThrow();
  });

  it('parses a workspace event', () => {
    const event = workspaceEventSchema.parse({
      id: 'event-1',
      seq: '42',
      type: 'message.created',
      occurredAt: '2026-11-03T08:00:00.000Z',
      data: { messageId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(event.seq).toBe('42');
  });
});

describe('ids', () => {
  it('rejects non-UUID identifiers', () => {
    expect(() => uuidSchema.parse('not-a-uuid')).toThrow();
  });
});
