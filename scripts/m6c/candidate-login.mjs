#!/usr/bin/env node
/**
 * MoYu M6-C candidate sign-in with the saved automation credential.
 * Automation evidence only; the real-device passkey stays an owner action.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium } from 'playwright';

const origin = process.env.M6C_ORIGIN;
const credentialPath = process.env.E2E_CREDENTIALS;
const out = process.env.E2E_OUT ?? '';
if (!origin) throw new Error('M6C_ORIGIN is required');
if (!credentialPath) throw new Error('E2E_CREDENTIALS is required');
const url = new URL(origin);
if (!url.hostname.endsWith('.sslip.io') && url.hostname !== 'localhost') {
  throw new Error(`refusing to sign in to a non-candidate origin: ${origin}`);
}
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
if (!Array.isArray(credentials) || credentials.length === 0) throw new Error('no saved credential');

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
for (const credential of credentials) {
  await client.send('WebAuthn.addCredential', { authenticatorId, credential });
}
step('credential-loaded', { count: credentials.length });

try {
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const loginVisible = await page
    .getByRole('button', { name: /登录|使用 Passkey/ })
    .first()
    .isVisible()
    .catch(() => false);
  step('landing', { loginVisible });
  if (loginVisible) {
    await page
      .getByRole('button', { name: /登录|使用 Passkey/ })
      .first()
      .click();
    await page.waitForFunction(
      () => !!document.querySelector('nav') || window.location.pathname !== '/',
      undefined,
      {
        timeout: 30000,
      },
    );
    step('login-submitted');
  }
  await page.waitForLoadState('networkidle');
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/me', { credentials: 'include' });
    return { status: response.status, body: response.ok ? await response.json() : null };
  });
  step('me', { status: me.status, owner: me.body?.data?.owner?.displayName ?? null });
  report.owner = me.body?.data?.owner ?? null;
  report.ok = me.status === 200;
  await page.screenshot({ path: process.env.E2E_SHOT ?? '/tmp/m6c-home.png', fullPage: true });
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => /moyu_session$/.test(cookie.name));
  if (session) writeFileSync('/root/m6c-session-cookie.txt', session.value, { mode: 0o600 });
  report.authenticated = report.ok;
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: '/tmp/m6c-login-error.png', fullPage: true }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  await browser.close();
}
if (!report.ok) process.exit(1);
