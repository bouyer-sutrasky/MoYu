#!/usr/bin/env node
/** Captures the pre-L117 task view: a finished task with no "new task from this task" action. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const SEED = JSON.parse(readFileSync(process.env.M6A_SEED, 'utf8'));
const OUT = resolve(process.env.M6A_OUT ?? 'docs/evidence/m6a');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'light',
});
await context.addCookies([{ name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('select', { timeout: 30_000 });
await page.waitForTimeout(500);
const options = await page.locator('select').first().locator('option').allTextContents();
const match = options.find((option) => option.includes('Bouyer12/l117-source'));
await page.locator('select').first().selectOption({ label: match });
await page.waitForTimeout(500);
await page.getByText(SEED.tasks.completed.title, { exact: false }).first().click();
await page.waitForTimeout(800);
const count = await page.locator('[data-testid="new-task-from-task"]').count();
console.log(`new-task-from-task buttons on the old build: ${count}`);
await page.screenshot({ path: resolve(OUT, 'before-desktop-l117-task.png'), fullPage: false });
await context.close();
await browser.close();
process.exitCode = count === 0 ? 0 : 1;
