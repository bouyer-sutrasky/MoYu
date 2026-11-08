#!/usr/bin/env node
/* global localStorage */
/**
 * M6-A review panel comparison: the main baseline build (before) and this
 * branch's build (after), each a real API process serving real Web assets over
 * the same isolated database and the same supervisor-collected artifacts.
 *
 * The before build has no review panel (it shows the M6 placeholder), so the
 * same scenario is captured on both sides. The DOM facts asserted here are
 * written next to the images.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const AFTER = process.env.M6A_AFTER_URL ?? 'http://127.0.0.1:4620';
const BEFORE = process.env.M6A_BEFORE_URL ?? 'http://127.0.0.1:4621';
const TOKEN = process.env.M6A_SESSION_TOKEN;
const CONVERSATION = process.env.M6A_CONVERSATION_ID;
const CLEANED_CONVERSATION = process.env.M6A_CLEANED_CONVERSATION_ID;
const OUT = resolve(process.env.M6A_OUT ?? 'docs/evidence/m6a');
const REPOSITORY = process.env.M6A_REPOSITORY ?? 'Bouyer12/m6a-review';
if (!TOKEN || !CONVERSATION) throw new Error('M6A_SESSION_TOKEN and M6A_CONVERSATION_ID are required');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const records = [];
const views = {};

async function open(base, theme, viewport, conversationId) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((mode) => localStorage.setItem('moyu.theme', mode), theme);
  await context.addCookies([{ name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((text) => text.includes(REPOSITORY));
  if (!match) throw new Error(`repository option not found: ${REPOSITORY}`);
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(700);
  await page.locator(`[data-conversation-id="${conversationId}"]`).first().click();
  await page.waitForTimeout(900);
  const toggle = page.getByRole('button', { name: '展开右侧详情' });
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(1800);
  }
  return { context, page };
}

async function capture(name, base, theme, viewport, conversationId) {
  const { context, page } = await open(base, theme, viewport, conversationId);
  const text = await page
    .locator('aside[aria-label="会话详情"]')
    .innerText()
    .catch(() => page.locator('body').innerText());
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  records.push({ name, file, base, theme, viewport, conversationId });
  writeFileSync(resolve(OUT, 'records.json'), JSON.stringify(records, null, 2));
  await context.close();
  return text;
}

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

for (const theme of ['light', 'dark']) {
  views[`before-desktop-${theme}`] = await capture(
    `before-desktop-${theme}-review-panel`,
    BEFORE,
    theme,
    desktop,
    CONVERSATION,
  );
  views[`after-desktop-${theme}`] = await capture(
    `after-desktop-${theme}-review-panel`,
    AFTER,
    theme,
    desktop,
    CONVERSATION,
  );
  views[`before-mobile-${theme}`] = await capture(
    `before-mobile-${theme}-review-panel`,
    BEFORE,
    theme,
    mobile,
    CONVERSATION,
  );
  views[`after-mobile-${theme}`] = await capture(
    `after-mobile-${theme}-review-panel`,
    AFTER,
    theme,
    mobile,
    CONVERSATION,
  );
}

// The additional after-only states: a failing check run and a cleaned worktree.
views['after-desktop-light-checks-failed'] = await capture(
  'after-desktop-light-checks-failed',
  AFTER,
  'light',
  desktop,
  CONVERSATION,
);
views['after-desktop-light-cleaned'] = await capture(
  'after-desktop-light-cleaned',
  AFTER,
  'light',
  desktop,
  CLEANED_CONVERSATION,
);

const facts = {
  capturedAt: new Date().toISOString(),
  afterUrl: AFTER,
  beforeUrl: BEFORE,
  beforeShowsPlaceholder: (views['before-desktop-light'] ?? '').includes('在 M6 接入'),
  afterShowsChangesSection: (views['after-desktop-light'] ?? '').includes('变更'),
  afterShowsChecksSection: (views['after-desktop-light'] ?? '').includes('检查'),
  afterShowsCommit: /[0-9a-f]{40}/.test(views['after-desktop-light'] ?? ''),
  afterShowsFile: (views['after-desktop-light'] ?? '').includes('review-fixture.txt'),
  afterShowsCheckPassed: (views['after-desktop-light'] ?? '').includes('通过'),
  afterShowsCheckFailed: (views['after-desktop-light-checks-failed'] ?? '').includes('失败'),
  afterShowsCleaned: (views['after-desktop-light-cleaned'] ?? '').includes('工作目录已清理'),
  records,
};
writeFileSync(resolve(OUT, 'ui-checks.json'), JSON.stringify(facts, null, 2));
writeFileSync(resolve(OUT, 'panel-text.json'), JSON.stringify(views, null, 2));
await browser.close();
process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
