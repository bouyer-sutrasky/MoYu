import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';

const { Client } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(repoRoot, 'docs/evidence/m2');
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const baseUrl = (process.env.E2E_BASE_URL ?? 'https://moyu.sutrasky.com').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const rpId = process.env.E2E_RP_ID ?? new URL(baseUrl).hostname;
const apiPort = Number(process.env.E2E_API_PORT ?? 4300);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, env) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API did not become healthy at ${url}: ${lastError?.message ?? 'timeout'}`);
}

async function createDatabase() {
  assert(adminUrl, 'TEST_DATABASE_ADMIN_URL is required for the M2 browser acceptance run.');
  const name = `moyu_e2e_${process.pid}_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropDatabase(name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function attachVirtualAuthenticator(context, page) {
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

async function fetchJson(page, requestPath, options = {}) {
  return page.evaluate(
    async ({ requestPath: target, options: requestOptions }) => {
      const response = await fetch(target, requestOptions);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    { requestPath, options },
  );
}

async function openSettings(page) {
  const sidebar = page.getByLabel('工作台导航');
  await sidebar.getByRole('button', { name: '设置' }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

async function setTheme(page, label) {
  const dialog = await openSettings(page);
  await dialog.getByRole('group', { name: '主题' }).getByRole('button', { name: label }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await dialog.waitFor({ state: 'detached' });
}

async function signInWithPasskey(page, capture) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const loginButton = page.getByRole('button', { name: /使用 Passkey 登录/ });
  await loginButton.waitFor({ state: 'visible', timeout: 20_000 });

  const onRequest = (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/v1/auth/login/verify'
    ) {
      try {
        capture.value = request.postDataJSON();
      } catch {
        /* The body is always JSON for this route; keep the last valid one. */
      }
    }
  };
  page.on('request', onRequest);
  try {
    await loginButton.click();
    await page.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 20_000 });
  } finally {
    page.off('request', onRequest);
  }
}

async function takeScreenshot(page, fileName) {
  await page.waitForTimeout(450);
  await page.screenshot({
    path: path.join(evidenceDir, fileName),
    animations: 'disabled',
  });
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const database = await createDatabase();
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'moyu-e2e-attachments-'));
  let api = null;
  let browser = null;
  const serverLog = [];
  const checks = {};
  const screenshots = [];

  try {
    run('pnpm', ['--filter', '@moyu/db', 'db:migrate'], {
      DATABASE_URL: database.url,
    });

    const bootstrapOutput = run('pnpm', ['--filter', '@moyu/api', 'auth:bootstrap'], {
      DATABASE_URL: database.url,
      AUTH_BOOTSTRAP_TTL_MINUTES: '10',
    });
    const codeMatch = bootstrapOutput.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    assert(codeMatch, 'The binding code CLI did not print a usable code.');
    const bindingCode = codeMatch[0];

    api = spawn(process.execPath, ['apps/api/dist/server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        API_HOST: '127.0.0.1',
        API_PORT: String(apiPort),
        LOG_LEVEL: 'info',
        DATABASE_URL: database.url,
        WEBAUTHN_ORIGIN: origin,
        WEBAUTHN_RP_ID: rpId,
        AUTH_CHALLENGE_TTL_SECONDS: '300',
        AUTH_BOOTSTRAP_TTL_MINUTES: '10',
        ARTIFACT_STORAGE_DIR: artifactDir,
        WEB_DIST_DIR: path.join(repoRoot, 'apps/web/dist'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
    api.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
    await waitForHealth(`http://127.0.0.1:${apiPort}`);
    await waitForHealth(baseUrl);
    checks.publicHttps = true;

    browser = await chromium.launch({ headless: true });
    const contextA = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'zh-CN',
    });
    const pageA = await contextA.newPage();
    const authenticatorA = await attachVirtualAuthenticator(contextA, pageA);

    await pageA.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: '完成首次登记' }).waitFor({ timeout: 20_000 });
    checks.initialSetupPage = true;

    await pageA.locator('#bootstrap-code').fill(bindingCode);
    await pageA.getByRole('button', { name: '验证绑定码' }).click();
    await pageA.getByRole('button', { name: '创建 Passkey' }).waitFor({ timeout: 20_000 });
    await pageA.locator('#passkey-label').fill('E2E virtual authenticator');
    await pageA.getByRole('button', { name: '创建 Passkey' }).click();
    await pageA.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
    checks.firstBinding = true;

    const stateAfterBinding = await fetchJson(pageA, '/api/v1/auth/state');
    assert(stateAfterBinding.body?.data?.initialized === true, 'Initialization did not complete.');
    assert(stateAfterBinding.body.data.setupOpen === false, 'Setup entry stayed open.');
    checks.setupClosedAfterBinding = true;

    const cookies = await contextA.cookies(baseUrl);
    const sessionCookie = cookies.find((cookie) => cookie.name.includes('session'));
    assert(sessionCookie, 'No session cookie was set after registration.');
    assert(sessionCookie.httpOnly, 'Session cookie is not HttpOnly.');
    assert(sessionCookie.secure, 'Session cookie is not Secure on the https origin.');
    assert(sessionCookie.sameSite === 'Lax', 'Session cookie SameSite is not Lax.');
    checks.sessionCookieAttributes = true;

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 20_000 });
    checks.refreshKeepsLogin = true;

    const anonymousContext = await browser.newContext({
      viewport: { width: 1100, height: 760 },
      colorScheme: 'light',
      locale: 'zh-CN',
    });
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(`${baseUrl}/setup`, { waitUntil: 'domcontentloaded' });
    await anonymousPage.getByRole('heading', { name: '初始化已完成' }).waitFor({ timeout: 20_000 });
    checks.setupEntryClosed = true;
    await anonymousContext.close();

    const db = new Client({ connectionString: database.url });
    await db.connect();
    let artifactId = '';
    try {
      const ownerResult = await db.query('select id from owners order by created_at limit 1');
      assert(ownerResult.rows[0], 'No owner row exists after registration.');
      const repositoryResult = await db.query(
        `insert into repositories (owner_id, full_name, default_branch, status)
         values ($1, $2, $3, $4) returning id`,
        [ownerResult.rows[0].id, 'bouyer-sutrasky/MoYu', 'main', 'provisioning'],
      );
      const content = 'MoYu M2 protected attachment fixture';
      await writeFile(path.join(artifactDir, 'e2e-attachment.txt'), content, 'utf8');
      const artifactResult = await db.query(
        `insert into artifacts (repository_id, type, storage_key, mime_type, size_bytes, sha256)
         values ($1, 'attachment', $2, 'text/plain', $3, $4) returning id`,
        [
          repositoryResult.rows[0].id,
          'e2e-attachment.txt',
          Buffer.byteLength(content),
          'e2e-fixture',
        ],
      );
      artifactId = artifactResult.rows[0].id;
    } finally {
      await db.end();
    }

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const repositorySelect = pageA.getByRole('combobox', { name: '选择仓库' });
    await repositorySelect.waitFor({ state: 'visible', timeout: 20_000 });
    const selectedRepository = await repositorySelect.inputValue();
    assert(selectedRepository, 'The seeded repository was not selectable.');

    await setTheme(pageA, '浅色');
    const detailsToggle = pageA.getByRole('button', { name: /展开右侧详情|收起右侧详情/ });
    if ((await pageA.getByLabel('会话详情').getAttribute('aria-hidden')) === 'true') {
      await detailsToggle.click();
    }
    await pageA.getByLabel('会话详情').waitFor({ state: 'visible' });
    await takeScreenshot(pageA, 'after-desktop-light.png');
    screenshots.push('docs/evidence/m2/after-desktop-light.png');

    await setTheme(pageA, '深色');
    await takeScreenshot(pageA, 'after-desktop-dark.png');
    screenshots.push('docs/evidence/m2/after-desktop-dark.png');

    if ((await pageA.getByLabel('会话详情').getAttribute('aria-hidden')) === 'false') {
      await pageA.getByRole('button', { name: '收起右侧详情' }).click();
    }
    await setTheme(pageA, '浅色');
    await pageA.setViewportSize({ width: 390, height: 844 });
    await pageA.getByRole('button', { name: '打开导航' }).click();
    await pageA.getByLabel('工作台导航').waitFor({ state: 'visible' });
    await takeScreenshot(pageA, 'after-mobile-light.png');
    screenshots.push('docs/evidence/m2/after-mobile-light.png');

    await setTheme(pageA, '深色');
    await pageA.getByRole('button', { name: '展开右侧详情' }).click();
    await pageA.getByLabel('会话详情').waitFor({ state: 'visible' });
    await takeScreenshot(pageA, 'after-mobile-dark.png');
    screenshots.push('docs/evidence/m2/after-mobile-dark.png');

    await pageA.setViewportSize({ width: 1440, height: 900 });
    await setTheme(pageA, '浅色');

    const meA = await fetchJson(pageA, '/api/v1/auth/me');
    assert(meA.status === 200, 'The first browser session is not authenticated.');
    const sessionAId = meA.body.data.session.id;

    const contextB = await browser.newContext({
      viewport: { width: 1200, height: 820 },
      colorScheme: 'light',
      locale: 'zh-CN',
    });
    const pageB = await contextB.newPage();
    const authenticatorB = await attachVirtualAuthenticator(contextB, pageB);
    const exported = await authenticatorA.client.send('WebAuthn.getCredentials', {
      authenticatorId: authenticatorA.authenticatorId,
    });
    assert(exported.credentials.length > 0, 'The virtual authenticator exported no credentials.');
    for (const credential of exported.credentials) {
      await authenticatorB.client.send('WebAuthn.addCredential', {
        authenticatorId: authenticatorB.authenticatorId,
        credential,
      });
    }

    const capturedVerify = { value: null };
    await signInWithPasskey(pageB, capturedVerify);
    assert(capturedVerify.value, 'The login verify request body was not captured.');
    checks.passkeyLogin = true;

    const replay = await pageB.evaluate(async (body) => {
      const response = await fetch('/api/v1/auth/login/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload };
    }, capturedVerify.value);
    assert(
      replay.status === 409,
      `Replayed ceremony returned HTTP ${replay.status}, expected 409.`,
    );
    assert(
      replay.payload?.error?.code === 'conflict',
      'Replayed ceremony did not return the conflict envelope.',
    );
    checks.challengeReplayRejected = true;

    const meB = await fetchJson(pageB, '/api/v1/auth/me');
    assert(meB.status === 200, 'The second browser session is not authenticated.');

    const settingsB = await openSettings(pageB);
    const credentialRow = settingsB
      .locator('li')
      .filter({ hasText: 'E2E virtual authenticator' })
      .first();
    await credentialRow.waitFor({ state: 'visible', timeout: 15_000 });
    const addLabel = 'E2E secondary passkey';
    await settingsB.getByLabel('新 Passkey 标签').fill(addLabel);
    await settingsB.getByRole('button', { name: '添加 Passkey' }).click();
    await settingsB
      .getByText('新的 Passkey 已登记。')
      .waitFor({ state: 'visible', timeout: 25_000 });
    const secondaryRow = settingsB.locator('li').filter({ hasText: addLabel }).first();
    await secondaryRow.waitFor({ state: 'visible', timeout: 15_000 });
    checks.addPasskey = true;

    await secondaryRow.getByRole('button', { name: '撤销' }).click();
    await secondaryRow.getByRole('button', { name: '确认撤销' }).click();
    await settingsB
      .getByText('Passkey 已撤销，相关浏览器会话已同时撤销。')
      .waitFor({ state: 'visible', timeout: 15_000 });
    await settingsB.locator('li').filter({ hasText: addLabel }).waitFor({ state: 'detached' });
    checks.revokePasskey = true;

    const remainingRow = settingsB
      .locator('li')
      .filter({ hasText: 'E2E virtual authenticator' })
      .first();
    assert(
      await remainingRow.getByRole('button', { name: '撤销' }).isDisabled(),
      'The last passkey revoke button is not disabled.',
    );
    checks.lastPasskeyProtected = true;

    await settingsB.getByRole('button', { name: '关闭', exact: true }).last().click();
    await settingsB.waitFor({ state: 'detached' });

    await pageA.evaluate(() => {
      window.__moyuSse = { open: false, revoked: false, error: false };
      const source = new EventSource('/api/v1/events');
      window.__moyuSse.source = source;
      source.onopen = () => {
        window.__moyuSse.open = true;
      };
      source.addEventListener('session.revoked', () => {
        window.__moyuSse.revoked = true;
      });
      source.onerror = () => {
        window.__moyuSse.error = true;
      };
    });
    await pageA.waitForFunction(() => window.__moyuSse?.open === true, null, { timeout: 15_000 });
    checks.sseConnected = true;

    const attachmentBefore = await pageA.evaluate(async (id) => {
      const response = await fetch(`/api/v1/attachments/${id}`);
      return { status: response.status, text: await response.text() };
    }, artifactId);
    assert(attachmentBefore.status === 200, 'Attachment was not readable before revocation.');
    assert(
      attachmentBefore.text === 'MoYu M2 protected attachment fixture',
      'Attachment content mismatch.',
    );
    checks.attachmentBeforeRevocation = true;

    const settingsRevoke = await openSettings(pageB);
    await settingsRevoke.getByRole('heading', { name: '浏览器会话' }).waitFor({ state: 'visible' });
    const otherSessionRow = settingsRevoke.locator('li').filter({ hasText: '其他浏览器' }).first();
    await otherSessionRow.waitFor({ state: 'visible', timeout: 15_000 });
    await otherSessionRow.getByRole('button', { name: '撤销' }).click();
    await otherSessionRow.getByRole('button', { name: '确认撤销' }).click();
    await settingsRevoke
      .getByText('浏览器会话已撤销；对应的 SSE 连接会立即关闭。')
      .waitFor({ state: 'visible', timeout: 15_000 });
    checks.revokeSession = true;
    await settingsRevoke.getByRole('button', { name: '关闭', exact: true }).last().click();
    await settingsRevoke.waitFor({ state: 'detached' });

    await pageA.waitForFunction(
      () => window.__moyuSse?.revoked === true || window.__moyuSse?.error === true,
      null,
      { timeout: 15_000 },
    );
    checks.revocationClosesSse = true;

    const attachmentAfter = await pageA.evaluate(async (id) => {
      const response = await fetch(`/api/v1/attachments/${id}`);
      return { status: response.status };
    }, artifactId);
    assert(attachmentAfter.status === 401, 'Revoked session still read the attachment.');
    checks.attachmentAfterRevocation = true;

    const meAfter = await fetchJson(pageA, '/api/v1/auth/me');
    assert(meAfter.status === 401, 'Revoked session still accessed /auth/me.');
    const stateAfterRevoke = await fetchJson(pageA, '/api/v1/auth/state');
    assert(
      stateAfterRevoke.body?.data?.initialized === true,
      'Revocation changed the global owner state.',
    );

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.getByRole('button', { name: /使用 Passkey 登录/ }).waitFor({ timeout: 20_000 });
    checks.revokedSessionFallsBackToLogin = true;
    assert(sessionAId, 'First session id missing.');

    const meBAfter = await fetchJson(pageB, '/api/v1/auth/me');
    assert(meBAfter.status === 200, 'Revoking one session also revoked the admin session.');

    const settingsLogout = await openSettings(pageB);
    await settingsLogout.getByRole('button', { name: '退出登录' }).click();
    await pageB.getByRole('button', { name: /使用 Passkey 登录/ }).waitFor({ timeout: 20_000 });
    checks.logout = true;

    const meAfterLogout = await fetchJson(pageB, '/api/v1/auth/me');
    assert(meAfterLogout.status === 401, 'Logout did not revoke the current session.');

    const lossDb = new Client({ connectionString: database.url });
    await lossDb.connect();
    try {
      await lossDb.query(
        `update passkey_credentials set revoked_at = now()
         where owner_id = (select id from owners order by created_at limit 1)
           and revoked_at is null`,
      );
    } finally {
      await lossDb.end();
    }

    const recoveryState = await fetchJson(pageB, '/api/v1/auth/state');
    assert(
      recoveryState.body?.data?.recoveryOpen === true,
      'Losing the last passkey did not open the recovery state.',
    );

    const recoveryOutput = run('pnpm', ['--filter', '@moyu/api', 'auth:bootstrap'], {
      DATABASE_URL: database.url,
      AUTH_BOOTSTRAP_TTL_MINUTES: '10',
    });
    assert(
      /recovery|恢复/i.test(recoveryOutput),
      'The CLI did not report a recovery-purpose binding code.',
    );
    const recoveryMatch = recoveryOutput.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    assert(recoveryMatch, 'The recovery CLI did not print a usable code.');
    checks.recoveryCode = true;

    const contextC = await browser.newContext({
      viewport: { width: 1200, height: 820 },
      colorScheme: 'light',
      locale: 'zh-CN',
    });
    const pageC = await contextC.newPage();
    await attachVirtualAuthenticator(contextC, pageC);
    await pageC.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await pageC.getByRole('heading', { name: '使用恢复码重新绑定' }).waitFor({ timeout: 20_000 });
    await pageC.locator('#bootstrap-code').fill(recoveryMatch[0]);
    await pageC.getByRole('button', { name: '验证绑定码' }).click();
    await pageC.getByRole('button', { name: '创建 Passkey' }).waitFor({ timeout: 20_000 });
    await pageC.locator('#passkey-label').fill('Recovery virtual authenticator');
    await pageC.getByRole('button', { name: '创建 Passkey' }).click();
    await pageC.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
    const recoveredState = await fetchJson(pageC, '/api/v1/auth/state');
    assert(
      recoveredState.body?.data?.activeCredentialCount === 1,
      'Recovery did not register a replacement passkey.',
    );
    assert(
      recoveredState.body.data.recoveryOpen === false,
      'Recovery state stayed open after replacement registration.',
    );
    checks.recoveryRegistration = true;
    await contextC.close();

    await contextB.close();

    const result = {
      ranAt: new Date().toISOString(),
      baseUrl,
      rpId,
      browser: 'Chromium (Playwright) + CDP virtual authenticator',
      virtualAuthenticatorOnly: true,
      checks,
      screenshots,
      note: 'The CDP virtual authenticator is automation evidence only. No real hardware passkey was registered in this run.',
    };
    await writeFile(
      path.join(evidenceDir, 'e2e-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const tail = serverLog.join('').slice(-4000);
    process.stderr.write(`M2 browser acceptance failed: ${error?.stack ?? error}\n`);
    if (tail) {
      process.stderr.write(`--- API log tail ---\n${tail}\n`);
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (api) {
      api.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        api.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    await dropDatabase(database.name).catch(() => {});
  }
}

main().catch((error) => {
  process.exitCode = 1;
  if (!String(error?.message ?? error).startsWith('M2 browser acceptance failed')) {
    process.stderr.write(`M2 browser acceptance failed: ${error?.message ?? error}\n`);
  }
});
