#!/usr/bin/env node
/**
 * P1-B attachment binding: real browser against a real isolated API and a real
 * PostgreSQL seed. The same script runs twice:
 *
 *   P1B_SIDE=before  on the pre-fix build  -> the switch scenario fails and the
 *                    captured POST /attachments URL shows conversation B (the bug)
 *   P1B_SIDE=after   on the fixed build    -> every check passes
 *
 * This is an end-to-end check (real API, real DB, real Chromium), not a
 * component test with stubbed HTTP. The network records it writes are the raw
 * request URLs and message bodies the browser actually sent.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const CONVERSATION_A = process.env.M6A_CONVERSATION_A;
const CONVERSATION_B = process.env.M6A_CONVERSATION_B;
const SIDE = process.env.P1B_SIDE ?? 'after';
const OUT = resolve(process.env.P1B_OUT ?? 'docs/evidence/m6a/p1b');
const REPOSITORY = process.env.P1B_REPOSITORY ?? 'bouyer-sutrasky/MoYu';
if (!BASE || !TOKEN || !CONVERSATION_A || !CONVERSATION_B) {
  throw new Error(
    'M6A_AFTER_URL, M6A_SESSION_TOKEN, M6A_CONVERSATION_A and M6A_CONVERSATION_B are required',
  );
}
mkdirSync(OUT, { recursive: true });

const checks = [];
const records = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
function record(entry) {
  records.push(entry);
}

const browser = await chromium.launch({ headless: true });
const failed = [];

async function openPage({ viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.addCookies([
    { name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    const attachment = url.match(/\/api\/v1\/conversations\/([^/]+)\/attachments$/);
    if (attachment) {
      const entry = { kind: 'attachment', url, conversationId: attachment[1] };
      requests.push(entry);
      console.log(`UPLOAD ${url}`);
      return;
    }
    const message = url.match(/\/api\/v1\/conversations\/([^/]+)\/messages$/);
    if (message) {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const entry = { kind: 'message', url, conversationId: message[1], body };
      requests.push(entry);
      console.log(
        `MESSAGE ${url} attachmentIds=${JSON.stringify(body?.attachmentIds ?? null)} text=${JSON.stringify(body?.text ?? null)}`,
      );
    }
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(500);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((text) => text.includes(REPOSITORY));
  if (!match) throw new Error(`repository option not found: ${REPOSITORY}`);
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(500);
  return { context, page, requests };
}

async function openConversation(page, conversationId) {
  await page.locator(`[data-conversation-id="${conversationId}"]`).first().click();
  await page.waitForTimeout(700);
}

async function attach(page, name) {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`P1-B ${name}\n`),
  });
  await page.waitForTimeout(300);
}

const textarea = (page) => page.locator('textarea').first();
const sendButton = (page) => page.getByRole('button', { name: '发送', exact: true });
const chipCount = (page, name) => page.getByText(name, { exact: false }).count();

async function send(page) {
  const response = page
    .waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        /\/api\/v1\/conversations\/[^/]+\/messages$/.test(candidate.url()),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await sendButton(page).click();
  await response;
  await page.waitForTimeout(900);
}

async function shot(page, name) {
  const path = resolve(OUT, `${SIDE}-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`SHOT ${path}`);
  return path;
}

async function scenarioSwitch() {
  console.log('\n## scenario 1: select in A, switch to B, send in B');
  const session = await openPage();
  const { page, requests } = session;
  await openConversation(page, CONVERSATION_A);
  await attach(page, 'p1b-switch-a.txt');
  const inA = await chipCount(page, 'p1b-switch-a.txt');
  await shot(page, 'a-selected');
  await openConversation(page, CONVERSATION_B);
  const inB = await chipCount(page, 'p1b-switch-a.txt');
  await textarea(page).fill('P1-B switch scenario');
  await shot(page, 'switch-to-b');
  await send(page);
  const uploads = requests.filter((entry) => entry.kind === 'attachment');
  const messages = requests.filter((entry) => entry.kind === 'message');
  record({ scenario: 'switch', side: SIDE, inA, inB, uploads, messages });
  check('A shows the selected attachment before switching', inA > 0, `count=${inA}`);
  check("B does not show A's selected attachment after switching", inB === 0, `count=${inB}`);
  check(
    `no attachment upload for B after the switch (raw URLs: ${JSON.stringify(uploads.map((entry) => entry.url))})`,
    uploads.length === 0,
    `uploads=${uploads.length}`,
  );
  check(
    `B's message carries no attachmentIds (raw body: ${JSON.stringify(messages.map((entry) => entry.body))})`,
    messages.every((entry) => (entry.body?.attachmentIds ?? []).length === 0),
    `messages=${messages.length}`,
  );
  await session.context.close();
}

async function scenarioLateResponse() {
  console.log('\n## scenario 2: slow upload started in A, switch to B before it completes');
  const session = await openPage();
  const { page, requests } = session;
  await page.route(`**/api/v1/conversations/${CONVERSATION_A}/attachments`, async (route) => {
    await delay(2000);
    await route.continue();
  });
  await openConversation(page, CONVERSATION_A);
  await attach(page, 'p1b-late-a.txt');
  await textarea(page).fill('P1-B late response scenario');
  await sendButton(page).click();
  await page.waitForTimeout(400);
  await openConversation(page, CONVERSATION_B);
  const uploadingVisibleInB = await page.getByText('正在上传…', { exact: false }).count();
  await page.waitForTimeout(3500);
  const lateChipInB = await chipCount(page, 'p1b-late-a.txt');
  await shot(page, 'late-response-in-b');
  const uploads = requests.filter((entry) => entry.kind === 'attachment');
  const messages = requests.filter((entry) => entry.kind === 'message');
  record({ scenario: 'late', side: SIDE, uploadingVisibleInB, lateChipInB, uploads, messages });
  check(
    "B does not show A's in-flight upload indicator",
    uploadingVisibleInB === 0,
    `count=${uploadingVisibleInB}`,
  );
  check(
    "B's attachment list does not receive A's late response",
    lateChipInB === 0,
    `count=${lateChipInB}`,
  );
  check(
    'the late upload stays on A and the message goes to A (raw URLs)',
    uploads.length === 1 &&
      uploads[0].conversationId === CONVERSATION_A &&
      messages.length === 1 &&
      messages[0].conversationId === CONVERSATION_A,
    JSON.stringify({
      uploads: uploads.map((entry) => entry.url),
      messages: messages.map((entry) => entry.url),
    }),
  );
  await session.context.close();
}

async function scenarioSameConversation() {
  console.log('\n## scenario 3: same conversation still uploads and binds');
  const session = await openPage();
  const { page, requests } = session;
  await openConversation(page, CONVERSATION_B);
  await attach(page, 'p1b-same-b.txt');
  await textarea(page).fill('P1-B same conversation scenario');
  await shot(page, 'same-conversation-selected');
  await send(page);
  const uploads = requests.filter((entry) => entry.kind === 'attachment');
  const messages = requests.filter((entry) => entry.kind === 'message');
  record({ scenario: 'same', side: SIDE, uploads, messages });
  check(
    'the upload target is the open conversation (raw URL)',
    uploads.length === 1 && uploads[0].conversationId === CONVERSATION_B,
    JSON.stringify(uploads.map((entry) => entry.url)),
  );
  check(
    'the message in the same conversation carries the uploaded attachment',
    messages.length === 1 && (messages[0].body?.attachmentIds ?? []).length === 1,
    JSON.stringify(messages.map((entry) => entry.body)),
  );
  await session.context.close();
}

async function scenarioDeletedFile() {
  console.log('\n## scenario 4: remove the selected file before sending');
  const session = await openPage();
  const { page, requests } = session;
  await openConversation(page, CONVERSATION_B);
  await attach(page, 'p1b-delete-b.txt');
  await page.getByRole('button', { name: '移除附件 p1b-delete-b.txt' }).click();
  await page.waitForTimeout(200);
  await textarea(page).fill('P1-B deleted attachment scenario');
  await send(page);
  const uploads = requests.filter((entry) => entry.kind === 'attachment');
  const messages = requests.filter((entry) => entry.kind === 'message');
  record({ scenario: 'delete', side: SIDE, uploads, messages });
  check('removing the file prevents its upload', uploads.length === 0, `uploads=${uploads.length}`);
  check(
    'the message carries no attachmentIds',
    messages.every((entry) => (entry.body?.attachmentIds ?? []).length === 0),
    JSON.stringify(messages.map((entry) => entry.body)),
  );
  await session.context.close();
}

async function scenarioUploadRetry() {
  console.log('\n## scenario 5: failed upload retries only in the same conversation');
  const session = await openPage();
  const { page, requests } = session;
  let aborted = false;
  await page.route(`**/api/v1/conversations/${CONVERSATION_B}/attachments`, async (route) => {
    if (!aborted) {
      aborted = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await openConversation(page, CONVERSATION_B);
  await attach(page, 'p1b-retry-b.txt');
  await textarea(page).fill('P1-B retry scenario');
  await sendButton(page).click();
  await page.waitForTimeout(1200);
  const failureVisible = await page.getByText('附件上传失败', { exact: false }).count();
  await shot(page, 'upload-failed');
  await send(page);
  const uploads = requests.filter((entry) => entry.kind === 'attachment');
  const messages = requests.filter((entry) => entry.kind === 'message');
  record({ scenario: 'retry', side: SIDE, failureVisible, uploads, messages });
  check(
    'the failed upload reports an attachment error',
    failureVisible > 0,
    `count=${failureVisible}`,
  );
  check(
    'both upload attempts target the same conversation (raw URLs)',
    uploads.length === 2 && uploads.every((entry) => entry.conversationId === CONVERSATION_B),
    JSON.stringify(uploads.map((entry) => entry.url)),
  );
  check(
    'the retried message carries exactly the retried attachment',
    messages.length === 1 && (messages[0].body?.attachmentIds ?? []).length === 1,
    JSON.stringify(messages.map((entry) => entry.body)),
  );
  await session.context.close();
}

async function scenarioEditKeepsAttachments() {
  console.log('\n## scenario 6: editing text and switching back keep the conversation binding');
  const session = await openPage();
  const { page } = session;
  await openConversation(page, CONVERSATION_A);
  await attach(page, 'p1b-edit-a.txt');
  await textarea(page).fill('draft text');
  await openConversation(page, CONVERSATION_B);
  const inB = await chipCount(page, 'p1b-edit-a.txt');
  await openConversation(page, CONVERSATION_A);
  const backInA = await chipCount(page, 'p1b-edit-a.txt');
  await textarea(page).fill('draft text edited');
  const afterEdit = await chipCount(page, 'p1b-edit-a.txt');
  record({ scenario: 'edit', side: SIDE, inB, backInA, afterEdit });
  check("the other conversation does not show A's attachment", inB === 0, `count=${inB}`);
  check('returning to A restores its own attachment selection', backInA > 0, `count=${backInA}`);
  check(
    'editing the text does not disturb the selected attachment',
    afterEdit > 0,
    `count=${afterEdit}`,
  );
  await session.context.close();
}

try {
  await scenarioSwitch();
  await scenarioLateResponse();
  await scenarioSameConversation();
  await scenarioDeletedFile();
  await scenarioUploadRetry();
  await scenarioEditKeepsAttachments();
} finally {
  await browser.close();
  writeFileSync(
    resolve(OUT, `${SIDE}-records.json`),
    `${JSON.stringify({ side: SIDE, checks, records }, null, 2)}\n`,
  );
}

for (const entry of checks) {
  if (!entry.ok) failed.push(entry.name);
}
console.log(`\n## verdict: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`failed checks:\n- ${failed.join('\n- ')}`);
  process.exitCode = 1;
}
