#!/usr/bin/env node
/** Seeds one isolated owner (plus a second owner) and a conversation for the A2c revoke checks. */
import { createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const token = process.env.M6A_SESSION_TOKEN;
const otherToken = process.env.M6A_OTHER_TOKEN;
if (!url || !token || !otherToken)
  throw new Error('DATABASE_URL, M6A_SESSION_TOKEN and M6A_OTHER_TOKEN are required');
const client = new pg.Client({ connectionString: url });
await client.connect();
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
try {
  await client.query('begin');
  const owner = (
    await client.query("insert into owners (display_name) values ('A2c Owner') returning id")
  ).rows[0];
  const other = (
    await client.query("insert into owners (display_name) values ('A2c Other') returning id")
  ).rows[0];
  const repository = (
    await client.query(
      "insert into repositories (owner_id, full_name, default_branch, status) values ($1, 'Bouyer12/a2c-revoke', 'main', 'active') returning id",
      [owner.id],
    )
  ).rows[0];
  const conversation = (
    await client.query(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, source, base_branch, title)
     values ($1, $2, 'work', 'execute', 'web', 'main', 'A2c 附件撤销') returning id`,
      [owner.id, repository.id],
    )
  ).rows[0];
  await client.query(
    `insert into task_links (conversation_id, repository_id, state, base_branch, execution_mode)
     values ($1, $2, 'queued', 'main', 'execute')`,
    [conversation.id, repository.id],
  );
  await client.query(
    'insert into sessions (owner_id, token_hash, expires_at) values ($1, $2, now() + interval $$1 day$$), ($3, $4, now() + interval $$1 day$$)',
    [owner.id, hash(token), other.id, hash(otherToken)],
  );
  await client.query('commit');
  process.stdout.write(
    `${JSON.stringify({ conversationId: conversation.id, repositoryId: repository.id })}\n`,
  );
} finally {
  await client.end();
}
