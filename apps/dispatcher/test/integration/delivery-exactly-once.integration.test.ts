import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers';

describe('delivery exactly-once on real PostgreSQL', () => {
  let db: TestDatabase;
  let conversationId = '';
  const rounds: Array<{
    round: number;
    messageId: string;
    rows: number;
    delivered: number;
    attempts: number;
    triggerIds: string[];
  }> = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    const owner = await db.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('delivery') returning id`,
    );
    const repo = await db.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status)
       values ($1, $2, 'main', 'active') returning id`,
      [owner.rows[0]!.id, `Bouyer12/delivery-${process.pid}`],
    );
    const conversation = await db.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, title)
       values ($1, $2, 'work', 'execute', 'main', 'delivery') returning id`,
      [owner.rows[0]!.id, repo.rows[0]!.id],
    );
    conversationId = conversation.rows[0]!.id;
  }, 60_000);

  afterAll(async () => { await db.drop(); });

  it('keeps one delivery row and one effective delivery across 5 concurrent rounds', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const message = await db.pool.query<{ id: string }>(
        `insert into messages (conversation_id, direction, body, kind)
         values ($1, 'outbound', $2, 'user') returning id`,
        [conversationId, `round-${round}`],
      );
      const messageId = message.rows[0]!.id;
      await db.pool.query(
        `insert into deliveries (message_id, upstream_trigger_id)
         values ($1, $2) on conflict (message_id) do nothing`,
        [messageId, `workspace:${messageId}`],
      );
      const inserts = await Promise.all(Array.from({ length: 4 }, () =>
        db.pool.query(
          `insert into deliveries (message_id, upstream_trigger_id)
           values ($1, $2) on conflict (message_id) do nothing returning id`,
          [messageId, `workspace:${messageId}`],
        ),
      ));
      expect(inserts.every(result => result.rowCount === 0)).toBe(true);
      const delivered = await Promise.all(Array.from({ length: 4 }, () =>
        db.pool.query(
          `update deliveries set state = 'delivered', delivered_at = now()
            where message_id = $1 and delivered_at is null returning id`,
          [messageId],
        ),
      ));
      expect(delivered.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);
      const row = await db.pool.query<{ n: string; delivered: string; attempts: number; trigger: string }>(
        `select count(*) as n, count(delivered_at) as delivered,
                max(attempt_count) as attempts, min(upstream_trigger_id) as trigger
           from deliveries where message_id = $1`,
        [messageId],
      );
      rounds.push({
        round, messageId, rows: Number(row.rows[0]!.n), delivered: Number(row.rows[0]!.delivered),
        attempts: row.rows[0]!.attempts, triggerIds: [row.rows[0]!.trigger],
      });
      expect(Number(row.rows[0]!.n)).toBe(1);
      expect(Number(row.rows[0]!.delivered)).toBe(1);
      expect(row.rows[0]!.trigger).toBe(`workspace:${messageId}`);
    }
    console.log('DELIVERY_ROUNDS', JSON.stringify(rounds));
  }, 60_000);
});
