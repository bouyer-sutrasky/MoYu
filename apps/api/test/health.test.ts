import { healthResponseSchema, readinessResponseSchema } from '@moyu/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

let app: FastifyInstance | undefined;

function createApp(): FastifyInstance {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  app = buildApp({ config });
  return app;
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('GET /healthz', () => {
  it('returns a contract-valid success envelope and request id header', async () => {
    const server = createApp();
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();

    const parsed = healthResponseSchema.parse(response.json());
    expect(parsed.data.status).toBe('ok');
    expect(parsed.data.service).toBe('moyu-api');
    expect(parsed.requestId).toBe(response.headers['x-request-id']);
  });
});

describe('GET /readyz', () => {
  it('fails with a structured 503 when the database is not configured', async () => {
    const server = createApp();
    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(readinessResponseSchema.safeParse(response.json()).success).toBe(false);
    expect(response.json()).toMatchObject({
      error: { code: 'dependency_unavailable', retryable: true },
      requestId: response.headers['x-request-id'],
    });
  });
});

describe('unknown routes', () => {
  it('use the shared error envelope', async () => {
    const server = createApp();
    const response = await server.inject({ method: 'GET', url: '/api/v1/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'not_found', retryable: false },
    });
  });
});

describe('configuration', () => {
  it('rejects an out-of-range port without echoing values', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', API_PORT: '70000' })).toThrow(
      /Invalid API configuration/,
    );
  });

  it('accepts a postgres database URL', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/moyu',
    });

    expect(config.databaseUrl).toContain('postgres://');
  });
});
