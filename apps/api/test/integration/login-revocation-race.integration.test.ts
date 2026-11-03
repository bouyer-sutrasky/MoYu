import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';

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
import { createChallenge } from '../../src/auth/challenges';
import { sessionCookieName } from '../../src/auth/cookies';
import { SessionService } from '../../src/auth/sessions';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createAppEventBus, type AppEventBus } from '../../src/events/bus';
import { createTestDatabase, type TestDatabase } from './helpers';

const BARRIER_TIMEOUT_MS = 10_000;

interface SeededPasskey {
  credential: PasskeyCredential;
  privateKey: KeyObject;
  credentialId: string;
}

interface LoginPayload {
  ceremonyId: string;
  response: Record<string, unknown>;
}

interface LoginResponseBody {
  data?: { me?: { session?: { id?: string } } };
}

/**
 * Encodes an ES256 (P-256) COSE public key for a credential whose assertion
 * this test signs locally. Only the login route's WebAuthn verification is
 * exercised end to end; no browser is involved.
 */
function coseEc2PublicKey(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    // CBOR map(5): kty=EC2, alg=ES256, crv=P256, x=bytes(32), y=bytes(32).
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function waitForRetry(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function sessionIdFromLogin(body: LoginResponseBody): string {
  const id = body.data?.me?.session?.id;
  if (!id) {
    throw new Error('login response did not include a session id');
  }
  return id;
}

async function waitForCondition(
  control: Client,
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = BARRIER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      const activity = await control.query(
        `select pid, state, wait_event_type, wait_event,
                pg_blocking_pids(pid) as blockers, left(query, 160) as query
           from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()`,
      );
      const locks = await control.query(
        `select pid, locktype, mode, granted, transactionid,
                relation::regclass as relation
           from pg_locks
          where pid <> pg_backend_pid()
            and database = (select oid from pg_database where datname = current_database())`,
      );
      throw new Error(
        `timed out waiting for ${description}; ` +
          `activity=${JSON.stringify(activity.rows)}; locks=${JSON.stringify(locks.rows)}`,
      );
    }
    await waitForRetry();
  }
}

/**
 * Counts backends blocked by the control connection itself. The `query` text
 * is unreliable for a blocked extended-protocol statement, but
 * pg_blocking_pids names the lock holder directly.
 */
async function blockedByControl(control: Client): Promise<number> {
  const result = await control.query<{ blocked: number }>(
    `select count(*)::int as blocked
       from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and pg_backend_pid() = any(pg_blocking_pids(pid))`,
  );
  return result.rows[0]?.blocked ?? 0;
}

/** Advisory locks waiting behind the auth-state lock. */
async function ungrantedAdvisoryLocks(control: Client): Promise<number> {
  const result = await control.query<{ blocked: number }>(
    `select count(*)::int as blocked
       from pg_locks
      where locktype = 'advisory'
        and not granted
        and database = (select oid from pg_database where datname = current_database())`,
  );
  return result.rows[0]?.blocked ?? 0;
}

/**
 * Locks waiting in this database. A fixed login queues on the auth-state
 * advisory lock; the pre-fix login queued on the credential tuple lock. Either
 * wait proves the request reached its critical section while the barrier is up.
 */
async function ungrantedLocks(control: Client): Promise<number> {
  const result = await control.query<{ blocked: number }>(
    `select count(*)::int as blocked
       from pg_locks
      where not granted
        and database = (select oid from pg_database where datname = current_database())`,
  );
  return result.rows[0]?.blocked ?? 0;
}

describe('passkey login racing credential revocation on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let app: FastifyInstance;
  let config: ApiConfig;
  let service: SessionService;
  let eventBus: AppEventBus;
  let baseUrl: string;

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
    eventBus = createAppEventBus();
    app = buildApp({ config, database: testDatabase.db, eventBus });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('API did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    service = new SessionService(testDatabase.db, config.sessionTtlMs, eventBus);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDatabase?.drop();
  });

  async function seedOwner(label: string): Promise<Owner> {
    const [owner] = await testDatabase.db
      .insert(owners)
      .values({ displayName: `Race ${label} ${randomUUID()}` })
      .returning();
    if (!owner) {
      throw new Error('owner seed failed');
    }
    return owner;
  }

  async function seedPasskey(owner: Owner, label: string): Promise<SeededPasskey> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x || !jwk.y) {
      throw new Error('generated EC key is missing coordinates');
    }
    const credentialId = `cred-${randomUUID()}`;
    const [credential] = await testDatabase.db
      .insert(passkeyCredentials)
      .values({
        ownerId: owner.id,
        credentialId,
        publicKey: coseEc2PublicKey(
          Buffer.from(jwk.x, 'base64url'),
          Buffer.from(jwk.y, 'base64url'),
        ).toString('base64url'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        label,
      })
      .returning();
    if (!credential) {
      throw new Error(`credential seed failed for ${label}`);
    }
    return { credential, privateKey, credentialId };
  }

  async function seedSession(owner: Owner, passkey: SeededPasskey, userAgent: string) {
    const created = await service.create({
      ownerId: owner.id,
      credentialId: passkey.credential.id,
      userAgent,
    });
    return {
      session: created.session,
      cookie: `${sessionCookieName(config)}=${created.token}`,
    };
  }

  /**
   * Creates a challenge row directly so the test controls the exact WebAuthn
   * challenge, then signs an assertion with the seeded P-256 key. The login
   * request itself is sent separately so a test can hold a database barrier and
   * slot the request into a fixed interleaving.
   */
  async function prepareLogin(owner: Owner, passkey: SeededPasskey): Promise<LoginPayload> {
    const challenge = randomBytes(32).toString('base64url');
    const ceremony = await createChallenge(testDatabase.db, {
      kind: 'authentication',
      ownerId: owner.id,
      options: { challenge },
      ttlMs: 60_000,
    });

    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: config.webauthnOrigin,
        crossOrigin: false,
      }),
    ).toString('base64url');
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(config.webauthnRpId).digest(),
      // UP + UV, counter 0.
      Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00]),
    ]);
    const clientDataHash = createHash('sha256')
      .update(Buffer.from(clientDataJSON, 'base64url'))
      .digest();
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, clientDataHash]),
      passkey.privateKey,
    );

    return {
      ceremonyId: ceremony.id,
      response: {
        id: passkey.credentialId,
        rawId: passkey.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON,
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      },
    };
  }

  function sendLogin(payload: LoginPayload): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/auth/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function revokeRequest(cookie: string, credentialId: string): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/auth/credentials/${credentialId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
  }

  function meRequest(cookie: string): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } });
  }

  function sessionCookieFrom(response: Response): string {
    const setCookie = response.headers.getSetCookie()[0] ?? '';
    return setCookie.split(';', 1)[0] ?? '';
  }

  it('refuses login when revocation commits before the login transaction takes the lock', async () => {
    const owner = await seedOwner('revoke-first');
    const loginPasskey = await seedPasskey(owner, 'login key');
    const revokerPasskey = await seedPasskey(owner, 'revoker key');
    const revokerSession = await seedSession(owner, revokerPasskey, 'revoker browser');
    const loginPayload = await prepareLogin(owner, loginPasskey);

    const control = new Client({ connectionString: testDatabase.url });
    await control.connect();
    try {
      // Hold the row lock on the login credential so the revocation reaches the
      // UPDATE but cannot commit yet. The login request can then be admitted and
      // pass its initial credential read before the revocation commits.
      await control.query('begin');
      await control.query('select id from passkey_credentials where id = $1 for update', [
        loginPasskey.credential.id,
      ]);

      const revokePromise = revokeRequest(revokerSession.cookie, loginPasskey.credential.id);
      await waitForCondition(
        control,
        'revocation blocked on the credential row',
        async () => (await blockedByControl(control)) >= 1,
      );

      const loginPromise = sendLogin(loginPayload);
      // The revocation holds the auth-state lock, so the login transaction must
      // queue behind it before the barrier is released. Before the fix login
      // took no auth lock and instead queued on the credential row lock.
      await waitForCondition(
        control,
        'login queued behind the revocation transaction',
        async () => (await ungrantedLocks(control)) >= 1 || (await blockedByControl(control)) >= 2,
      );

      await control.query('commit');

      const [revokeResponse, loginResponse] = await Promise.all([revokePromise, loginPromise]);
      expect(revokeResponse.status).toBe(200);
      expect(loginResponse.status).toBe(401);

      const [remaining] = await testDatabase.db
        .select()
        .from(passkeyCredentials)
        .where(
          and(
            eq(passkeyCredentials.id, loginPasskey.credential.id),
            isNull(passkeyCredentials.revokedAt),
          ),
        );
      expect(remaining).toBeUndefined();

      const loginSessions = await testDatabase.db
        .select()
        .from(sessionRows)
        .where(
          and(
            eq(sessionRows.ownerId, owner.id),
            eq(sessionRows.credentialId, loginPasskey.credential.id),
          ),
        );
      expect(loginSessions).toHaveLength(0);

      // The session used to authorise the revocation belongs to the other
      // credential and remains usable.
      const revokerMe = await meRequest(revokerSession.cookie);
      expect(revokerMe.status).toBe(200);
      expect(
        (await responseJson<{ data: { owner: { id: string } } }>(revokerMe)).data.owner.id,
      ).toBe(owner.id);
    } finally {
      await control.query('rollback').catch(() => undefined);
      await control.end();
    }
  }, 30_000);

  it('revokes a session created just before the revocation commits', async () => {
    const owner = await seedOwner('login-first');
    const loginPasskey = await seedPasskey(owner, 'login key');
    const revokerPasskey = await seedPasskey(owner, 'revoker key');
    const revokerSession = await seedSession(owner, revokerPasskey, 'revoker browser');
    const loginPayload = await prepareLogin(owner, loginPasskey);

    const control = new Client({ connectionString: testDatabase.url });
    await control.connect();
    try {
      // Holding `owners` FOR UPDATE blocks the session INSERT via its foreign
      // key check while leaving the credential UPDATE free to commit. This pins
      // the audited interleaving: login has updated the credential, revocation
      // commits, and only then does the login insert its session.
      await control.query('begin');
      await control.query('select id from owners where id = $1 for update', [owner.id]);

      const loginPromise = sendLogin(loginPayload);
      await waitForCondition(
        control,
        'login blocked inserting its session',
        async () => (await blockedByControl(control)) >= 1,
      );

      let revokeSettled = false;
      const revokePromise = revokeRequest(
        revokerSession.cookie,
        loginPasskey.credential.id,
      ).finally(() => {
        revokeSettled = true;
      });

      // Before the fix the revocation completes while login is parked. After the
      // fix login holds the auth-state lock, so revocation waits on that lock.
      await waitForCondition(
        control,
        'revocation to settle or queue behind the login transaction',
        async () => revokeSettled || (await ungrantedAdvisoryLocks(control)) >= 1,
      );

      await control.query('commit');

      const [loginResponse, revokeResponse] = await Promise.all([loginPromise, revokePromise]);
      expect(loginResponse.status).toBe(200);
      expect(revokeResponse.status).toBe(200);

      const loginCookie = sessionCookieFrom(loginResponse);
      expect(loginCookie).toMatch(/^__Host-moyu_session=/);

      // The regression: a session issued while this revocation is committing
      // must never grant access, regardless of which side committed last.
      const loginMe = await meRequest(loginCookie);
      expect(loginMe.status).toBe(401);

      const [loginSession] = await testDatabase.db
        .select()
        .from(sessionRows)
        .where(eq(sessionRows.credentialId, loginPasskey.credential.id))
        .orderBy(sessionRows.createdAt);
      expect(loginSession?.revokedAt).not.toBeNull();

      const revokerMe = await meRequest(revokerSession.cookie);
      expect(revokerMe.status).toBe(200);
    } finally {
      await control.query('rollback').catch(() => undefined);
      await control.end();
    }
  }, 30_000);

  it('keeps normal login and other sessions working, rejects the last passkey, and notifies after commit', async () => {
    const owner = await seedOwner('normal');
    const first = await seedPasskey(owner, 'first key');
    const second = await seedPasskey(owner, 'second key');
    const firstSession = await seedSession(owner, first, 'first browser');
    const secondSession = await seedSession(owner, second, 'second browser');

    const normalLogin = await sendLogin(await prepareLogin(owner, first));
    expect(normalLogin.status).toBe(200);
    const firstLoginCookie = sessionCookieFrom(normalLogin);
    const firstLoginSessionId = sessionIdFromLogin(
      await responseJson<LoginResponseBody>(normalLogin),
    );
    expect((await meRequest(firstLoginCookie)).status).toBe(200);
    expect((await meRequest(firstSession.cookie)).status).toBe(200);

    const observed: string[] = [];
    const observedRevokedAt = new Map<string, boolean>();
    const control = new Client({ connectionString: testDatabase.url });
    await control.connect();
    const observe = (sessionId: string) => {
      observed.push(sessionId);
      // The listener fires after the revocation transaction resolves. A
      // separate connection can only see `revoked_at` if the commit happened
      // before publication, so this observes the ordering, not just timing.
      void control
        .query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from sessions where id = $1',
          [sessionId],
        )
        .then((result) => {
          observedRevokedAt.set(sessionId, result.rows[0]?.revoked ?? false);
        })
        .catch(() => {
          observedRevokedAt.set(sessionId, false);
        });
    };
    const unsubscribers = [
      eventBus.onSessionRevoked(firstSession.session.id, () => observe(firstSession.session.id)),
      eventBus.onSessionRevoked(firstLoginSessionId, () => observe(firstLoginSessionId)),
    ];

    try {
      const revokeFirst = await revokeRequest(firstSession.cookie, first.credential.id);
      expect(revokeFirst.status).toBe(200);

      await waitForCondition(
        control,
        'revocation events to be observed with committed state',
        async () =>
          observed.length >= 2 && observed.every((sessionId) => observedRevokedAt.has(sessionId)),
      );
      expect(new Set(observed)).toEqual(new Set([firstSession.session.id, firstLoginSessionId]));
      for (const sessionId of observed) {
        expect(observedRevokedAt.get(sessionId)).toBe(true);
      }

      expect((await meRequest(firstSession.cookie)).status).toBe(401);
      expect((await meRequest(firstLoginCookie)).status).toBe(401);
      expect((await meRequest(secondSession.cookie)).status).toBe(200);

      const beforeLastAttempt = observed.length;
      const revokeLast = await revokeRequest(secondSession.cookie, second.credential.id);
      expect(revokeLast.status).toBe(409);
      expect((await responseJson<{ error: { code: string } }>(revokeLast)).error.code).toBe(
        'conflict',
      );

      const [stillActive] = await testDatabase.db
        .select()
        .from(passkeyCredentials)
        .where(eq(passkeyCredentials.id, second.credential.id));
      expect(stillActive?.revokedAt).toBeNull();
      expect(observed).toHaveLength(beforeLastAttempt);
      expect((await meRequest(secondSession.cookie)).status).toBe(200);
    } finally {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      await control.end();
    }
  }, 30_000);
});
