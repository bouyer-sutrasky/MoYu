import { describe, expect, it } from 'vitest';

import {
  apiErrorResponseSchema,
  authMeDataSchema,
  authStateDataSchema,
  bootstrapExchangeInputSchema,
  ceremonyOptionsSchema,
  createMessageInputSchema,
  errorResponse,
  eventSeqSchema,
  healthDataSchema,
  healthResponseSchema,
  repositoryListDataSchema,
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
      data: {
        messageId: '00000000-0000-4000-8000-000000000000',
        direction: 'inbound',
      },
    });

    expect(event.seq).toBe('42');
  });
});

describe('ids', () => {
  it('rejects non-UUID identifiers', () => {
    expect(() => uuidSchema.parse('not-a-uuid')).toThrow();
  });
});

describe('M2 authentication contracts', () => {
  it('parses auth state and session summaries', () => {
    const state = authStateDataSchema.parse({
      initialized: true,
      activeCredentialCount: 1,
      setupOpen: false,
      recoveryOpen: false,
      rpId: 'moyu.sutrasky.com',
      origin: 'https://moyu.sutrasky.com',
    });
    expect(state.setupOpen).toBe(false);

    const me = authMeDataSchema.parse({
      owner: { id: '00000000-0000-4000-8000-000000000001', displayName: 'MoYu Owner' },
      session: {
        id: '00000000-0000-4000-8000-000000000002',
        userAgent: null,
        createdAt: '2026-11-03T08:00:00.000Z',
        lastUsedAt: '2026-11-03T08:00:00.000Z',
        expiresAt: '2027-02-01T08:00:00.000Z',
        current: true,
      },
      credentials: [],
    });
    expect(me.session.current).toBe(true);
  });

  it('requires a sufficiently long binding code', () => {
    expect(() => bootstrapExchangeInputSchema.parse({ code: 'short' })).toThrow();
    expect(() => bootstrapExchangeInputSchema.parse({ code: 'ABCD-EFGH-JKMN' })).not.toThrow();
  });

  it('parses a ceremony envelope without fixing the WebAuthn options shape', () => {
    const ceremony = ceremonyOptionsSchema.parse({
      ceremonyId: '00000000-0000-4000-8000-000000000003',
      optionsJSON: { challenge: 'abc', rp: { id: 'moyu.sutrasky.com' } },
    });
    expect(ceremony.optionsJSON.challenge).toBe('abc');
  });

  it('parses the read-only repository inventory', () => {
    const list = repositoryListDataSchema.parse({
      repositories: [
        {
          id: '00000000-0000-4000-8000-000000000004',
          fullName: 'bouyer-sutrasky/MoYu',
          githubRepositoryId: 123,
          defaultBranch: 'main',
          status: 'provisioning',
          createdAt: '2026-11-03T08:00:00.000Z',
          updatedAt: '2026-11-03T08:00:00.000Z',
        },
      ],
    });
    expect(list.repositories[0]?.status).toBe('provisioning');
  });
});
