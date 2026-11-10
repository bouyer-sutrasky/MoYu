#!/usr/bin/env node
/**
 * Seeds the isolated M6-A acceptance database: the owner and a second owner for
 * the cross-owner refusal cases, one repository bound to the local supervisor
 * instance (`probe1`), and three tasks:
 *
 *   - main    : a runtime ticket id and a real worktree with changes plus an open PR
 *   - cleaned : a runtime ticket id whose worktree is absent (cleanup boundary)
 *   - closed  : a clean worktree and a closed, unmerged PR
 *
 * The task rows are not review data: the diff, checks, commit and PR state in
 * the panel are collected from the real worktree and GitHub afterwards.
 */
import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const ticketId = process.env.M6A_TICKET_ID ?? `t_${randomBytes(16).toString('hex')}`;
const cleanedTicketId = process.env.M6A_CLEANED_TICKET_ID ?? `t_${randomBytes(16).toString('hex')}`;
const closedTicketId = process.env.M6A_CLOSED_TICKET_ID ?? `t_${randomBytes(16).toString('hex')}`;
const prNumber = process.env.M6A_PR_NUMBER ? Number(process.env.M6A_PR_NUMBER) : null;
const prUrl = process.env.M6A_PR_URL ?? null;
const closedPrNumber = process.env.M6A_CLOSED_PR_NUMBER
  ? Number(process.env.M6A_CLOSED_PR_NUMBER)
  : null;
const closedPrUrl = process.env.M6A_CLOSED_PR_URL ?? null;
const baseCommit = process.env.M6A_BASE_COMMIT ?? 'd02f07f1483e0c85a13c1dfe24d03d855a72d0a1';
const token = process.env.M6A_SESSION_TOKEN ?? randomBytes(32).toString('base64url');
const otherToken = process.env.M6A_OTHER_TOKEN ?? randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

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
    `insert into repository_instances (repository_id, state, desired_state, reason_code, profile, port)
     values ($1, 'sleeping', 'sleeping', 'never_started', 'probe1', 4692)
     on conflict (repository_id) do update set profile = 'probe1', port = 4692`,
    [repository.id],
  );

  const createTask = async (input) => {
    const conversation = (
      await client.query(
        `insert into conversations
           (owner_id, repository_id, mode, execution_mode, source, base_branch, base_commit, title)
         values ($1, $2, 'work', 'execute', 'web', 'main', $3, $4) returning id`,
        [owner.id, repository.id, baseCommit, input.title],
      )
    ).rows[0];
    const task = (
      await client.query(
        `insert into task_links
           (conversation_id, repository_id, state, upstream_ticket_id, base_branch, base_commit,
            execution_mode, pr_url, pr_number)
         values ($1, $2, 'awaiting_review', $3, 'main', $4, 'execute', $5, $6) returning id`,
        [
          conversation.id,
          repository.id,
          input.ticketId,
          baseCommit,
          input.prUrl ?? null,
          input.prNumber ?? null,
        ],
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
      'insert into deliveries (message_id, upstream_trigger_id, state) values ($1, $2, $3)',
      [message.id, `workspace:${message.id}`, 'delivered'],
    );
    return { conversationId: conversation.id, taskId: task.id };
  };

  const main = await createTask({
    title: 'M6-A 变更与检查面板验收',
    ticketId,
    body: '请实现附件与审阅面板，并按验收项提供证据。',
    prNumber,
    prUrl,
  });
  const cleaned = await createTask({
    title: '已清理工作目录的任务',
    ticketId: cleanedTicketId,
    body: '这个任务的工作目录将被清理，用于验证面板不显示空白或报错。',
  });
  const closed = await createTask({
    title: 'PR 关闭但未合并的任务',
    ticketId: closedTicketId,
    body: '用于验证 PR 关闭未合并时不显示 merged。',
    prNumber: closedPrNumber,
    prUrl: closedPrUrl,
  });

  // A second owner, repository and conversation for the cross-owner refusals.
  const otherOwner = (
    await client.query("insert into owners (display_name) values ('M6A Other Owner') returning id")
  ).rows[0];
  const otherRepository = (
    await client.query(
      `insert into repositories (owner_id, full_name, default_branch, status)
       values ($1, 'bouyer-sutrasky/m6a-other-owner', 'main', 'active') returning id`,
      [otherOwner.id],
    )
  ).rows[0];
  const otherConversation = (
    await client.query(
      `insert into conversations
         (owner_id, repository_id, mode, execution_mode, source, base_branch, base_commit, title)
       values ($1, $2, 'work', 'execute', 'web', 'main', $3, '其他所有者的会话') returning id`,
      [otherOwner.id, otherRepository.id, baseCommit],
    )
  ).rows[0];
  await client.query(
    `insert into task_links (conversation_id, repository_id, state, base_branch, base_commit, execution_mode)
     values ($1, $2, 'awaiting_review', 'main', $3, 'execute')`,
    [otherConversation.id, otherRepository.id, baseCommit],
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
        ticketId,
        cleanedTicketId,
        closedTicketId,
        taskId: main.taskId,
        conversationId: main.conversationId,
        cleanedTaskId: cleaned.taskId,
        cleanedConversationId: cleaned.conversationId,
        closedTaskId: closed.taskId,
        closedConversationId: closed.conversationId,
        otherConversationId: otherConversation.id,
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
