#!/usr/bin/env node
/** Seeds isolated L117 source tasks (completed, closed_unmerged, cleaned, running) and a second owned repository. */
import { createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const token = process.env.M6A_SESSION_TOKEN;
if (!url || !token) throw new Error('DATABASE_URL and M6A_SESSION_TOKEN are required');
const client = new pg.Client({ connectionString: url });
await client.connect();
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
try {
  await client.query('begin');
  const owner = (
    await client.query("insert into owners (display_name) values ('L117 Owner') returning id")
  ).rows[0];
  const other = (
    await client.query("insert into owners (display_name) values ('L117 Other') returning id")
  ).rows[0];
  const source = (
    await client.query(
      "insert into repositories (owner_id, full_name, default_branch, status) values ($1, 'Bouyer12/l117-source', 'main', 'active') returning id",
      [owner.id],
    )
  ).rows[0];
  const target = (
    await client.query(
      "insert into repositories (owner_id, full_name, default_branch, status) values ($1, 'Bouyer12/l117-target', 'trunk', 'active') returning id",
      [owner.id],
    )
  ).rows[0];
  await client.query(
    "insert into repositories (owner_id, full_name, default_branch, status) values ($1, 'someone/l117-foreign', 'main', 'active')",
    [other.id],
  );
  await client.query(
    'insert into sessions (owner_id, token_hash, expires_at) values ($1, $2, now() + interval $$1 day$$)',
    [owner.id, hash(token)],
  );
  const tasks = {};
  for (const spec of [
    {
      key: 'completed',
      title: 'L117 completed 已完成任务',
      state: 'completed',
      pr: true,
      stop: {},
    },
    {
      key: 'closed',
      title: 'L117 closed 关闭未合并',
      state: 'closed_unmerged',
      pr: true,
      stop: {},
    },
    {
      key: 'cleaned',
      title: 'L117 cleaned 目录已清理',
      state: 'completed',
      pr: false,
      stop: { worktreeRemoved: true, worktree: '/tmp/gone' },
      commit: 'def5678',
    },
    { key: 'running', title: 'L117 running 运行中', state: 'running', pr: false, stop: {} },
  ]) {
    const conversation = (
      await client.query(
        `insert into conversations (owner_id, repository_id, mode, execution_mode, source, base_branch, base_commit, title)
       values ($1, $2, 'work', 'execute', 'web', 'main', $3, $4) returning id, title`,
        [owner.id, source.id, spec.commit ?? 'abc1234', spec.title],
      )
    ).rows[0];
    const task = (
      await client.query(
        `insert into task_links (conversation_id, repository_id, state, base_branch, base_commit, stop_evidence, pr_url, pr_number)
       values ($1, $2, $3, 'main', $4, $5::jsonb, $6, $7) returning id`,
        [
          conversation.id,
          source.id,
          spec.state,
          spec.commit ?? 'abc1234',
          JSON.stringify(spec.stop),
          spec.pr ? 'https://github.com/Bouyer12/l117-source/pull/7' : null,
          spec.pr ? 7 : null,
        ],
      )
    ).rows[0];
    await client.query(
      "insert into messages (conversation_id, direction, kind, source, body) values ($1, 'outbound', 'result', 'bridge', $2)",
      [conversation.id, `delivered summary for ${spec.key}`],
    );
    tasks[spec.key] = {
      conversationId: conversation.id,
      taskId: task.id,
      title: conversation.title,
    };
  }
  await client.query('commit');
  process.stdout.write(
    `${JSON.stringify({ tasks, sourceRepositoryId: source.id, targetRepositoryId: target.id, token })}\n`,
  );
} finally {
  await client.end();
}
