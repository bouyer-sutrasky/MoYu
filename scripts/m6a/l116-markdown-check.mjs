#!/usr/bin/env node
/**
 * L116 browser checks for safe Markdown messages. Runs against the built Web app
 * served by an isolated API (env: M6A_AFTER_URL, M6A_SESSION_TOKEN,
 * M6A_CONVERSATION_ID, M6A_REPOSITORY, M6A_OUT). It prints the raw DOM, clipboard
 * and overflow values it asserted, and exits non-zero when any group fails.
 */
/* global document, navigator, window */
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

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ headless: true });

async function open(viewport) {
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
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
  await page.waitForSelector('article[data-message-id]', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return { context, page };
}

function messageBody(page, marker) {
  return page.locator('article[data-message-id]', { hasText: marker }).first();
}

try {
  const { context, page } = await open({ width: 1440, height: 900 });

  // 1. XSS: nothing executes, no raw HTML nodes, dangerous schemes never become anchors.
  const xss = messageBody(page, 'L116-XSS');
  const xssState = await page.evaluate(() => ({
    pwn: typeof window.__pwn,
    scripts: document.querySelectorAll('article[data-message-id] script').length,
    iframes: document.querySelectorAll('article[data-message-id] iframe').length,
    imgs: document.querySelectorAll('article[data-message-id] img').length,
  }));
  const anchors = await xss
    .locator('a')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ href: node.getAttribute('href'), text: node.textContent })),
    );
  check('xss-window-not-set', xssState.pwn === 'undefined', xssState);
  check(
    'xss-no-script-iframe-img',
    xssState.scripts + xssState.iframes + xssState.imgs === 0,
    xssState,
  );
  check(
    'xss-only-safe-anchor',
    anchors.length === 1 && anchors[0].href === 'https://example.com/safe',
    anchors,
  );
  check(
    'xss-dangerous-shown-as-text',
    (await xss.textContent()).includes('危险1') && (await xss.textContent()).includes('危险2'),
    (await xss.textContent()).slice(0, 200),
  );
  await xss.screenshot({ path: resolve(OUT, 'after-desktop-l116-xss.png') });

  // 2. Markdown semantics.
  const md = messageBody(page, 'L116-MD');
  const semantics = await md.evaluate((node) => ({
    h1: node.querySelectorAll('h1').length,
    strong: node.querySelectorAll('strong').length,
    inlineCode: node.querySelectorAll('code.mdInlineCode').length,
    ul: node.querySelectorAll('ul > li').length,
    ol: node.querySelectorAll('ol > li').length,
    tableHeaders: node.querySelectorAll('table th').length,
    tableCells: node.querySelectorAll('table td').length,
    preCode: node.querySelectorAll('pre > code').length,
    safeLink:
      node.querySelector('a[href="https://example.com/page"]')?.getAttribute('href') ?? null,
  }));
  check(
    'markdown-semantic-elements',
    semantics.h1 > 0 &&
      semantics.strong > 0 &&
      semantics.inlineCode > 0 &&
      semantics.ul >= 2 &&
      semantics.ol >= 2 &&
      semantics.tableHeaders >= 2 &&
      semantics.tableCells >= 4 &&
      semantics.preCode > 0 &&
      semantics.safeLink === 'https://example.com/page',
    semantics,
  );
  await md.screenshot({ path: resolve(OUT, 'after-desktop-l116-markdown.png') });

  // 3. Copy keeps the code block byte for byte.
  try {
    const copyBlock = md.locator('[data-testid="md-code-block"]').first();
    await copyBlock.locator('[data-testid="md-copy"]').click({ timeout: 5_000 });
    await page.waitForTimeout(200);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const expected =
      process.env.M6A_EXPECTED_CODE ??
      'const total = 1 + 2;\n\tif (total > 2) {\n\t\tconsole.log("ok");\n\t}';
    check('copy-byte-identical', copied === expected, { copied, expected });
  } catch (error) {
    check('copy-byte-identical', false, { error: String(error) });
  }

  // 4. Long log folds, keeps every byte, and expands again; the page never scrolls sideways.
  try {
    const log = messageBody(page, 'L116-LOG').locator('[data-testid="md-code-body"]').first();
    const folded = await log.evaluate((node) => ({
      folded: node.getAttribute('data-folded'),
      text: node.textContent,
      height: node.getBoundingClientRect().height,
      length: (node.textContent ?? '').length,
    }));
    check('log-folded-bounded', folded.folded === 'true' && folded.height <= 280, {
      folded: folded.folded,
      height: folded.height,
      length: folded.length,
    });
    await messageBody(page, 'L116-LOG').screenshot({
      path: resolve(OUT, 'after-desktop-l116-log-folded.png'),
    });
    await messageBody(page, 'L116-LOG').getByRole('button', { name: /^展开/ }).click();
    await page.waitForTimeout(200);
    const expanded = await log.evaluate((node) => ({
      folded: node.getAttribute('data-folded'),
      text: node.textContent,
      height: node.getBoundingClientRect().height,
    }));
    check(
      'log-expanded-content-identical',
      expanded.folded === 'false' &&
        expanded.text === folded.text &&
        expanded.height > folded.height,
      { before: folded.height, after: expanded.height, sameText: expanded.text === folded.text },
    );
    const desktopOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    check(
      'desktop-no-page-overflow',
      desktopOverflow.scrollWidth <= desktopOverflow.clientWidth,
      desktopOverflow,
    );
  } catch (error) {
    check('log-fold-groups', false, { error: String(error) });
  }
  // 6. A plain message keeps its line breaks and text.
  try {
    const plain = await messageBody(page, 'L116-PLAIN').textContent();
    check('plain-text-preserved', plain.includes('第一行') && plain.includes('第二行'), { plain });
  } catch (error) {
    check('plain-text-preserved', false, { error: String(error) });
  }
  await context.close();

  // 5. Phone: a long code line and a wide table must scroll inside their bubble, not the page.
  try {
    const mobile = await open({ width: 390, height: 844 });
    const mobileOverflow = await mobile.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    check(
      'mobile-no-page-overflow',
      mobileOverflow.scrollWidth <= mobileOverflow.clientWidth &&
        mobileOverflow.bodyScrollWidth <= mobileOverflow.clientWidth,
      mobileOverflow,
    );
    await messageBody(mobile.page, 'L116-LOG').scrollIntoViewIfNeeded();
    await mobile.page.screenshot({
      path: resolve(OUT, 'after-mobile-l116-overflow.png'),
      fullPage: true,
    });
    await mobile.context.close();
  } catch (error) {
    check('mobile-no-page-overflow', false, { error: String(error) });
  }
} finally {
  await browser.close();
}

const total = 8;
console.log(
  `RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'} passed=${total - failures.length}/${total} failed=${JSON.stringify(failures)}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
