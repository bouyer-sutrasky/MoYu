#!/usr/bin/env node
/* global localStorage */
/**
 * Real-browser regression for the M4-UX behaviours a multi-repository change
 * could disturb: conversation keyset pagination and a restored draft. It uses
 * the isolated API/DB and an injected test session; it does not create users or
 * bypass the product's Passkey flow.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { chromium } from 'playwright';

const API = process.env.M5_AFTER_URL ?? 'http://127.0.0.1:4500';
const TOKEN = process.env.M5_SESSION_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = process.env.M5_OWNER_ID;
const REPOSITORY_ID = process.env.M5_REPOSITORY_ID;
const OUT = resolve(process.env.M5_OUT ?? 'docs/evidence/m5');
if (!TOKEN || !DATABASE_URL || !OWNER_ID || !REPOSITORY_ID) {
  throw new Error('M5_SESSION_TOKEN, DATABASE_URL, M5_OWNER_ID and M5_REPOSITORY_ID are required');
}
mkdirSync(OUT, { recursive: true });

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
const prefix = `m5-paging-${Date.now()}`;
for (let index = 0; index < 55; index += 1) {
  await client.query(
    `insert into conversations
       (owner_id, repository_id, mode, execution_mode, base_branch, source, title, client_request_id, updated_at)
     values ($1, $2, 'work', 'execute', 'main', 'web', $3, $4, now() - ($5::int * interval '1 second'))`,
    [
      OWNER_ID,
      REPOSITORY_ID,
      `${prefix}-${String(index).padStart(2, '0')}`,
      `${prefix}-${index}`,
      index,
    ],
  );
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('moyu.theme', 'light'));
await context.addCookies([{ name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
await page.goto(API, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('select', { timeout: 30_000 });
await page.waitForTimeout(1000);
const firstPage = await page.locator('[data-conversation-id]').count();
if (firstPage !== 50) throw new Error(`expected 50 first-page conversations, got ${firstPage}`);
await page.getByRole('button', { name: '加载更多任务' }).click();
await page.waitForTimeout(1500);
const secondPage = await page.locator('[data-conversation-id]').count();
if (secondPage <= firstPage)
  throw new Error(`pagination did not append: ${firstPage} -> ${secondPage}`);

const draftText = `m5-draft-${randomUUID()}`;
const first = page.locator('[data-conversation-id]').first();
await first.click();
await page.waitForTimeout(500);
await page.locator('textarea').fill(draftText);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('select', { timeout: 30_000 });
await page.waitForTimeout(800);
await page.locator('[data-conversation-id]').first().click();
await page.waitForTimeout(500);
const restored = await page.locator('textarea').inputValue();

await context.close();
await browser.close();

// Remove only the synthetic pagination rows; the selected conversation and its
// draft are the real M5 test data and stay for the lifecycle evidence.
await client.query('delete from conversations where client_request_id like $1', [`${prefix}-%`]);
await client.end();

const result = {
  at: new Date().toISOString(),
  firstPage,
  secondPage,
  draftRestored: restored === draftText,
  checks: [
    { name: 'keyset-pagination-appends', ok: secondPage > firstPage },
    { name: 'draft-restored-after-reload', ok: restored === draftText },
  ],
};
result.ok = result.checks.every((check) => check.ok);
writeFileSync(resolve(OUT, 'browser-regression.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
