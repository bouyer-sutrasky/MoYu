import { randomBytes, randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  owners,
  passkeyCredentials,
  sessions as sessionRows,
  type Owner,
  type PasskeyCredential,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { sessionCookieName } from '../../src/auth/cookies';
import { SessionService } from '../../src/auth/sessions';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createAppEventBus } from '../../src/events/bus';
import { createTestDatabase, type TestDatabase } from './helpers';

const BLOCKED_REQUEST_TIMEOUT_MS = 10_000;

interface SeedCredential {
  credential: PasskeyCredential;
  cookie: string;
}

/**
 * Waits until the expected number of requests are blocked on a database lock.
 * The test holds row locks on the credentials being revoked. A request that has
 * already counted active credentials blocks on its UPDATE; a request that has
 * not counted yet blocks on the auth-state revocation lock. Both waits appear
 * as ungranted rows in pg_locks.
 */
async function waitForBlockedRequests(control: Client, expected: number): Promise<void> {
  const deadline = Date.now() + BLOCKED_REQUEST_TIMEOUT_MS;
  for (;;) {
    const result = await control.query<{ blocked: number }>(
      `select count(*)::int as blocked
         from pg_locks locks
         join pg_stat_activity activity on activity.pid = locks.pid
        where not locks.granted
          and activity.datname = current_database()
          and locks.pid <> pg_backend_pid()`,
    );
    const blocked = result.rows[0]?.blocked ?? 0;
    if (blocked >= expected) {
      return;
    }
    if (Date.now() >= deadline) {
      const diagnostics = await control.query(
        `select activity.pid, activity.state, activity.wait_event_type, activity.wait_event,
                left(activity.query, 160) as query
           from pg_stat_activity activity
          where activity.datname = current_database()
            and activity.pid <> pg_backend_pid()`,
      );
      const locks = await control.query(
        `select locks.pid, locks.locktype, locks.mode, locks.granted, locks.transactionid,
                locks.relation::regclass as relation
           from pg_locks locks
           join pg_stat_activity activity on activity.pid = locks.pid
          where activity.datname = current_database()
            and locks.pid <> pg_backend_pid()`,
      );
      throw new Error(
        `timed out waiting for ${expected} requests blocked on credentials; observed ${blocked}; ` +
          `sessions=${JSON.stringify(diagnostics.rows)}; locks=${JSON.stringify(locks.rows)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function seedCredential(
  database: TestDatabase,
  service: SessionService,
  config: ApiConfig,
  owner: Owner,
  label: string,
): Promise<SeedCredential> {
  const [credential] = await database.db
    .insert(passkeyCredentials)
    .values({
      ownerId: owner.id,
      credentialId: `cred-${randomUUID()}`,
      publicKey: Buffer.from(randomBytes(32)).toString('base64url'),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      label,
    })
    .returning();
  if (!credential) {
    throw new Error(`credential seed failed for ${label}`);
  }
  const session = await service.create({
    ownerId: owner.id,
    credentialId: credential.id,
    userAgent: `integration ${label}`,
  });
  return { credential, cookie: `${sessionCookieName(config)}=${session.token}` };
}

describe('concurrent passkey revocation on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let app: FastifyInstance;
  let config: ApiConfig;
  let service: SessionService;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'https://moyu.sutrasky.com',
      WEBAUTHN_RP_ID: 'moyu.sutrasky.com',
      AUTH_COOKIE_SECURE: 'true',
      WEB_DIST_DIR: '/nonexistent-web-build',
    });
    app = buildApp({ config, database: testDatabase.db });
    await app.ready();
    service = new SessionService(testDatabase.db, config.sessionTtlMs, createAppEventBus());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDatabase?.drop();
  });

  it('lets exactly one concurrent revocation succeed and keeps one passkey active', async () => {
    const [owner] = await testDatabase.db
      .insert(owners)
      .values({ displayName: 'Concurrency Owner' })
      .returning();
    if (!owner) {
      throw new Error('owner seed failed');
    }

    const first = await seedCredential(testDatabase, service, config, owner, 'first');
    const second = await seedCredential(testDatabase, service, config, owner, 'second');

    const control = new Client({ connectionString: testDatabase.url });
    await control.connect();

    try {
      // Hold both target rows so neither request can revoke before the other
      // has read the active count. This pins the audit's interleaving instead
      // of relying on request timing.
      await control.query('begin');
      await control.query(
        'select id from passkey_credentials where id = any($1::uuid[]) for update',
        [[first.credential.id, second.credential.id]],
      );

      const firstRequest = app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/credentials/${first.credential.id}`,
        headers: { cookie: first.cookie },
      });
      const secondRequest = app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/credentials/${second.credential.id}`,
        headers: { cookie: second.cookie },
      });

      try {
        await waitForBlockedRequests(control, 2);
        await control.query('commit');
      } catch (error) {
        await control.query('rollback').catch(() => undefined);
        await Promise.allSettled([firstRequest, secondRequest]);
        throw error;
      }

      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
      const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort(
        (left, right) => left - right,
      );
      const activeCredentials = await testDatabase.db
        .select()
        .from(passkeyCredentials)
        .where(and(eq(passkeyCredentials.ownerId, owner.id), isNull(passkeyCredentials.revokedAt)));
      expect({ statuses, activeCredentialCount: activeCredentials.length }).toEqual({
        statuses: [200, 409],
        activeCredentialCount: 1,
      });

      const firstWon = firstResponse.statusCode === 200;
      const winner = firstWon ? first : second;
      const loser = firstWon ? second : first;
      const winnerResponse = firstWon ? firstResponse : secondResponse;
      const loserResponse = firstWon ? secondResponse : firstResponse;

      expect(winnerResponse.json().data.revoked).toBe(true);
      expect(loserResponse.json().error.code).toBe('conflict');
      expect(loserResponse.json().error.message).toContain('last active passkey');
      expect(activeCredentials[0]?.id).toBe(loser.credential.id);

      const [revokedCredential] = await testDatabase.db
        .select()
        .from(passkeyCredentials)
        .where(eq(passkeyCredentials.id, winner.credential.id));
      expect(revokedCredential?.revokedAt).not.toBeNull();

      const winnerSession = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: winner.cookie },
      });
      expect(winnerSession.statusCode).toBe(401);

      const loserSession = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: loser.cookie },
      });
      expect(loserSession.statusCode).toBe(200);
      expect(loserSession.json().data.owner.id).toBe(owner.id);

      const boundSessions = await testDatabase.db
        .select()
        .from(sessionRows)
        .where(eq(sessionRows.ownerId, owner.id));
      const revokedBoundSession = boundSessions.find(
        (row) => row.credentialId === winner.credential.id,
      );
      const survivingBoundSession = boundSessions.find(
        (row) => row.credentialId === loser.credential.id,
      );
      expect(revokedBoundSession?.revokedAt).not.toBeNull();
      expect(survivingBoundSession?.revokedAt).toBeNull();
    } finally {
      await control.end();
    }
  }, 30_000);

  it('rejects revoking the last active passkey and keeps its session usable', async () => {
    const [owner] = await testDatabase.db
      .insert(owners)
      .values({ displayName: 'Last Passkey Owner' })
      .returning();
    if (!owner) {
      throw new Error('owner seed failed');
    }
    const only = await seedCredential(testDatabase, service, config, owner, 'only');

    const rejected = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/credentials/${only.credential.id}`,
      headers: { cookie: only.cookie },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('conflict');

    const stillActive = await testDatabase.db
      .select()
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.id, only.credential.id));
    expect(stillActive[0]?.revokedAt).toBeNull();

    const stillSignedIn = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: only.cookie },
    });
    expect(stillSignedIn.statusCode).toBe(200);
    expect(stillSignedIn.json().data.owner.id).toBe(owner.id);
  }, 30_000);
});
