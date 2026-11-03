import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  authMeDataSchema,
  bootstrapExchangeInputSchema,
  credentialListDataSchema,
  loginVerifyInputSchema,
  registrationOptionsInputSchema,
  registrationVerifyInputSchema,
  sessionListDataSchema,
  uuidSchema,
  type PasskeyCredentialSummary,
} from '@moyu/contracts';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  bootstrapCodes,
  owners,
  passkeyCredentials,
  type Database,
  type Owner,
  type PasskeyCredential,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import {
  exchangeBootstrapCode,
  readOwnerAuthState,
  resolveBootstrapToken,
} from '../auth/bootstrap';
import { consumeChallenge, createChallenge } from '../auth/challenges';
import {
  bootstrapCookieName,
  clearBootstrapCookie,
  clearSessionCookie,
  sessionCookieName,
  setBootstrapCookie,
  setSessionCookie,
} from '../auth/cookies';
import {
  generateAuthenticationOptionsFor,
  generateRegistrationOptionsFor,
  toCredentialDescriptor,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/passkey';
import type { SessionService } from '../auth/sessions';
import { ApiProblem } from '../lib/errors';
import { clientIp, parseInput, sendData } from '../lib/http';
import { createRateLimiter, type RateLimiter } from '../lib/rate-limit';

export interface AuthRouteDependencies {
  config: ApiConfig;
  database: Database;
  sessions: SessionService;
}

const OWNER_DISPLAY_NAME = 'MoYu Owner';

function toCredentialSummary(credential: PasskeyCredential): PasskeyCredentialSummary {
  return {
    id: credential.id,
    label: credential.label,
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    transports: credential.transports,
    createdAt: credential.createdAt.toISOString(),
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
  };
}

function toSessionSummary(
  session: {
    id: string;
    userAgent: string | null;
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt: Date;
  },
  current: boolean,
) {
  return {
    id: session.id,
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current,
  };
}

async function activeCredentials(database: Database, ownerId: string) {
  return database
    .select()
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.ownerId, ownerId), isNull(passkeyCredentials.revokedAt)))
    .orderBy(passkeyCredentials.createdAt);
}

async function buildMe(
  database: Database,
  owner: Owner,
  session: {
    id: string;
    userAgent: string | null;
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt: Date;
  },
) {
  const credentials = await activeCredentials(database, owner.id);
  return authMeDataSchema.parse({
    owner: { id: owner.id, displayName: owner.displayName },
    session: toSessionSummary(session, true),
    credentials: credentials.map(toCredentialSummary),
  });
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  if (!limiter.take(key)) {
    throw new ApiProblem(429, 'rate_limited', 'Too many authentication attempts; retry later', {
      retryable: true,
    });
  }
}

function asResponseObject<T>(value: unknown, message: string): T {
  if (typeof value !== 'object' || value === null) {
    throw ApiProblem.invalid(message);
  }
  return value as T;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { config, database, sessions } = dependencies;
  const exchangeLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
  const loginOptionsLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 1000 });
  const loginVerifyLimiter = createRateLimiter({ limit: 60, windowMs: 60 * 1000 });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[sessionCookieName(config)] ?? '';
    const context = await sessions.resolve(token);
    if (!context) {
      clearSessionCookie(reply, config);
      throw ApiProblem.unauthorized();
    }
    request.auth = context;
    setSessionCookie(reply, config, token, context.session.expiresAt);
  };

  app.get('/api/v1/auth/state', async (request, reply) => {
    const state = await readOwnerAuthState(database);
    return sendData(reply, request, {
      initialized: state.initialized,
      activeCredentialCount: state.activeCredentialCount,
      setupOpen: state.setupOpen,
      recoveryOpen: state.recoveryOpen,
      rpId: config.webauthnRpId,
      origin: config.webauthnOrigin,
    });
  });

  app.post('/api/v1/auth/bootstrap/exchange', async (request, reply) => {
    enforceRateLimit(exchangeLimiter, clientIp(request));
    const input = parseInput(bootstrapExchangeInputSchema, request.body);
    const exchanged = await exchangeBootstrapCode(database, {
      code: input.code,
      ttlMs: config.bootstrapTtlMs,
      requestIp: clientIp(request),
    });

    setBootstrapCookie(reply, config, exchanged.token, exchanged.registrationExpiresAt);
    request.log.info(
      { event: 'auth.bootstrap_exchanged', purpose: exchanged.row.purpose },
      'binding code exchanged for a registration-only token',
    );

    return sendData(reply, request, {
      purpose: exchanged.row.purpose,
      expiresAt: exchanged.row.expiresAt.toISOString(),
      registrationExpiresAt: exchanged.registrationExpiresAt.toISOString(),
    });
  });

  app.post('/api/v1/auth/registration/options', async (request, reply) => {
    const input = parseInput(registrationOptionsInputSchema, request.body ?? {});

    const sessionToken = request.cookies[sessionCookieName(config)] ?? '';
    const sessionContext = await sessions.resolve(sessionToken);
    const bootstrapToken = request.cookies[bootstrapCookieName(config)] ?? '';

    let ownerId: string | null = null;
    let ceremonyContext: Record<string, unknown>;
    let bootstrap: Awaited<ReturnType<typeof resolveBootstrapToken>> = null;

    if (sessionContext) {
      ownerId = sessionContext.owner.id;
      ceremonyContext = { kind: 'session', sessionId: sessionContext.session.id };
    } else {
      bootstrap = await resolveBootstrapToken(database, bootstrapToken);
      if (!bootstrap) {
        throw ApiProblem.unauthorized('A bootstrap code or signed-in session is required');
      }
      const state = await readOwnerAuthState(database);
      if (bootstrap.purpose === 'initial' && state.initialized) {
        throw ApiProblem.conflict(
          'Initialization is already complete; the binding entry is closed',
        );
      }
      if (bootstrap.purpose === 'recovery' && state.activeCredentialCount > 0) {
        throw ApiProblem.conflict('Recovery is only available when no active passkey remains');
      }
      ownerId = state.owner?.id ?? null;
      ceremonyContext = { kind: 'bootstrap', bootstrapCodeId: bootstrap.id };
    }

    const credentials = ownerId ? await activeCredentials(database, ownerId) : [];
    // Adding a passkey from a signed-in session may legitimately use the same
    // authenticator again; WebAuthn's excludeCredentials would make the
    // authenticator refuse with InvalidStateError. Duplicate credential IDs are
    // still rejected by the database unique index at verify time. Bootstrap
    // ceremonies keep the exclusion list.
    const excluded =
      ceremonyContext.kind === 'bootstrap' ? credentials.map(toCredentialDescriptor) : [];
    const options = await generateRegistrationOptionsFor(config, excluded);
    const challenge = await createChallenge(database, {
      kind: 'registration',
      ownerId,
      options: options as unknown as Record<string, unknown>,
      context: { ...ceremonyContext, label: input.label ?? null },
      ttlMs: config.challengeTtlMs,
    });

    return sendData(reply, request, {
      ceremonyId: challenge.id,
      optionsJSON: options as unknown as Record<string, unknown>,
    });
  });

  app.post('/api/v1/auth/registration/verify', async (request, reply) => {
    const input = parseInput(registrationVerifyInputSchema, request.body);
    const challenge = await consumeChallenge(database, input.ceremonyId, 'registration');
    const context = challenge.context;
    const kind = typeof context.kind === 'string' ? context.kind : '';
    const label = typeof context.label === 'string' ? context.label : null;

    let bootstrapCompletionId: string | null = null;
    let ownerId = challenge.ownerId;

    if (kind === 'bootstrap') {
      const bootstrapId =
        typeof context.bootstrapCodeId === 'string' ? context.bootstrapCodeId : '';
      const bootstrap = await resolveBootstrapToken(
        database,
        request.cookies[bootstrapCookieName(config)] ?? '',
      );
      if (!bootstrap || bootstrap.id !== bootstrapId) {
        throw ApiProblem.unauthorized('Binding registration token is missing or expired');
      }
      const state = await readOwnerAuthState(database);
      if (bootstrap.purpose === 'initial' && state.initialized) {
        throw ApiProblem.conflict('Initialization is already complete');
      }
      if (bootstrap.purpose === 'recovery' && state.activeCredentialCount > 0) {
        throw ApiProblem.conflict('Recovery is already complete');
      }
      bootstrapCompletionId = bootstrap.id;
      ownerId = state.owner?.id ?? null;
    } else if (kind === 'session') {
      const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '';
      const sessionContext = await sessions.resolve(
        request.cookies[sessionCookieName(config)] ?? '',
      );
      if (!sessionContext || sessionContext.session.id !== sessionId) {
        throw ApiProblem.unauthorized('Signed-in session no longer matches this ceremony');
      }
      ownerId = sessionContext.owner.id;
    } else {
      throw ApiProblem.unauthorized('Ceremony context is invalid');
    }

    let verification;
    try {
      verification = await verifyRegistration(config, {
        response: asResponseObject<RegistrationResponseJSON>(
          input.response,
          'response must be a registration response object',
        ),
        expectedChallenge: challenge.challenge,
      });
    } catch (error) {
      request.log.warn({ err: error, event: 'auth.registration_failed' }, 'registration rejected');
      throw ApiProblem.unauthorized('Passkey registration verification failed');
    }

    if (!verification.verified) {
      throw ApiProblem.unauthorized('Passkey registration verification failed');
    }

    const info = verification.registrationInfo;
    let credential: PasskeyCredential;
    try {
      credential = await database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(918273645)`);

        let resolvedOwnerId = ownerId;
        if (!resolvedOwnerId) {
          const [existingOwner] = await transaction
            .select({ id: owners.id })
            .from(owners)
            .orderBy(owners.createdAt)
            .limit(1);
          if (existingOwner) {
            throw ApiProblem.conflict('Initialization is already complete');
          }
          const [owner] = await transaction
            .insert(owners)
            .values({ displayName: OWNER_DISPLAY_NAME })
            .returning({ id: owners.id });
          if (!owner) {
            throw new Error('owner insert returned no row');
          }
          resolvedOwnerId = owner.id;
        } else {
          const [existingOwner] = await transaction
            .select({ id: owners.id })
            .from(owners)
            .where(eq(owners.id, resolvedOwnerId))
            .limit(1);
          if (!existingOwner) {
            throw ApiProblem.conflict('Owner no longer exists');
          }
        }

        const [inserted] = await transaction
          .insert(passkeyCredentials)
          .values({
            ownerId: resolvedOwnerId,
            credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
            counter: info.credential.counter,
            transports: info.credential.transports ?? [],
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            label,
          })
          .returning();

        if (!inserted) {
          throw new Error('credential insert returned no row');
        }

        if (bootstrapCompletionId) {
          await transaction
            .update(bootstrapCodes)
            .set({ completedAt: sql`now()`, ownerId: resolvedOwnerId })
            .where(eq(bootstrapCodes.id, bootstrapCompletionId));
        }

        return inserted;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiProblem.conflict('This passkey is already registered');
      }
      throw error;
    }

    clearBootstrapCookie(reply, config);

    if (bootstrapCompletionId) {
      const [owner] = await database
        .select()
        .from(owners)
        .where(eq(owners.id, credential.ownerId))
        .limit(1);
      if (!owner) {
        throw new Error('owner disappeared after registration');
      }
      const created = await sessions.create({
        ownerId: owner.id,
        credentialId: credential.id,
        userAgent: request.headers['user-agent'] ?? null,
      });
      setSessionCookie(reply, config, created.token, created.session.expiresAt);
    }

    request.log.info(
      { event: 'auth.credential_registered', credentialId: credential.id },
      'passkey registered',
    );

    return sendData(reply, request, {
      credential: toCredentialSummary(credential),
      initialized: true as const,
    });
  });

  app.post('/api/v1/auth/login/options', async (request, reply) => {
    enforceRateLimit(loginOptionsLimiter, clientIp(request));
    const state = await readOwnerAuthState(database);
    if (!state.initialized || !state.owner) {
      throw ApiProblem.conflict('Initialization has not been completed');
    }

    const credentials = await activeCredentials(database, state.owner.id);
    if (credentials.length === 0) {
      throw ApiProblem.conflict('No active passkey remains; use the server recovery command');
    }

    const options = await generateAuthenticationOptionsFor(
      config,
      credentials.map(toCredentialDescriptor),
    );
    const challenge = await createChallenge(database, {
      kind: 'authentication',
      ownerId: state.owner.id,
      options: options as unknown as Record<string, unknown>,
      ttlMs: config.challengeTtlMs,
    });

    return sendData(reply, request, {
      ceremonyId: challenge.id,
      optionsJSON: options as unknown as Record<string, unknown>,
    });
  });

  app.post('/api/v1/auth/login/verify', async (request, reply) => {
    enforceRateLimit(loginVerifyLimiter, clientIp(request));
    const input = parseInput(loginVerifyInputSchema, request.body);
    const challenge = await consumeChallenge(database, input.ceremonyId, 'authentication');
    if (!challenge.ownerId) {
      throw ApiProblem.unauthorized('Challenge is not bound to an owner');
    }

    const response = asResponseObject<AuthenticationResponseJSON>(
      input.response,
      'response must be an authentication response object',
    );
    const [credential] = await database
      .select()
      .from(passkeyCredentials)
      .where(
        and(
          eq(passkeyCredentials.credentialId, response.id),
          eq(passkeyCredentials.ownerId, challenge.ownerId),
          isNull(passkeyCredentials.revokedAt),
        ),
      )
      .limit(1);

    if (!credential) {
      throw ApiProblem.unauthorized('Unknown or revoked passkey');
    }

    let verification;
    try {
      verification = await verifyAuthentication(config, {
        response,
        expectedChallenge: challenge.challenge,
        credential,
      });
    } catch (error) {
      request.log.warn({ err: error, event: 'auth.login_failed' }, 'login rejected');
      throw ApiProblem.unauthorized('Passkey authentication failed');
    }

    if (!verification.verified) {
      throw ApiProblem.unauthorized('Passkey authentication failed');
    }

    const [updatedCredential] = await database
      .update(passkeyCredentials)
      .set({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: sql`now()`,
      })
      .where(and(eq(passkeyCredentials.id, credential.id), isNull(passkeyCredentials.revokedAt)))
      .returning();
    if (!updatedCredential) {
      throw ApiProblem.unauthorized('Passkey was revoked during authentication');
    }

    const created = await sessions.create({
      ownerId: challenge.ownerId,
      credentialId: credential.id,
      userAgent: request.headers['user-agent'] ?? null,
    });
    setSessionCookie(reply, config, created.token, created.session.expiresAt);

    const [owner] = await database
      .select()
      .from(owners)
      .where(eq(owners.id, challenge.ownerId))
      .limit(1);
    if (!owner) {
      throw new Error('owner disappeared after login');
    }

    request.log.info(
      { event: 'auth.login', sessionId: created.session.id },
      'owner signed in with a passkey',
    );

    return sendData(reply, request, {
      me: await buildMe(database, owner, created.session),
      expiresAt: created.session.expiresAt.toISOString(),
    });
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    return sendData(reply, request, await buildMe(database, auth.owner, auth.session));
  });

  app.post('/api/v1/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    await sessions.revoke(auth.owner.id, auth.session.id);
    clearSessionCookie(reply, config);
    return sendData(reply, request, { revoked: true as const });
  });

  app.get('/api/v1/auth/sessions', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const list = await sessions.list(auth.owner.id, auth.session.id);
    return sendData(reply, request, sessionListDataSchema.parse({ sessions: list }));
  });

  app.delete('/api/v1/auth/sessions/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const params = request.params as { id?: string };
    const sessionId = parseInput(uuidSchema, params.id);
    const revoked = await sessions.revoke(auth.owner.id, sessionId);
    if (!revoked) {
      throw ApiProblem.notFound('Session not found');
    }
    if (sessionId === auth.session.id) {
      clearSessionCookie(reply, config);
    }
    return sendData(reply, request, { revoked: true as const });
  });

  app.get('/api/v1/auth/credentials', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const list = await activeCredentials(database, auth.owner.id);
    return sendData(
      reply,
      request,
      credentialListDataSchema.parse({ credentials: list.map(toCredentialSummary) }),
    );
  });

  app.get('/api/v1/auth/credentials/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const params = request.params as { id?: string };
    const [credential] = await database
      .select()
      .from(passkeyCredentials)
      .where(
        and(
          eq(passkeyCredentials.id, params.id ?? ''),
          eq(passkeyCredentials.ownerId, auth.owner.id),
          isNull(passkeyCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (!credential) {
      throw ApiProblem.notFound('Passkey not found');
    }
    return sendData(reply, request, toCredentialSummary(credential));
  });

  app.delete(
    '/api/v1/auth/credentials/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const credentialId = parseInput(uuidSchema, params.id);

      const count = await sessions.countActiveCredentials(auth.owner.id);
      if (count <= 1) {
        throw ApiProblem.conflict(
          'Cannot revoke the last active passkey; add another passkey before revoking this one',
        );
      }

      const [revoked] = await database
        .update(passkeyCredentials)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(passkeyCredentials.id, credentialId),
            eq(passkeyCredentials.ownerId, auth.owner.id),
            isNull(passkeyCredentials.revokedAt),
          ),
        )
        .returning();
      if (!revoked) {
        throw ApiProblem.notFound('Passkey not found');
      }

      await sessions.revokeSessionsForCredential(auth.owner.id, revoked.id);
      request.log.info(
        { event: 'auth.credential_revoked', credentialId: revoked.id },
        'passkey revoked',
      );
      return sendData(reply, request, { revoked: true as const });
    },
  );

  app.log.debug({ event: 'auth.routes_registered' }, 'authentication routes registered');
}
