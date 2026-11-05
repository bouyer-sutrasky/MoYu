#!/usr/bin/env node
/* global localStorage */
/**
 * Captures the M5-A repository lifecycle UI against the real API and the
 * previous M4-UX build. It injects the test session cookie; it does not create
 * or mutate any account. Both sides read the same isolated database.
 *
 * Required:
 *   M5_SESSION_TOKEN   cookie value for the isolated owner session
 *   M5_AFTER_URL       current build origin (default http://127.0.0.1:4500)
 *   M5_BEFORE_URL      previous M4-UX build origin (default http://127.0.0.1:4501)
 *   M5_BEFORE_REPO     repository label selected on both sides
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const AFTER = process.env.M5_AFTER_URL ?? 'http://127.0.0.1:4500';
const BEFORE = process.env.M5_BEFORE_URL ?? 'http://127.0.0.1:4501';
const TOKEN = process.env.M5_SESSION_TOKEN;
const OUT = resolve(process.env.M5_OUT ?? 'docs/evidence/m5');
const REPO = process.env.M5_BEFORE_REPO ?? 'Bouyer12/m5a-beta-adf10ad9';

if (!TOKEN) throw new Error('M5_SESSION_TOKEN is required');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const records = [];

async function shot(name, base, theme, viewport, options = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((mode) => {
    localStorage.setItem('moyu.theme', mode);
  }, theme);
  await context.addCookies([
    { name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  if (options.selectRepo) {
    const optionsList = await page.locator('select').first().locator('option').allTextContents();
    const match = optionsList.find((text) => text.includes(options.selectRepo));
    if (!match) throw new Error(`repository option not found: ${options.selectRepo}`);
    await page.locator('select').first().selectOption({ label: match });
    await page.waitForTimeout(800);
  }
  if (options.openSidebar) {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.waitForTimeout(300);
  }
  if (options.openAddDialog) {
    await page.getByRole('button', { name: '添加仓库' }).click();
    await page.waitForTimeout(500);
  }
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  records.push({ name, file, url: base, theme, viewport });
  await context.close();
}

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

for (const theme of ['light', 'dark']) {
  await shot(`before-desktop-${theme}-sleeping`, BEFORE, theme, desktop, { selectRepo: REPO });
  await shot(`after-desktop-${theme}-sleeping`, AFTER, theme, desktop, { selectRepo: REPO });
  await shot(`before-mobile-${theme}-sleeping`, BEFORE, theme, mobile, {
    selectRepo: REPO,
    openSidebar: true,
  });
  await shot(`after-mobile-${theme}-sleeping`, AFTER, theme, mobile, {
    selectRepo: REPO,
    openSidebar: true,
  });
}

await shot('after-desktop-light-online', AFTER, 'light', desktop, {
  selectRepo: 'Bouyer12/m5a-alpha-adf10ad9',
});
await shot('after-desktop-light-add-repository', AFTER, 'light', desktop, {
  selectRepo: REPO,
  openAddDialog: true,
});

await browser.close();
console.log(JSON.stringify({ out: OUT, records }, null, 2));
