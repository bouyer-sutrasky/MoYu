import { and, eq, isNull, sql } from 'drizzle-orm';

import { authChallenges, type AuthChallenge, type Database } from '@moyu/db';

import { ApiProblem } from '../lib/errors';

export interface CreateChallengeInput {
  kind: 'registration' | 'authentication';
  ownerId?: string | null;
  options: Record<string, unknown>;
  context?: Record<string, unknown>;
  ttlMs: number;
}

export async function createChallenge(
  database: Database,
  input: CreateChallengeInput,
): Promise<AuthChallenge> {
  const [row] = await database
    .insert(authChallenges)
    .values({
      ownerId: input.ownerId ?? null,
      kind: input.kind,
      challenge: String(input.options.challenge ?? ''),
      options: input.options,
      context: input.context ?? {},
      expiresAt: new Date(Date.now() + input.ttlMs),
    })
    .returning();

  if (!row) {
    throw new Error('challenge insert returned no row');
  }
  return row;
}

/**
 * Consumes a challenge exactly once. The conditional UPDATE is the concurrency
 * boundary: a replay sees consumedAt set and gets a conflict instead of a second
 * success. Verification failures also burn the challenge by design.
 */
export async function consumeChallenge(
  database: Database,
  id: string,
  kind: 'registration' | 'authentication',
): Promise<AuthChallenge> {
  const [row] = await database
    .update(authChallenges)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(authChallenges.id, id),
        eq(authChallenges.kind, kind),
        isNull(authChallenges.consumedAt),
        sql`${authChallenges.expiresAt} > now()`,
      ),
    )
    .returning();

  if (!row) {
    throw ApiProblem.conflict('Ceremony challenge is missing, expired or already used');
  }
  return row;
}

export async function deleteExpiredChallenges(database: Database): Promise<void> {
  await database.execute(
    sql`delete from ${authChallenges} where ${authChallenges.expiresAt} < now() - interval '1 day'`,
  );
}
