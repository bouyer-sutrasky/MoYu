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
