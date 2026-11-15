#!/usr/bin/env node
/* global document, window, URL, fetch */
/**
 * MoYu M6-C candidate: register the first owner passkey in a real browser.
 *
 * This is automation evidence only (CDP virtual authenticator). It is NOT the
 * owner's real-device passkey, which stays an owner action on the production
 * domain. The script refuses to run against anything but the candidate origin.
 *
 * Usage: node scripts/m6c/bootstrap-owner.mjs <binding-code>
 * Env:   M6C_ORIGIN (required), E2E_OUT (optional JSON report path)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium } from 'playwright';

const code = process.argv[2];
const origin = process.env.M6C_ORIGIN;
const out = process.env.E2E_OUT ?? '';

if (!origin) throw new Error('M6C_ORIGIN is required');
const url = new URL(origin);
if (!url.hostname.endsWith('.sslip.io') && url.hostname !== 'localhost') {
  throw new Error(`refusing to bootstrap a non-candidate origin: ${origin}`);
}
if (!code) throw new Error('binding code argument is required');

const report = { origin, startedAt: new Date().toISOString(), steps: [] };
const step = (name, detail = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`[step] ${name}`, JSON.stringify(detail));
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const client = await context.newCDPSession(page);
await client.send('WebAuthn.enable');
const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
step('virtual-authenticator-added', { authenticatorId });

try {
  await page.goto(`${origin}/setup`, { waitUntil: 'networkidle' });
  step('opened-setup', { title: await page.title() });

  await page.fill('input[placeholder="XXXX-XXXX-XXXX"]', code);
  await page.getByRole('button', { name: '验证绑定码' }).click();
  await page.waitForFunction(
    () => !!document.querySelector('input[placeholder*="MacBook"]'),
    undefined,
    { timeout: 20000 },
  );
  step('binding-code-consumed');

  const label = `m6c-candidate-${new Date().toISOString().slice(0, 10)}`;
  await page.fill('input[placeholder*="MacBook"]', label);
  await page
    .getByRole('button', { name: /登记|注册|创建/ })
    .first()
    .click();
  await page.waitForFunction(
    () => window.location.pathname === '/' || !!document.querySelector('nav'),
    undefined,
    { timeout: 30000 },
  );
  step('passkey-registered', { label });

  const credentials = await client.send('WebAuthn.getCredentials', { authenticatorId });
  // Keep the automation credential so later runs can sign in again; a real
  // device passkey is never written to disk by this script.
  if (process.env.E2E_CREDENTIAL_OUT) {
    writeFileSync(
      process.env.E2E_CREDENTIAL_OUT,
      `${JSON.stringify(credentials.credentials, null, 2)}
`,
      { mode: 0o600 },
    );
  }
  step('authenticator-credentials', { count: credentials.credentials.length });

  await page.waitForLoadState('networkidle');
  const authState = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/state', { credentials: 'include' });
    return response.json();
  });
  step('auth-state', authState.data);
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/me', { credentials: 'include' });
    return { status: response.status, body: response.ok ? await response.json() : null };
  });
  step('me', { status: me.status, owner: me.body?.data?.owner?.displayName ?? null });

  await page.screenshot({ path: '/tmp/m6c-owner-home.png', fullPage: true });
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((cookie) => /moyu_session$/.test(cookie.name));
  report.authenticated = me.status === 200;
  report.cookieNames = cookies.map((cookie) => cookie.name);
  report.ok = report.authenticated && !!sessionCookie;
  if (sessionCookie) {
    writeFileSync('/root/m6c-session-cookie.txt', sessionCookie.value, { mode: 0o600 });
  }
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: '/tmp/m6c-owner-error.png', fullPage: true }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  await browser.close();
}
if (!report.ok) process.exit(1);
