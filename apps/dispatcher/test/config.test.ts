import { describe, expect, it } from 'vitest';

import { loadDispatcherConfig } from '../src/config';

describe('dispatcher configuration', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadDispatcherConfig({ NODE_ENV: 'test' })).toThrow(
      /Invalid dispatcher configuration/,
    );
  });

  it('rejects non-PostgreSQL URLs', () => {
    expect(() =>
      loadDispatcherConfig({ NODE_ENV: 'test', DATABASE_URL: 'mysql://localhost/moyu' }),
    ).toThrow(/postgres/);
  });

  it('accepts a PostgreSQL URL with defaults', () => {
    const config = loadDispatcherConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/moyu',
    });

    expect(config.nodeEnv).toBe('test');
    expect(config.logLevel).toBe('info');
    expect(config.databaseUrl).toContain('postgres://');
  });
});
