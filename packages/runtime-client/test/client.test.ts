import { describe, expect, it } from 'vitest';

import {
  RuntimeBridgeClient,
  RuntimeBridgeError,
  decodeModelId,
  encodeModelId,
} from '../src/index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('model identity encoding', () => {
  it('round-trips provider and model names that contain slashes', () => {
    const encoded = encodeModelId({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
    });
    expect(encoded).toBe('commandcode/deepseek/deepseek-v4.1-flash');
    expect(decodeModelId(encoded)).toEqual({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
    });
  });

  it('rejects malformed identities', () => {
    expect(decodeModelId(null)).toBeNull();
    expect(decodeModelId('no-slash')).toBeNull();
    expect(decodeModelId('/model')).toBeNull();
    expect(decodeModelId('provider/')).toBeNull();
  });
});

describe('runtime Bridge client', () => {
  it('sends the machine bearer token and validates the shared schema', async () => {
    let seenAuthorization = '';
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190/',
      token: 'machine-token-0123456789',
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seenAuthorization = String(new Headers(init?.headers).get('authorization'));
        return jsonResponse({
          result: 'stored',
          triggerId: 'workspace:message-1',
          baseCommit: 'a'.repeat(40),
          ticketId: null,
        });
      }) as typeof fetch,
    });

    const result = await client.trigger({
      triggerId: 'workspace:message-1',
      conversationId: '00000000-0000-4000-8000-000000000001',
      messageId: '00000000-0000-4000-8000-000000000002',
      replyToMessageId: null,
      actor: { id: 'owner-1' },
      text: 'Fix the typo',
      at: '2026-11-03T12:00:00.000Z',
      executionSpec: {
        repository: 'Bouyer12/m3-loop-final-68fa5d90',
        baseBranch: 'main',
        baseCommit: null,
        model: null,
        mode: 'execute',
      },
    });

    expect(seenAuthorization).toBe('Bearer machine-token-0123456789');
    expect(result.result).toBe('stored');
    expect(result.baseCommit).toBe('a'.repeat(40));
  });

  it('maps a non-retryable 422 to a RuntimeBridgeError', async () => {
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190',
      token: 'machine-token-0123456789',
      fetchImpl: (async () =>
        jsonResponse(
          { error: { code: 'invalid_model', message: 'model unavailable', retryable: false } },
          422,
        )) as typeof fetch,
    });

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeBridgeError);
    expect((error as RuntimeBridgeError).status).toBe(422);
    expect((error as RuntimeBridgeError).retryable).toBe(false);
    expect((error as RuntimeBridgeError).message).toBe('model unavailable');
  });

  it('treats a transport failure as retryable', async () => {
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190',
      token: 'machine-token-0123456789',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });

    const error = await client.events(0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeBridgeError);
    expect((error as RuntimeBridgeError).retryable).toBe(true);
  });
});

describe('M4 execution-control calls', () => {
  const accepted = {
    operationId: 'op-1',
    ticketId: 'ticket-1',
    kind: 'pause',
    state: 'queued',
  };

  it('sends pause, start, resume and retry to their ticket routes with the shared body', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190',
      token: 'machine-token-0123456789',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse(accepted, 202);
      }) as typeof fetch,
    });

    await expect(
      client.pause('ticket-1', { operationId: 'op-1', reason: 'owner stop' }),
    ).resolves.toMatchObject({ operationId: 'op-1' });
    await expect(
      client.start('ticket-1', { operationId: 'op-1', planRevision: 2 }),
    ).resolves.toMatchObject({ operationId: 'op-1' });
    await expect(
      client.resume('ticket-1', {
        operationId: 'op-1',
        admission: { leaseId: '00000000-0000-4000-8000-000000000003', fencingToken: '7' },
      }),
    ).resolves.toMatchObject({ operationId: 'op-1' });
    await expect(client.retry('ticket-1', { operationId: 'op-1' })).resolves.toMatchObject({
      operationId: 'op-1',
    });

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:3190/bridge/v1/tickets/ticket-1/pause',
      'http://127.0.0.1:3190/bridge/v1/tickets/ticket-1/start',
      'http://127.0.0.1:3190/bridge/v1/tickets/ticket-1/resume',
      'http://127.0.0.1:3190/bridge/v1/tickets/ticket-1/retry',
    ]);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(calls[0]?.body).toEqual({ operationId: 'op-1', reason: 'owner stop' });
    expect(calls[1]?.body).toEqual({ operationId: 'op-1', planRevision: 2 });
    expect(calls[2]?.body).toMatchObject({
      admission: { fencingToken: '7' },
    });
  });

  it('reads an operation result and a ticket snapshot with the M4 fields', async () => {
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190',
      token: 'machine-token-0123456789',
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).includes('/operations/')) {
          return jsonResponse({
            operationId: 'op-1',
            ticketId: 'ticket-1',
            kind: 'pause',
            state: 'succeeded',
            evidence: { agentStatus: 'idle', harnessPid: 4321 },
            updatedAt: '2026-11-04T00:00:00.000Z',
          });
        }
        return jsonResponse({
          ticketId: 'ticket-1',
          title: 'M4 task',
          state: 'stopped',
          mode: 'discuss',
          planRevision: 1,
          paused: {
            at: '2026-11-04T00:00:00.000Z',
            by: 'human',
            stoppedAt: '2026-11-04T00:00:01.000Z',
            evidence: { agentStatus: 'idle' },
          },
          execution: { name: 'm4-task', directory: '/tmp/m4-task', assignment: '' },
        });
      }) as typeof fetch,
    });

    await expect(client.operation('op-1')).resolves.toMatchObject({
      state: 'succeeded',
      evidence: { harnessPid: 4321 },
    });
    await expect(client.ticket('ticket-1')).resolves.toMatchObject({
      state: 'stopped',
      mode: 'discuss',
      planRevision: 1,
      paused: { by: 'human' },
      execution: { directory: '/tmp/m4-task' },
    });
  });

  it('passes targetTicketId through a trigger request', async () => {
    let body: Record<string, unknown> = {};
    const client = new RuntimeBridgeClient({
      baseUrl: 'http://127.0.0.1:3190',
      token: 'machine-token-0123456789',
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          result: 'stored',
          triggerId: 'workspace:message-1',
          baseCommit: 'a'.repeat(40),
          ticketId: 'ticket-1',
        });
      }) as typeof fetch,
    });

    await client.trigger({
      triggerId: 'workspace:message-1',
      conversationId: '00000000-0000-4000-8000-000000000001',
      messageId: '00000000-0000-4000-8000-000000000002',
      replyToMessageId: null,
      targetTicketId: 'ticket-1',
      actor: { id: 'owner-1' },
      text: 'Continue on GitHub',
      at: '2026-11-04T00:00:00.000Z',
      executionSpec: {
        repository: 'Bouyer12/m4-import',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        model: null,
        mode: 'discuss',
      },
    });
    expect(body.targetTicketId).toBe('ticket-1');
    expect((body.executionSpec as Record<string, unknown>).mode).toBe('discuss');
  });
});
