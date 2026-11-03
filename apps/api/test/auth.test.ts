import { describe, expect, it } from 'vitest';

import {
  generateBootstrapCode,
  hashSecret,
  normalizeBootstrapCode,
  randomToken,
  safeEqualText,
} from '../src/auth/crypto';
import { loadConfig } from '../src/config';
import { createRateLimiter } from '../src/lib/rate-limit';

describe('owner binding codes', () => {
  it('prints a grouped 12-character code from an unambiguous alphabet', () => {
    const code = generateBootstrapCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(normalizeBootstrapCode(code)).toHaveLength(12);
    expect(generateBootstrapCode()).not.toBe(code);
  });

  it('normalizes separators and lowercase input for comparison', () => {
    expect(normalizeBootstrapCode(' abcd-efgh-jkmn ')).toBe('ABCDEFGHJKMN');
    expect(normalizeBootstrapCode('ABCD EFGH JKMN')).toBe('ABCDEFGHJKMN');
  });

  it('hashes codes and session tokens without exposing the value', () => {
    const first = hashSecret('ABCD-EFGH-JKMN');
    expect(first).toHaveLength(64);
    expect(first).not.toContain('ABCD');
    expect(hashSecret('ABCD-EFGH-JKMN')).toBe(first);
    expect(hashSecret('ABCD-EFGH-JKMX')).not.toBe(first);
  });

  it('generates random session tokens and compares them safely', () => {
    const token = randomToken(32);
    expect(token.length).toBeGreaterThan(30);
    expect(randomToken(32)).not.toBe(token);
    expect(safeEqualText(token, token)).toBe(true);
    expect(safeEqualText(token, `${token}x`)).toBe(false);
  });
});

describe('authentication rate limiting', () => {
  it('allows the configured budget and rejects the next attempt in the window', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
    expect(limiter.take('other')).toBe(true);

    now = 1_001;
    expect(limiter.take('ip')).toBe(true);
  });
});

describe('authentication configuration', () => {
  it('derives Secure cookies from an https origin', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEBAUTHN_ORIGIN: 'https://moyu.sutrasky.com',
      WEBAUTHN_RP_ID: 'moyu.sutrasky.com',
    });
    expect(config.cookieSecure).toBe(true);
    expect(config.webauthnRpId).toBe('moyu.sutrasky.com');
  });

  it('allows an insecure cookie only for an explicit development override', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEBAUTHN_ORIGIN: 'http://localhost:5173',
      WEBAUTHN_RP_ID: 'localhost',
      AUTH_COOKIE_SECURE: 'false',
    });
    expect(config.cookieSecure).toBe(false);
  });

  it('rejects an RP ID that is unrelated to the configured origin', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        WEBAUTHN_ORIGIN: 'https://moyu.sutrasky.com',
        WEBAUTHN_RP_ID: 'example.com',
      }),
    ).toThrow(/WEBAUTHN_RP_ID/);
  });

  it('rejects malformed origins and non-positive TTLs', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', WEBAUTHN_ORIGIN: 'not-a-url' })).toThrow(
      /Invalid API configuration/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_SESSION_TTL_DAYS: '0' })).toThrow(
      /Invalid API configuration/,
    );
  });
});
