#!/usr/bin/env node
/* global fetch */
/**
 * A1's missing half: a real attachment operation in a real browser, on both the
 * desktop (1440×900) and the phone (390×844) viewport. It selects a file in the
 * composer, sends it with a message, asserts the chip and the sent message show
 * it, screenshots the result, and checks through the API that the stored
 * attachment has the same sha256 as the bytes the browser sent.
 *
 * This is the built Web app served by the isolated API, with the real
 * PostgreSQL behind it; the only injected value is the session cookie.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const CONVERSATION = process.env.M6A_CONVERSATION_ID;
const REPOSITORY = process.env.M6A_REPOSITORY ?? 'bouyer-sutrasky/MoYu';
const OUT = resolve(process.env.M6A_OUT ?? 'docs/evidence/m6a');
if (!BASE || !TOKEN || !CONVERSATION) {
  throw new Error('M6A_AFTER_URL, M6A_SESSION_TOKEN and M6A_CONVERSATION_ID are required');
}
mkdirSync(OUT, { recursive: true });

const BYTES = Buffer.from('M6-A mobile and desktop attachment UI check\nsecond line\n', 'utf8');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const browser = await chromium.launch({ headless: true });

async function run(label, viewport) {
  const fileName = `m6a-ui-${label}.txt`;
  const text = `M6-A ${label} attachment UI check`;
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.addCookies([
    { name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(500);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((option) => option.includes(REPOSITORY));
  if (!match) throw new Error(`repository option not found: ${REPOSITORY}`);
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(500);
  if (viewport.width < 500) {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.waitForTimeout(500);
  }
  await page.locator(`[data-conversation-id="${CONVERSATION}"]`).first().click();
  await page.waitForTimeout(800);

  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: BYTES,
  });
  await page.waitForTimeout(300);
  const chipVisible = await page.getByText(fileName, { exact: false }).count();
  await page.locator('textarea').first().fill(text);
  const sent = page
    .waitForResponse(
      (response) => response.request().method() === 'POST' && /\/messages$/.test(response.url()),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await sent;
  await page.waitForTimeout(1200);
  const shownInMessage = await page.getByText(fileName, { exact: false }).count();
  const screenshot = resolve(OUT, `after-${label}-light-attachment.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  return { label, viewport, fileName, chipVisible, shownInMessage, screenshot };
}

const results = [];
try {
  results.push(await run('desktop', { width: 1440, height: 900 }));
  results.push(await run('mobile', { width: 390, height: 844 }));
} finally {
  await browser.close();
}

// The API is the authority: the message must carry the attachment and its
// sha256 must be the bytes the browser handed to the composer.
const response = await fetch(`${BASE}/api/v1/conversations/${CONVERSATION}/messages`, {
  headers: { cookie: `moyu_session=${TOKEN}` },
});
if (!response.ok) throw new Error(`message list failed: ${response.status}`);
const body = await response.json();
const messages = body.data.messages;
let failed = false;
for (const result of results) {
  const message = messages.find((item) =>
    (item.attachments ?? []).some((attachment) => attachment.filename === result.fileName),
  );
  const attachment = (message?.attachments ?? []).find((item) => item.filename === result.fileName);
  const good =
    result.chipVisible > 0 &&
    result.shownInMessage > 0 &&
    Boolean(message) &&
    attachment?.sha256 === SHA;
  if (!good) failed = true;
  console.log(
    `${result.label}: viewport=${result.viewport.width}x${result.viewport.height} ` +
      `chipVisible=${result.chipVisible} shownInMessage=${result.shownInMessage} ` +
      `screenshot=${result.screenshot}`,
  );
  console.log(
    `${result.label}: messageId=${message?.id ?? 'missing'} attachment=${JSON.stringify(
      attachment
        ? {
            filename: attachment.filename,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
          }
        : null,
    )} expectedSha256=${SHA}`,
  );
}
process.exitCode = failed ? 1 : 0;
