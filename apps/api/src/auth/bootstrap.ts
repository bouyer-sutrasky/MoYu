import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  bootstrapCodes,
  owners,
  passkeyCredentials,
  type BootstrapCode,
  type Database,
  type Owner,
} from '@moyu/db';

import { ApiProblem } from '../lib/errors';
import { generateBootstrapCode, hashSecret, normalizeBootstrapCode, randomToken } from './crypto';

export interface OwnerAuthState {
  owner: Owner | null;
  activeCredentialCount: number;
  initialized: boolean;
  setupOpen: boolean;
  recoveryOpen: boolean;
}

export async function readOwnerAuthState(database: Database): Promise<OwnerAuthState> {
  const [owner] = await database.select().from(owners).orderBy(owners.createdAt).limit(1);

  let activeCredentialCount = 0;
  if (owner) {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(passkeyCredentials)
      .where(and(eq(passkeyCredentials.ownerId, owner.id), isNull(passkeyCredentials.revokedAt)));
    activeCredentialCount = row?.count ?? 0;
  }

  const initialized = Boolean(owner);
  return {
    owner: owner ?? null,
    activeCredentialCount,
    initialized,
    setupOpen: !initialized,
    recoveryOpen: initialized && activeCredentialCount === 0,
  };
}

export interface CreatedBootstrapCode {
  code: string;
  purpose: 'initial' | 'recovery';
  expiresAt: Date;
}

/**
 * Server-side owner recovery entry point. It is only callable from the operator
 * CLI with a database connection; the web process never mints codes.
 *
 * initial: no owner exists yet.
 * recovery: an owner exists but no active passkey remains.
 */
export async function createBootstrapCode(
  database: Database,
  ttlMs: number,
): Promise<CreatedBootstrapCode> {
  const state = await readOwnerAuthState(database);
  let purpose: 'initial' | 'recovery';
  if (!state.initialized) {
    purpose = 'initial';
  } else if (state.activeCredentialCount === 0) {
    purpose = 'recovery';
  } else {
    throw ApiProblem.conflict(
      'Initialization is already complete and an active passkey exists. Sign in and add a passkey from Settings.',
    );
  }

  // A newly printed code supersedes older unused codes and outstanding
  // registration tokens.
  await database
    .update(bootstrapCodes)
    .set({ expiresAt: sql`now()` })
    .where(and(isNull(bootstrapCodes.consumedAt), isNull(bootstrapCodes.completedAt)));
  await database
    .update(bootstrapCodes)
    .set({ tokenExpiresAt: sql`now()` })
    .where(isNull(bootstrapCodes.completedAt));

  const code = generateBootstrapCode();
  const expiresAt = new Date(Date.now() + ttlMs);
  await database.insert(bootstrapCodes).values({
    purpose,
    codeHash: hashSecret(normalizeBootstrapCode(code)),
    ownerId: purpose === 'recovery' ? (state.owner?.id ?? null) : null,
    expiresAt,
  });

  return { code, purpose, expiresAt };
}

export interface ExchangedBootstrapCode {
  row: BootstrapCode;
  token: string;
  registrationExpiresAt: Date;
}

/**
 * Atomically consumes the printed code and issues a registration-only token.
 * The token cannot be used as a login session; it only authorises one
 * registration ceremony.
 */
export async function exchangeBootstrapCode(
  database: Database,
  input: { code: string; ttlMs: number; requestIp?: string | null },
): Promise<ExchangedBootstrapCode> {
  const normalized = normalizeBootstrapCode(input.code);
  if (normalized.length !== 12) {
    throw ApiProblem.unauthorized('Invalid or expired binding code');
  }

  const [row] = await database
    .update(bootstrapCodes)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(bootstrapCodes.codeHash, hashSecret(normalized)),
        isNull(bootstrapCodes.consumedAt),
        sql`${bootstrapCodes.expiresAt} > now()`,
      ),
    )
    .returning();

  if (!row) {
    throw ApiProblem.unauthorized('Invalid or expired binding code');
  }

  const state = await readOwnerAuthState(database);
  if (row.purpose === 'initial' && (state.initialized || state.activeCredentialCount > 0)) {
    throw ApiProblem.conflict('Initialization is already complete; the binding entry is closed');
  }
  if (row.purpose === 'recovery' && (!state.initialized || state.activeCredentialCount > 0)) {
    throw ApiProblem.conflict('Recovery is only available when no active passkey remains');
  }

  const token = randomToken(32);
  const registrationExpiresAt = new Date(Date.now() + input.ttlMs);
  const [updated] = await database
    .update(bootstrapCodes)
    .set({
      tokenHash: hashSecret(token),
      tokenExpiresAt: registrationExpiresAt,
      requestIp: input.requestIp ?? null,
    })
    .where(and(eq(bootstrapCodes.id, row.id), isNull(bootstrapCodes.completedAt)))
    .returning();

  if (!updated) {
    throw ApiProblem.conflict('Binding code was already completed');
  }

  return { row: updated, token, registrationExpiresAt };
}

export async function resolveBootstrapToken(
  database: Database,
  token: string,
): Promise<BootstrapCode | null> {
  if (!token) {
    return null;
  }
  const [row] = await database
    .select()
    .from(bootstrapCodes)
    .where(
      and(
        eq(bootstrapCodes.tokenHash, hashSecret(token)),
        sql`${bootstrapCodes.consumedAt} is not null`,
        isNull(bootstrapCodes.completedAt),
        sql`${bootstrapCodes.tokenExpiresAt} > now()`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function completeBootstrapCode(
  database: Database,
  bootstrapCodeId: string,
): Promise<void> {
  await database
    .update(bootstrapCodes)
    .set({ completedAt: sql`now()` })
    .where(and(eq(bootstrapCodes.id, bootstrapCodeId), isNull(bootstrapCodes.completedAt)));
}
