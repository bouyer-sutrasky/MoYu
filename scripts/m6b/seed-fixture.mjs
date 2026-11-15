#!/usr/bin/env node
/**
 * Seeds the isolated M6-B acceptance database. It creates:
 *   - the owner, a second owner, and the `Bouyer12/MoYu` repository bound to
 *     supervisor profile `probe1`
 *   - completed tasks whose durable completion event is eight days old, so the
 *     7-day retention rule is exercised without changing the clock
 *   - a dirty task, a pushed-but-unmerged task, an out-of-bound symlink ticket,
 *     an occupied ticket and one running task
 *   - history rows with a plain keyword, a LIKE-metacharacter keyword and a
 *     cross-owner row that must never be returned
 *
 * It only writes to the isolated acceptance database.
 */
import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import { taskSummary } from './task-summary.mjs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const token = process.env.M6B_SESSION_TOKEN ?? randomBytes(32).toString('base64url');
const otherToken = process.env.M6B_OTHER_TOKEN ?? randomBytes(32).toString('base64url');
const prNumber = Number(process.env.M6B_PR_NUMBER ?? '44');
const unmergedPrNumber = Number(process.env.M6B_UNMERGED_PR_NUMBER ?? '999999');
const baseCommit = process.env.M6B_BASE_COMMIT ?? '68c01e50d69a075183a0a175c57611fa77e1163a';
const older = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const TICKETS = {
  clean: 't_clean_a1b2c3d4e5f6',
  dirty: 't_dirty_a1b2c3d4e5f6',
  unmerged: 't_unmer_a1b2c3d4e5f6',
  outside: 't_outsi_a1b2c3d4e5f6',
  occupied: 't_occup_a1b2c3d4e5f6',
  running: 't_runni_a1b2c3d4e5f6',
};

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  let owner = (await client.query('select id from owners order by created_at limit 1')).rows[0];
  if (!owner) {
    owner = (
      await client.query("insert into owners (display_name) values ('MoYu Owner') returning id")
    ).rows[0];
  }
  const otherOwner = (
    await client.query("insert into owners (display_name) values ('M6B Other Owner') returning id")
  ).rows[0];

  let repository = (
    await client.query('select id from repositories where full_name = $1', ['bouyer-sutrasky/MoYu'])
  ).rows[0];
  if (!repository) {
    repository = (
      await client.query(
        `insert into repositories (owner_id, full_name, default_branch, status)
         values ($1, 'bouyer-sutrasky/MoYu', 'main', 'active') returning id`,
        [owner.id],
      )
    ).rows[0];
  }
  await client.query(
    `insert into repository_instances (repository_id, state, desired_state, reason_code, profile)
     values ($1, 'sleeping', 'sleeping', 'never_started', 'probe1')
     on conflict (repository_id) do update
       set profile = 'probe1', state = 'sleeping', desired_state = 'sleeping'`,
    [repository.id],
  );
  const otherRepository = (
    await client.query(
      `insert into repositories (owner_id, full_name, default_branch, status)
       values ($1, 'bouyer-sutrasky/m6b-other', 'main', 'active') returning id`,
      [otherOwner.id],
    )
  ).rows[0];

  const createConversation = async (input) => {
    const conversation = (
      await client.query(
        `insert into conversations
           (owner_id, repository_id, mode, execution_mode, source, base_branch, base_commit, title)
         values ($1, $2, 'work', 'execute', $3, 'main', $4, $5) returning id`,
        [input.ownerId, input.repositoryId, input.source ?? 'web', baseCommit, input.title],
      )
    ).rows[0];
    const message = (
      await client.query(
        `insert into messages (conversation_id, direction, kind, body, source, client_message_id)
         values ($1, 'inbound', 'user', $2, 'web', $3) returning id`,
        [conversation.id, input.body, `seed-${randomBytes(6).toString('hex')}`],
      )
    ).rows[0];
    await client.query(
      `insert into deliveries (message_id, upstream_trigger_id, state) values ($1, $2, 'delivered')`,
      [message.id, `workspace:${message.id}`],
    );
    if (!input.task) {
      return { conversation };
    }
    const task = (
      await client.query(
        `insert into task_links
           (conversation_id, repository_id, state, upstream_ticket_id, base_branch, base_commit,
            execution_mode, pr_url, pr_number)
         values ($1, $2, $3, $4, 'main', $5, 'execute', $6, $7) returning id`,
        [
          conversation.id,
          input.repositoryId,
          input.task.state,
          input.task.ticketId,
          baseCommit,
          input.task.prNumber
            ? `https://github.com/bouyer-sutrasky/MoYu/pull/${input.task.prNumber}`
            : null,
          input.task.prNumber ?? null,
        ],
      )
    ).rows[0];
    if (input.task.completedAt) {
      const summary = await taskSummary(client, task.id, { state: 'completed' });
      await client.query(
        `insert into events
           (type, repository_id, conversation_id, task_id, payload, occurred_at)
         values ('task.state_changed', $1, $2, $3, $4::jsonb, $5)`,
        [
          input.repositoryId,
          conversation.id,
          task.id,
          JSON.stringify({ task: summary }),
          input.task.completedAt,
        ],
      );
    }
    return { conversation, task };
  };

  const clean = await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '已合并且干净的清理任务',
    body: '这个任务包含关键字 星河，也包含特殊字符 100%_safe。',
    task: { state: 'completed', ticketId: TICKETS.clean, prNumber, completedAt: older },
  });
  const dirty = await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '有未保存修改的清理任务',
    body: '这个任务也包含 星河，但工作目录有未提交改动。',
    task: { state: 'completed', ticketId: TICKETS.dirty, prNumber, completedAt: older },
  });
  await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: 'PR 尚未合并的清理任务',
    body: '用于验证未合并 PR 不会被删除。',
    task: {
      state: 'completed',
      ticketId: TICKETS.unmerged,
      prNumber: unmergedPrNumber,
      completedAt: older,
    },
  });
  await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '路径越界的清理任务',
    body: '用于验证 realpath 边界拒绝。',
    task: { state: 'completed', ticketId: TICKETS.outside, prNumber, completedAt: older },
  });
  await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '被进程占用的清理任务',
    body: '用于验证被工作占用时跳过。',
    task: { state: 'completed', ticketId: TICKETS.occupied, prNumber, completedAt: older },
  });
  const running = await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '正在执行的活动任务',
    body: '用于活动中心的运行中列表和通知点击定位。',
    task: { state: 'running', ticketId: TICKETS.running, prNumber: null },
  });
  await createConversation({
    ownerId: owner.id,
    repositoryId: repository.id,
    title: '等待审阅的活动任务',
    body: '用于验证待审阅分类。',
    task: { state: 'awaiting_review', ticketId: 't_review_a1b2c3d4e5f6', prNumber },
  });
  const other = await createConversation({
    ownerId: otherOwner.id,
    repositoryId: otherRepository.id,
    title: '另一个所有者的星河任务',
    body: 'cross owner secret 星河',
    source: 'web',
  });

  // Recent, real categorized events for the activity feed and browser test.
  const reviewSummary = await taskSummary(client, running.task.id, {
    state: 'awaiting_review',
    question: null,
  });
  const questionSummary = await taskSummary(client, running.task.id, {
    state: 'waiting_input',
    question: '请确认是否继续执行？',
  });
  await client.query(
    `insert into events
       (type, repository_id, conversation_id, task_id, payload, occurred_at)
     values
       ('task.state_changed', $1, $2, $3, $4::jsonb, now() - interval '5 minutes'),
       ('task.question', $1, $2, $3, $5::jsonb, now() - interval '4 minutes')`,
    [
      repository.id,
      running.conversation.id,
      running.task.id,
      JSON.stringify({ task: reviewSummary }),
      JSON.stringify({ task: questionSummary }),
    ],
  );

  await client.query(
    `insert into sessions (owner_id, token_hash, expires_at)
     values ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
    [owner.id, hash(token), otherOwner.id, hash(otherToken)],
  );

  await client.query('commit');
  process.stdout.write(
    `${JSON.stringify(
      {
        token,
        otherToken,
        ownerId: owner.id,
        repositoryId: repository.id,
        repositoryName: 'bouyer-sutrasky/MoYu',
        profile: 'probe1',
        tickets: TICKETS,
        conversationId: clean.conversation.id,
        cleanConversationId: clean.conversation.id,
        dirtyConversationId: dirty.conversation.id,
        runningConversationId: running.conversation.id,
        runningTaskId: running.task.id,
        otherConversationId: other.conversation.id,
        prNumber,
        unmergedPrNumber,
        baseCommit,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
