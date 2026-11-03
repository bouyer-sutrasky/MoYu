import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  artifacts,
  owners,
  passkeyCredentials,
  repositories,
  type Owner,
  type PasskeyCredential,
  type Repository,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { createBootstrapCode, readOwnerAuthState } from '../../src/auth/bootstrap';
import { consumeChallenge, createChallenge } from '../../src/auth/challenges';
import { sessionCookieName } from '../../src/auth/cookies';
import { SessionService } from '../../src/auth/sessions';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createAppEventBus } from '../../src/events/bus';
import { ApiProblem } from '../../src/lib/errors';
import { createTestDatabase, cookiePair, type TestDatabase } from './helpers';

describe('M2 authentication on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let app: FastifyInstance;
  let config: ApiConfig;
  let service: SessionService;
  let storageDir: string;
  let owner: Owner;
  let repository: Repository;
  let firstCredential: PasskeyCredential;
  let secondCredential: PasskeyCredential;
  let firstSessionCookie: string;
  let adminSessionCookie: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    storageDir = await mkdtemp(path.join(tmpdir(), 'moyu-attachments-'));
    config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'https://moyu.sutrasky.com',
      WEBAUTHN_RP_ID: 'moyu.sutrasky.com',
      AUTH_COOKIE_SECURE: 'true',
      ARTIFACT_STORAGE_DIR: storageDir,
      WEB_DIST_DIR: '/nonexistent-web-build',
    });
    app = buildApp({ config, database: testDatabase.db });
    await app.ready();
    service = new SessionService(testDatabase.db, config.sessionTtlMs, createAppEventBus());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDatabase?.drop();
    if (storageDir) {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it('opens first registration once and refuses to reuse the binding code', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/auth/state' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toMatchObject({
      initialized: false,
      activeCredentialCount: 0,
      setupOpen: true,
      recoveryOpen: false,
      rpId: 'moyu.sutrasky.com',
      origin: 'https://moyu.sutrasky.com',
    });

    const generated = await createBootstrapCode(testDatabase.db, config.bootstrapTtlMs);
    expect(generated.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const exchange = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap/exchange',
      payload: { code: generated.code.toLowerCase() },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json().data.purpose).toBe('initial');
    const bootstrapCookie = cookiePair(exchange.headers['set-cookie']);
    expect(bootstrapCookie).toMatch(/^__Host-moyu_bootstrap=/);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap/exchange',
      payload: { code: generated.code },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('unauthorized');

    const unused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap/exchange',
      payload: { code: 'AAAA-AAAA-AAAA' },
    });
    expect(unused.statusCode).toBe(401);

    const stillOpen = await app.inject({ method: 'GET', url: '/api/v1/auth/state' });
    expect(stillOpen.json().data.setupOpen).toBe(true);
  });

  it('consumes a WebAuthn challenge atomically and rejects replay', async () => {
    const challenge = await createChallenge(testDatabase.db, {
      kind: 'authentication',
      options: { challenge: 'challenge-value' },
      ttlMs: 60_000,
    });

    const consumed = await consumeChallenge(testDatabase.db, challenge.id, 'authentication');
    expect(consumed.challenge).toBe('challenge-value');

    await expect(
      consumeChallenge(testDatabase.db, challenge.id, 'authentication'),
    ).rejects.toBeInstanceOf(ApiProblem);
  });

  it('rejects state-changing API requests from another origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap/exchange',
      headers: { origin: 'https://evil.example' },
      payload: { code: 'AAAA-AAAA-AAAA' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
  });

  it('gates attachments and invalidates the existing session on revocation', async () => {
    const [seededOwner] = await testDatabase.db
      .insert(owners)
      .values({ displayName: 'Integration Owner' })
      .returning();
    if (!seededOwner) {
      throw new Error('owner seed failed');
    }
    owner = seededOwner;
    const [seededRepository] = await testDatabase.db
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: `bouyer-sutrasky/integration-${randomUUID()}`,
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    if (!seededRepository) {
      throw new Error('repository seed failed');
    }
    repository = seededRepository;
    const [seededCredential] = await testDatabase.db
      .insert(passkeyCredentials)
      .values({
        ownerId: owner.id,
        credentialId: `cred-${randomUUID()}`,
        publicKey: Buffer.from(randomBytes(32)).toString('base64url'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        label: 'Integration key',
      })
      .returning();
    if (!seededCredential) {
      throw new Error('credential seed failed');
    }
    firstCredential = seededCredential;

    const fileName = 'note.txt';
    await writeFile(path.join(storageDir, fileName), 'protected attachment', 'utf8');
    await testDatabase.db.insert(artifacts).values({
      repositoryId: repository.id,
      type: 'attachment',
      storageKey: fileName,
      mimeType: 'text/plain',
      sizeBytes: 20,
      sha256: 'seed',
    });

    const [artifact] = await testDatabase.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.storageKey, fileName))
      .limit(1);
    if (!artifact) {
      throw new Error('artifact seed failed');
    }

    const firstSession = await service.create({
      ownerId: owner.id,
      credentialId: firstCredential.id,
      userAgent: 'integration browser A',
    });
    const adminSession = await service.create({
      ownerId: owner.id,
      credentialId: firstCredential.id,
      userAgent: 'integration browser B',
    });
    firstSessionCookie = `${sessionCookieName(config)}=${firstSession.token}`;
    adminSessionCookie = `${sessionCookieName(config)}=${adminSession.token}`;

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: firstSessionCookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.owner.displayName).toBe('Integration Owner');

    const attachment = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${artifact.id}`,
      headers: { cookie: firstSessionCookie },
    });
    expect(attachment.statusCode).toBe(200);
    expect(attachment.body).toBe('protected attachment');
    expect(attachment.headers['content-disposition']).toContain('attachment');
    expect(attachment.headers['x-content-type-options']).toBe('nosniff');

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${firstSession.session.id}`,
      headers: { cookie: adminSessionCookie },
    });
    expect(revoke.statusCode).toBe(200);

    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: firstSessionCookie },
    });
    expect(meAfter.statusCode).toBe(401);

    const attachmentAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${artifact.id}`,
      headers: { cookie: firstSessionCookie },
    });
    expect(attachmentAfter.statusCode).toBe(401);

    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: adminSessionCookie },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().data.sessions).toHaveLength(1);
    expect(sessions.json().data.sessions[0].current).toBe(true);
  });

  it('protects the last passkey and revokes sessions bound to a revoked passkey', async () => {
    const [seededSecondCredential] = await testDatabase.db
      .insert(passkeyCredentials)
      .values({
        ownerId: owner.id,
        credentialId: `cred-${randomUUID()}`,
        publicKey: Buffer.from(randomBytes(32)).toString('base64url'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        label: 'Second key',
      })
      .returning();
    if (!seededSecondCredential) {
      throw new Error('second credential seed failed');
    }
    secondCredential = seededSecondCredential;

    const adminSession = await service.create({
      ownerId: owner.id,
      credentialId: secondCredential.id,
      userAgent: 'integration browser C',
    });
    const adminCookie = `${sessionCookieName(config)}=${adminSession.token}`;

    const revokeFirst = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/credentials/${firstCredential.id}`,
      headers: { cookie: adminCookie },
    });
    expect(revokeFirst.statusCode).toBe(200);

    const revokeLast = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/credentials/${secondCredential.id}`,
      headers: { cookie: adminCookie },
    });
    expect(revokeLast.statusCode).toBe(409);
    expect(revokeLast.json().error.message).toContain('last active passkey');

    const adminMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: adminCookie },
    });
    expect(adminMe.statusCode).toBe(200);

    adminSessionCookie = adminCookie;
  });

  it('closes first registration after an active passkey exists', async () => {
    const state = await readOwnerAuthState(testDatabase.db);
    expect(state).toMatchObject({
      initialized: true,
      activeCredentialCount: 1,
      setupOpen: false,
      recoveryOpen: false,
    });

    await expect(createBootstrapCode(testDatabase.db, config.bootstrapTtlMs)).rejects.toThrow(
      /already complete/i,
    );

    const setup = await app.inject({ method: 'GET', url: '/api/v1/auth/state' });
    expect(setup.json().data.setupOpen).toBe(false);
    expect(setup.json().data.recoveryOpen).toBe(false);

    const optionsWithoutAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/registration/options',
      payload: {},
    });
    expect(optionsWithoutAuth.statusCode).toBe(401);
  });

  it('consumes the login challenge even when verification fails, so replay is a conflict', async () => {
    const options = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/options',
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const ceremonyId = options.json().data.ceremonyId as string;

    const garbage = {
      id: 'unknown-credential',
      rawId: 'unknown-credential',
      type: 'public-key',
      response: {
        clientDataJSON: 'AA',
        authenticatorData: 'AA',
        signature: 'AA',
      },
      clientExtensionResults: {},
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/verify',
      payload: { ceremonyId, response: garbage },
    });
    expect(first.statusCode).toBe(401);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/verify',
      payload: { ceremonyId, response: garbage },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('conflict');

    const credentials = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/credentials',
      headers: { cookie: adminSessionCookie },
    });
    expect(credentials.statusCode).toBe(200);
    expect(credentials.json().data.credentials).toHaveLength(1);

    const repos = await app.inject({
      method: 'GET',
      url: '/api/v1/repositories',
      headers: { cookie: adminSessionCookie },
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json().data.repositories[0].fullName).toBe(repository.fullName);

    const [revokedFirst] = await testDatabase.db
      .select()
      .from(passkeyCredentials)
      .where(
        and(
          eq(passkeyCredentials.id, firstCredential.id),
          eq(passkeyCredentials.ownerId, owner.id),
        ),
      );
    expect(revokedFirst?.revokedAt).not.toBeNull();
  });
});
