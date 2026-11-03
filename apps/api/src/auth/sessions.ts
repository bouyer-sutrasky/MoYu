import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  owners,
  passkeyCredentials,
  sessions,
  type Database,
  type Owner,
  type Session,
} from '@moyu/db';

import type { AppEventBus } from '../events/bus';
import { ApiProblem } from '../lib/errors';
import { hashSecret, randomToken } from './crypto';

export interface AuthContext {
  session: Session;
  owner: Owner;
  token: string;
}

export interface CreatedSession {
  token: string;
  session: Session;
}

const ROLLING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export class SessionService {
  constructor(
    private readonly database: Database,
    private readonly sessionTtlMs: number,
    private readonly events: AppEventBus,
  ) {}

  /**
   * Creates a session, optionally inside the caller's transaction. Credential
   * login passes the transaction that holds the auth-state lock, so the
   * credential liveness check and this insert commit as one unit: a concurrent
   * revocation either revokes the credential first (login fails) or observes
   * this session in its revocation sweep (the session is revoked).
   */
  async create(
    input: {
      ownerId: string;
      credentialId?: string | null;
      userAgent?: string | null;
    },
    executor: Pick<Database, 'insert'> = this.database,
  ): Promise<CreatedSession> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    const [session] = await executor
      .insert(sessions)
      .values({
        ownerId: input.ownerId,
        credentialId: input.credentialId ?? null,
        tokenHash: hashSecret(token),
        userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
        expiresAt,
      })
      .returning();

    if (!session) {
      throw new Error('session insert returned no row');
    }
    return { token, session };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    if (!token) {
      return null;
    }

    const [row] = await this.database
      .select({ session: sessions, owner: owners })
      .from(sessions)
      .innerJoin(owners, eq(sessions.ownerId, owners.id))
      .where(
        and(
          eq(sessions.tokenHash, hashSecret(token)),
          isNull(sessions.revokedAt),
          sql`${sessions.expiresAt} > now()`,
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    let session = row.session;
    const now = Date.now();
    if (now - session.lastUsedAt.getTime() >= ROLLING_REFRESH_INTERVAL_MS) {
      const [updated] = await this.database
        .update(sessions)
        .set({
          lastUsedAt: new Date(now),
          expiresAt: new Date(now + this.sessionTtlMs),
        })
        .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
        .returning();
      if (updated) {
        session = updated;
      }
    }

    return { session, owner: row.owner, token };
  }

  async list(ownerId: string, currentSessionId: string) {
    const rows = await this.database
      .select()
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.revokedAt)))
      .orderBy(sql`${sessions.lastUsedAt} desc`);

    return rows.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  async revoke(ownerId: string, sessionId: string): Promise<boolean> {
    const [row] = await this.database
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId), isNull(sessions.revokedAt)),
      )
      .returning();

    if (!row) {
      return false;
    }
    this.events.emitSessionRevoked(row.id);
    return true;
  }

  /**
   * Marks sessions bound to a revoked credential without publishing live
   * revocation notifications. Callers inside a transaction must announce the
   * returned IDs only after the transaction commits, so a rolled-back attempt
   * never closes a still-valid SSE stream.
   */
  async markSessionsRevokedForCredential(
    executor: Pick<Database, 'update'>,
    ownerId: string,
    credentialRowId: string,
  ): Promise<string[]> {
    const rows = await executor
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.ownerId, ownerId),
          eq(sessions.credentialId, credentialRowId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    return rows.map((row) => row.id);
  }

  announceRevokedSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.events.emitSessionRevoked(sessionId);
    }
  }

  async isActive(sessionId: string): Promise<boolean> {
    const [row] = await this.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          sql`${sessions.expiresAt} > now()`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async countActiveCredentials(
    ownerId: string,
    executor: Pick<Database, 'select'> = this.database,
  ): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(passkeyCredentials)
      .where(and(eq(passkeyCredentials.ownerId, ownerId), isNull(passkeyCredentials.revokedAt)));
    return row?.count ?? 0;
  }

  requireSession(context: AuthContext | null): AuthContext {
    if (!context) {
      throw ApiProblem.unauthorized();
    }
    return context;
  }
}
