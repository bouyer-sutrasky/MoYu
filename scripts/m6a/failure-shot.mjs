#!/usr/bin/env node
/* global localStorage */
/**
 * Captures the review panel while the task's last check run is a failure. It
 * runs between the deliberate type break and the restore, so the image shows the
 * real failing state instead of a re-rendered "passed" one.
 */
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const URL = process.env.M6A_AFTER_URL ?? 'http://127.0.0.1:4620';
const TOKEN = process.env.M6A_SESSION_TOKEN;
const CONVERSATION = process.env.M6A_CONVERSATION_ID;
const OUT = resolve(process.env.M6A_OUT ?? 'docs/evidence/m6a');
if (!TOKEN || !CONVERSATION)
  throw new Error('M6A_SESSION_TOKEN and M6A_CONVERSATION_ID are required');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'light',
});
await context.addInitScript(() => localStorage.setItem('moyu.theme', 'light'));
await context.addCookies([{ name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('select', { timeout: 30_000 });
await page.waitForTimeout(800);
const options = await page.locator('select').first().locator('option').allTextContents();
const match = options.find((text) => text.includes('MoYu'));
if (!match) throw new Error('repository option not found');
await page.locator('select').first().selectOption({ label: match });
await page.waitForTimeout(900);
await page.locator(`[data-conversation-id="${CONVERSATION}"]`).first().click();
await page.waitForTimeout(1000);
await page.getByRole('button', { name: '展开右侧详情' }).click();
await page.waitForTimeout(2500);
const text = await page.locator('aside[aria-label="会话详情"]').innerText();
await page.screenshot({ path: resolve(OUT, 'after-desktop-light-checks-failed.png') });
await browser.close();
if (!text.includes('失败') || !text.includes('exit 2')) {
  throw new Error('the failing check is not visible in the panel text');
}
process.stdout.write('failing check visible in the panel: yes\n');
