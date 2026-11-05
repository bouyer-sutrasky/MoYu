#!/usr/bin/env node
/* global localStorage */
/**
 * DOM evidence for the M5-A lifecycle UI. It uses the isolated session cookie
 * and real API/DB state; it does not create accounts or bypass Passkey in the
 * product. Screenshots are captured separately by screenshots.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const AFTER = process.env.M5_AFTER_URL ?? 'http://127.0.0.1:4500';
const BEFORE = process.env.M5_BEFORE_URL ?? 'http://127.0.0.1:4501';
const TOKEN = process.env.M5_SESSION_TOKEN;
const OUT = resolve(process.env.M5_OUT ?? 'docs/evidence/m5');
const SLEEPING_REPO = process.env.M5_SLEEPING_REPO ?? 'Bouyer12/m5a-beta-adf10ad9';
if (!TOKEN) throw new Error('M5_SESSION_TOKEN is required');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const checks = [];

async function pageFor(base, theme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((mode) => localStorage.setItem('moyu.theme', mode), theme);
  await context.addCookies([
    { name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(800);
  return { context, page };
}

{
  const { context, page } = await pageFor(AFTER);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((text) => text.includes(SLEEPING_REPO));
  if (!match) throw new Error('sleeping repository option is missing');
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText();
  checks.push({ name: 'after-sleeping-status', ok: body.includes('仓库休眠') });
  checks.push({ name: 'after-listener-paused', ok: body.includes('GitHub 监听暂停') });
  checks.push({ name: 'after-wake-action', ok: body.includes('唤醒实例') });
  checks.push({ name: 'after-no-fake-eta', ok: !/预计|剩余 \d+ 分钟|完成时间/.test(body) });
  await page.getByRole('button', { name: '添加仓库' }).click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(1200);
  const dialog = await page.getByRole('dialog').innerText();
  const listed = dialog.includes('Bouyer12/m5a-alpha-adf10ad9');
  if (!listed) {
    await page
      .getByText('Bouyer12/m5a-alpha-adf10ad9')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => undefined);
  }
  const refreshedDialog = await page.getByRole('dialog').innerText();
  checks.push({
    name: 'add-dialog-lists-account-repos',
    ok: refreshedDialog.includes('Bouyer12/m5a-alpha-adf10ad9'),
  });
  const manual = page.getByPlaceholder('Bouyer12/example');
  await manual.fill('Bouyer12/m5a-alpha-adf10ad9');
  await page.getByRole('button', { name: '校验并添加' }).click();
  await page.waitForTimeout(1200);
  const dialogAfter = await page.getByRole('dialog').innerText();
  checks.push({ name: 'duplicate-add-shows-conflict', ok: /冲突|已添加/.test(dialogAfter) });
  await context.close();
}

{
  const { context, page } = await pageFor(BEFORE);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((text) => text.includes(SLEEPING_REPO));
  if (!match) throw new Error('baseline repository option is missing');
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  checks.push({ name: 'before-has-no-listener-status', ok: !body.includes('GitHub 监听暂停') });
  await context.close();
}

await browser.close();
const result = {
  at: new Date().toISOString(),
  after: AFTER,
  before: BEFORE,
  checks,
  ok: checks.every((check) => check.ok),
};
writeFileSync(resolve(OUT, 'ui-checks.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
