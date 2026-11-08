#!/usr/bin/env node
/**
 * L117 browser checks: create a new task from a finished one through the real
 * Web app and API. Asserts the confirmation gate (no POST before confirming),
 * the explicit inheritance shown, closed_unmerged wording with no reopen
 * request, cleaned-worktree warning, cross-repository selection, double-click
 * idempotency and the new independent conversation/task identity.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const REPOSITORY = process.env.M6A_REPOSITORY ?? 'Bouyer12/l117-source';
const SEED = JSON.parse(readFileSync(process.env.M6A_SEED, 'utf8'));
const OUT = resolve(process.env.M6A_OUT ?? 'docs/evidence/m6a');
if (!BASE || !TOKEN || !SEED)
  throw new Error('M6A_AFTER_URL, M6A_SESSION_TOKEN and M6A_SEED are required');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'light',
});
await context.addCookies([{ name: 'moyu_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const createdResponses = [];
const reopenRequests = [];
page.on('request', (request) => {
  if (/reopen/i.test(request.url())) reopenRequests.push(`${request.method()} ${request.url()}`);
});
page.on('response', async (response) => {
  if (response.request().method() === 'POST' && /\/new-task$/.test(response.url())) {
    createdResponses.push({
      status: response.status(),
      body: await response.json().catch(() => null),
    });
  }
});

async function openConversation(title) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { timeout: 30_000 });
  await page.waitForTimeout(400);
  const options = await page.locator('select').first().locator('option').allTextContents();
  const match = options.find((option) => option.includes(REPOSITORY));
  if (!match) throw new Error(`repository option not found: ${REPOSITORY}`);
  await page.locator('select').first().selectOption({ label: match });
  await page.waitForTimeout(500);
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(700);
}

async function openDialog() {
  await page.locator('[data-testid="new-task-from-task"]').click();
  await page.waitForSelector('[data-testid="new-task-from-task-dialog"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  return page.locator('[data-testid="new-task-source"]');
}

try {
  // 1 + 2 + 4 + 5: completed task, explicit inheritance, confirmation gate, cross-repository choice.
  await openConversation(SEED.tasks.completed.title);
  check(
    'completed-shows-action',
    (await page.locator('[data-testid="new-task-from-task"]').count()) === 1,
    { count: 1 },
  );
  const before = createdResponses.length;
  const sourceBox = await openDialog();
  const sourceText = await sourceBox.textContent();
  check(
    'preview-shows-inheritance',
    sourceText.includes(SEED.tasks.completed.taskId) &&
      sourceText.includes('https://github.com/Bouyer12/l117-source/pull/7') &&
      sourceText.includes('delivered summary for completed') &&
      sourceText.includes('不会重开原 PR') &&
      sourceText.includes('不是原现场恢复') &&
      sourceText.includes('独立执行身份'),
    { text: sourceText.slice(0, 500) },
  );
  const options = await page
    .locator('[data-testid="new-task-repository"] option')
    .allTextContents();
  check(
    'target-repositories-owned-only',
    options.some((label) => label.includes('Bouyer12/l117-source')) &&
      options.some((label) => label.includes('Bouyer12/l117-target')) &&
      !options.some((label) => label.includes('someone/l117-foreign')),
    options,
  );
  check('no-post-before-confirm', createdResponses.length === before, {
    postsBeforeConfirm: createdResponses.length - before,
  });
  await page.screenshot({ path: resolve(OUT, 'after-desktop-l117-confirm-dialog.png') });

  // Cross-repository selection updates the start point to that repository's default branch.
  const targetValue = await page
    .locator('[data-testid="new-task-repository"] option')
    .evaluateAll((nodes) => {
      const match = nodes.find((node) => (node.textContent ?? '').includes('l117-target'));
      return match ? match.value : '';
    });
  await page.locator('[data-testid="new-task-repository"]').selectOption(targetValue);
  await page.waitForTimeout(300);
  const branch = await page.locator('[data-testid="new-task-branch"]').inputValue();
  check('cross-repo-start-point', branch === 'trunk', { branch });
  const createResponse = page
    .waitForResponse(
      (response) => response.request().method() === 'POST' && /\/new-task$/.test(response.url()),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await page.locator('[data-testid="new-task-confirm"]').click();
  const response = await createResponse;
  const body = response ? await response.json() : null;
  check(
    'create-201',
    response?.status() === 201 && body?.data?.inheritance?.reopensPullRequest === false,
    { status: response?.status(), body },
  );
  const created = body?.data;
  check(
    'new-independent-identity',
    created?.conversation?.id !== SEED.tasks.completed.conversationId &&
      created?.conversation?.task?.id !== SEED.tasks.completed.taskId &&
      created?.executionIdentity?.upstreamTicketId === null &&
      created?.executionIdentity?.reusesSourceSession === false,
    created?.executionIdentity,
  );
  check(
    'new-task-target-repository',
    created?.conversation?.repositoryId === SEED.targetRepositoryId,
    {
      repositoryId: created?.conversation?.repositoryId,
      taskRepositoryId: created?.conversation?.task?.repositoryId,
    },
  );
  await page.waitForTimeout(800);
  const heading = await page.locator('h1').first().textContent();
  check('new-conversation-opened', (heading ?? '').includes('基于'), { heading });
  await page.screenshot({ path: resolve(OUT, 'after-desktop-l117-created.png') });

  // 5: double click reuses the same request id and produces one POST.
  await openConversation(SEED.tasks.completed.title);
  await openDialog();
  const postsBeforeDouble = createdResponses.length;
  await page.locator('[data-testid="new-task-confirm"]').evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForTimeout(1500);
  const newPosts = createdResponses.slice(postsBeforeDouble);
  const conversations = new Set(
    newPosts.map((entry) => entry.body?.data?.conversation?.id).filter(Boolean),
  );
  const statuses = newPosts.map((entry) => entry.status).sort();
  check(
    'double-click-idempotent',
    newPosts.length === 2 && statuses[0] === 200 && statuses[1] === 201 && conversations.size === 1,
    { newPosts: newPosts.length, statuses, conversations: [...conversations] },
  );

  // 3: closed_unmerged wording, no reopen request, not labelled a scene restore.
  await openConversation(SEED.tasks.closed.title);
  const closedBox = await openDialog();
  const closedText = await closedBox.textContent();
  check(
    'closed-unmerged-recovery',
    closedText.includes('原 PR 已关闭未合并') &&
      closedText.includes('不会重新打开原 PR') &&
      closedText.includes('不是恢复原现场'),
    {
      text: closedText.slice(0, 400),
    },
  );
  check('no-reopen-request', reopenRequests.length === 0, reopenRequests);
  await page.screenshot({ path: resolve(OUT, 'after-desktop-l117-closed-unmerged.png') });
  await page.getByRole('button', { name: '取消' }).first().click();

  // 4: cleaned worktree still allows creation and says the old scene is gone.
  await openConversation(SEED.tasks.cleaned.title);
  const cleanedBox = await openDialog();
  const cleanedText = await cleanedBox.textContent();
  check(
    'cleaned-worktree-warning',
    cleanedText.includes('旧现场不可恢复') && cleanedText.includes('def5678'),
    { text: cleanedText.slice(0, 400) },
  );
  await page.getByRole('button', { name: '取消' }).first().click();

  // 6: a running task has no action; a foreign repository is not selectable (API test asserts the refusal).
  await openConversation(SEED.tasks.running.title);
  check(
    'running-has-no-action',
    (await page.locator('[data-testid="new-task-from-task"]').count()) === 0,
    { count: 0 },
  );
  await page.screenshot({ path: resolve(OUT, 'after-desktop-l117-running.png') });
} catch (error) {
  check('l117-flow', false, { error: String(error) });
} finally {
  await context.close();
  await browser.close();
}

const total = 13;
console.log(
  `RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'} passed=${total - failures.length}/${total} failed=${JSON.stringify(failures)}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
