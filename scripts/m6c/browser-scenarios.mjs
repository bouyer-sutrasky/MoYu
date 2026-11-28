#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertAllowedPath, fail, parseArgs, printHelpAndExit, writeJson } from './lib.mjs';

const HELP = [
  '--base-url <url>         MoYu origin, for example https://moyu-m6c.117-72-211-55.sslip.io',
  '--storage-state <file>   Playwright storage-state JSON with a logged-in cookie (required)',
  '--repository-a <uuid>    first repository id (required)',
  '--repository-b <uuid>    second repository id (required for the switch race)',
  '--out <dir>              evidence directory (required)',
  '--allow-production       allow https://moyu.sutrasky.com',
  '--headed                 show the browser (default: headless)',
  '--help                   show this help without launching a browser',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help) {
  printHelpAndExit('Run the M6-C settings/home browser acceptance scenarios', HELP, [
    'node scripts/m6c/browser-scenarios.mjs --base-url https://moyu-m6c.117-72-211-55.sslip.io --storage-state /root/m6c-evidence/storage.json --repository-a <a> --repository-b <b> --out /root/m6c-evidence/browser',
  ]);
}
for (const key of ['base-url', 'storage-state', 'repository-a', 'out']) {
  if (!values[key]) fail(`browser-scenarios: --${key} is required`, 2);
}
const baseUrl = new URL(String(values['base-url']));
if (baseUrl.protocol !== 'https:') fail('browser-scenarios: base URL must be HTTPS', 2);
if (baseUrl.hostname === 'moyu.sutrasky.com' && values['allow-production'] !== true) {
  fail('browser-scenarios: production origin needs --allow-production', 2);
}
const storageState = assertAllowedPath(resolve(String(values['storage-state'])), 'storage state');
const out = resolve(String(values.out));
mkdirSync(out, { recursive: true, mode: 0o700 });
const repositoryA = String(values['repository-a']);
const repositoryB = values['repository-b'] ? String(values['repository-b']) : null;

let playwright;
try {
  playwright = await import('playwright');
} catch {
  fail('browser-scenarios: playwright is not installed in this workspace', 2);
}

const record = {
  baseUrl: baseUrl.toString(),
  startedAt: new Date().toISOString(),
  scenarios: [],
  failures: [],
  requests: [],
  screenshots: [],
};
const browser = await playwright.chromium.launch({ headless: values.headed !== true });
try {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/repositories/') || url.includes('/api/v1/conversations')) {
      record.requests.push({ at: new Date().toISOString(), method: request.method(), url });
    }
  });
  page.on('pageerror', (error) => record.failures.push(`pageerror: ${error.message}`));

  const shot = async (name) => {
    const path = join(out, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    record.screenshots.push(path);
  };
  const checkWidth = async (name) => {
    const width = await page.evaluate(() => ({
      scrollWidth: document.querySelector('main:not([hidden])').scrollWidth,
      clientWidth: document.querySelector('main:not([hidden])').clientWidth,
    }));
    if (width.scrollWidth > width.clientWidth + 1) {
      record.failures.push(
        `${name}: horizontal overflow ${width.scrollWidth} > ${width.clientWidth}`,
      );
    }
    return width;
  };
  const openSuperagent = async () => {
    const sidebar = page.getByRole('complementary', { name: '工作台导航' });
    await sidebar.getByRole('button', { name: 'SuperAgent', exact: true }).click();
    await page
      .getByRole('main')
      .getByRole('heading', { name: 'SuperAgent', exact: true })
      .waitFor();
    await page.locator('#superagent-repository').waitFor({ state: 'visible', timeout: 15_000 });
  };
  const chooseRepo = async (repositoryId) => {
    await page.locator('#superagent-repository').selectOption(repositoryId);
    await page.waitForTimeout(700);
  };
  const clickGroup = async (label) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(400);
  };

  await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot('home-1440-light');
  record.scenarios.push({ name: 'home-1440-light', width: await checkWidth('home-1440-light') });

  const desktopSidebar = page.getByRole('complementary', { name: '工作台导航' });
  await desktopSidebar.getByRole('button', { name: '仓库', exact: true }).click();
  const repositoryPage = page.getByRole('main');
  await repositoryPage.getByRole('heading', { name: '仓库', exact: true }).waitFor();
  await repositoryPage
    .getByRole('navigation', { name: '已接入仓库' })
    .locator('[aria-current="page"]')
    .waitFor();
  await shot('repositories-1440-light');
  record.scenarios.push({
    name: 'repositories-1440-light',
    width: await checkWidth('repositories-1440-light'),
  });

  await openSuperagent();
  await chooseRepo(repositoryA);
  await clickGroup('来源');
  await shot('settings-source-a');
  record.scenarios.push({ name: 'settings-source-a' });
  for (const [group, name] of [
    ['评估', 'settings-eval-a'],
    ['执行', 'settings-execution-a'],
    ['提示词', 'settings-prompts-a'],
    ['部署', 'settings-deployment-a'],
  ]) {
    await clickGroup(group);
    await shot(name);
    record.scenarios.push({ name, width: await checkWidth(name) });
  }

  // Switch repositories and assert every settings request after the switch
  // targets B, not A. This is the browser half of the instance isolation test.
  const switchedAt = record.requests.length;
  await chooseRepo(repositoryB ?? repositoryA);
  await clickGroup('来源');
  await page.waitForTimeout(700);
  await shot('settings-source-b');
  const afterSwitch = record.requests.slice(switchedAt);
  const wrongRepository = afterSwitch.find(
    (entry) =>
      entry.url.includes(`/repositories/${repositoryA}/superagent/`) &&
      (repositoryB ?? repositoryA) !== repositoryA,
  );
  if (wrongRepository) {
    record.failures.push(`A->B switch still requested A: ${wrongRepository.url}`);
  }
  record.scenarios.push({
    name: 'repository-switch',
    afterSwitchRequests: afterSwitch.length,
    wrongRepository: wrongRepository?.url ?? null,
  });

  // Keyboard reachability: tab inside the SuperAgent page and record the focused
  // control without relying on a visible mouse cursor.
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    return element
      ? {
          tag: element.tagName,
          text: (element.textContent ?? '').trim().slice(0, 80),
          ariaLabel: element.getAttribute('aria-label'),
        }
      : null;
  });
  record.scenarios.push({ name: 'keyboard-focus', focused });
  await context.close();

  const mobile = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    isMobile: true,
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on('pageerror', (error) => record.failures.push(`mobile pageerror: ${error.message}`));
  await mobilePage.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await mobilePage.waitForTimeout(1200);
  const mobileMain = mobilePage.getByRole('main');
  const mobileSidebar = mobilePage.getByRole('complementary', { name: '工作台导航' });
  const mobileSnapshot = async (name) => {
    const width = await mobileMain.evaluate((main) => ({
      scrollWidth: main.scrollWidth,
      clientWidth: main.clientWidth,
    }));
    if (width.scrollWidth > width.clientWidth + 1) {
      record.failures.push(
        `${name}: horizontal overflow ${width.scrollWidth} > ${width.clientWidth}`,
      );
    }
    const path = join(out, `${name}.png`);
    await mobilePage.screenshot({ path, fullPage: true });
    record.screenshots.push(path);
    record.scenarios.push({ name, width });
  };
  await mobileSnapshot('home-390-dark');
  const openMobilePage = async (label) => {
    await mobilePage.getByRole('button', { name: '打开导航' }).click();
    await mobileSidebar.getByRole('button', { name: label, exact: true }).click();
    await mobileSidebar.waitFor({ state: 'hidden' });
    await mobileMain.getByRole('heading', { name: label, exact: true }).waitFor();
  };
  await openMobilePage('仓库');
  await mobileMain
    .getByRole('navigation', { name: '已接入仓库' })
    .locator('[aria-current="page"]')
    .waitFor();
  await mobileSnapshot('repositories-390-dark');
  await openMobilePage('SuperAgent');
  await mobileMain.getByRole('button', { name: '部署', exact: true }).click();
  await mobileMain.getByRole('heading', { name: '部署', exact: true }).waitFor();
  await mobileSnapshot('superagent-390-dark');
  await mobile.close();
} catch (error) {
  record.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages[0];
    if (page) {
      const path = join(out, 'failure.png');
      await page.screenshot({ path, fullPage: true });
      record.screenshots.push(path);
    }
  } catch {
    // Best effort evidence only.
  }
} finally {
  await browser.close();
  record.finishedAt = new Date().toISOString();
  record.ok = record.failures.length === 0;
  writeJson(join(out, 'result.json'), record);
  writeFileSync(join(out, 'requests.json'), `${JSON.stringify(record.requests, null, 2)}\n`, {
    mode: 0o600,
  });
}

process.stdout.write(
  `${JSON.stringify({
    ok: record.ok,
    out,
    scenarios: record.scenarios.length,
    screenshots: record.screenshots.length,
    failures: record.failures,
  })}\n`,
);
process.exit(record.ok ? 0 : 1);
