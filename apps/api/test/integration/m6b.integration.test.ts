import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activityDataSchema,
  cleanupExecuteDataSchema,
  cleanupPreviewDataSchema,
  historySearchDataSchema,
} from '@moyu/contracts';
import {
  conversations,
  events,
  messages,
  owners,
  repositories,
  sessions,
  taskLinks,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

const SUPERVISOR_TOKEN = 'm6b-supervisor-token-0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Inspection {
  ticketId: string;
  state: string;
  reason: string | null;
  directory: string | null;
  profile: string | null;
  branch: string | null;
  commit: string | null;
  upstream: string | null;
  ahead: number | null;
  dirty: boolean;
  dirtyEntries: number;
  unpushed: boolean;
  unpushedCommits: number | null;
  occupied: boolean;
  occupiedBy: Array<{ pid: number; command: string }>;
  locked: boolean;
  sizeBytes: number | null;
  fileCount: number;
  modifiedAt: string | null;
  eligible: boolean;
  reasons: string[];
}

function envelope(payload: unknown): Record<string, unknown> {
  return (payload as { data: Record<string, unknown> }).data;
}

function errorCode(payload: unknown): string {
  return (payload as { error: { code: string } }).error.code;
}

function fakeInspection(ticketId: string, eligible: boolean): Inspection {
  return {
    ticketId,
    state: 'available',
    reason: null,
    directory: `/tmp/moyu-cleanup-test/${ticketId}`,
    profile: 'probe1',
    branch: 'agent/test',
    commit: 'a'.repeat(40),
    upstream: 'origin/agent/test',
    ahead: 0,
    dirty: !eligible,
    dirtyEntries: eligible ? 0 : 1,
    unpushed: false,
    unpushedCommits: null,
    occupied: false,
    occupiedBy: [],
    locked: false,
    sizeBytes: 4096,
    fileCount: 4,
    modifiedAt: new Date().toISOString(),
    eligible,
    reasons: eligible ? ['已合并且无未保存修改'] : ['有未提交或未跟踪改动（1 项）'],
  } as Inspection;
}

async function startFakeSupervisor() {
  const state = {
    inspections: new Map<string, Inspection>(),
    deletes: [] as string[],
  };
  const server: Server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${SUPERVISOR_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ticketId?: string })
        : {};
      const url = new URL(request.url ?? '/', 'http://supervisor.test');
      const ticketId = body.ticketId ?? '';
      const send = (data: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data }));
      };
      if (url.pathname.endsWith('/cleanup/inspect')) {
        send(state.inspections.get(ticketId) ?? fakeInspection(ticketId, true));
        return;
      }
      if (url.pathname.endsWith('/cleanup/delete')) {
        state.deletes.push(ticketId);
        send({
          state: 'removed',
          directory: `/tmp/moyu-cleanup-test/${ticketId}`,
          trashPath: null,
          bytesFreed: 4096,
          reason: '已删除',
        });
        return;
      }
      if (url.pathname.endsWith('/cleanup/trash')) {
        send({ removed: 0, bytesFreed: 0, failures: [] });
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found', message: 'unknown route' } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('M6-B activity, history and cleanup on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let app: FastifyInstance;
  let cookie = '';
  let otherCookie = '';
  let repositoryId = '';
  let otherRepositoryId = '';
  let dirtyTaskId = '';
  let conversationId = '';
  let fakeSupervisor: Awaited<ReturnType<typeof startFakeSupervisor>>;
  let githubCliDir = '';
  let previousGithubState: string | undefined;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;
    fakeSupervisor = await startFakeSupervisor();

    // A fake GitHub CLI returns a deterministic PR state; it is a test seam for
    // the merge check, not a stand-in for the worktree or the deletion path.
    githubCliDir = mkdtempSync(join(tmpdir(), 'moyu-m6b-gh-'));
    const githubCli = join(githubCliDir, 'gh');
    writeFileSync(
      githubCli,
      `#!/bin/sh
state="${'${GH_FAKE_STATE:-merged}'}"
case "$state" in
  open) printf '%s' '{"number":7,"url":"https://example.invalid/pull/7","state":"OPEN","headRefOid":"${'a'.repeat(40)}","baseRefName":"main","updatedAt":"2026-11-01T00:00:00Z","closedAt":null,"mergedAt":null}' ;;
  closed) printf '%s' '{"number":7,"url":"https://example.invalid/pull/7","state":"CLOSED","headRefOid":"${'a'.repeat(40)}","baseRefName":"main","updatedAt":"2026-11-01T00:00:00Z","closedAt":"2026-11-01T00:00:00Z","mergedAt":null}' ;;
  *) printf '%s' '{"number":7,"url":"https://example.invalid/pull/7","state":"MERGED","headRefOid":"${'a'.repeat(40)}","baseRefName":"main","updatedAt":"2026-11-01T00:00:00Z","closedAt":null,"mergedAt":"2026-11-01T00:00:00Z"}' ;;
esac
`,
    );
    chmodSync(githubCli, 0o755);
    previousGithubState = process.env.GH_FAKE_STATE;

    const [owner] = await database.insert(owners).values({ displayName: 'M6B Owner' }).returning();
    const [otherOwner] = await database
      .insert(owners)
      .values({ displayName: 'M6B Other Owner' })
      .returning();
    if (!owner || !otherOwner) throw new Error('owner insert returned no row');

    const [repository] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/m6b-history',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    const [otherRepository] = await database
      .insert(repositories)
      .values({
        ownerId: otherOwner.id,
        fullName: 'Bouyer12/m6b-other',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    if (!repository || !otherRepository) throw new Error('repository insert returned no row');
    repositoryId = repository.id;
    otherRepositoryId = otherRepository.id;
    await database.execute(
      sql`insert into repository_instances (repository_id, state, desired_state, reason_code, profile)
          values (${repository.id}, 'sleeping', 'sleeping', 'never_started', 'probe1')`,
    );

    const insertConversation = async (input: {
      owner: string;
      repository: string;
      title: string;
      body: string;
      state: string | null;
      ticketId: string | null;
      prNumber: number | null;
      completedAt?: Date;
    }) => {
      const [conversation] = await database
        .insert(conversations)
        .values({
          ownerId: input.owner,
          repositoryId: input.repository,
          mode: 'work',
          executionMode: 'execute',
          baseBranch: 'main',
          title: input.title,
        })
        .returning();
      if (!conversation) throw new Error('conversation insert returned no row');
      await database.insert(messages).values({
        conversationId: conversation.id,
        direction: 'inbound',
        kind: 'user',
        body: input.body,
        source: 'web',
      });
      if (!input.state) return { conversation, task: null };
      const [task] = await database
        .insert(taskLinks)
        .values({
          conversationId: conversation.id,
          repositoryId: input.repository,
          state: input.state as never,
          upstreamTicketId: input.ticketId,
          prNumber: input.prNumber,
          prUrl: input.prNumber ? `https://example.invalid/pull/${input.prNumber}` : null,
          baseBranch: 'main',
        })
        .returning();
      if (!task) throw new Error('task insert returned no row');
      return { conversation, task };
    };

    const older = new Date(Date.now() - 8 * DAY_MS);
    const completed = await insertConversation({
      owner: owner.id,
      repository: repository.id,
      title: '清理旧的已合并任务',
      body: '这个任务里包含关键字 星河 以及特殊字符 100%_safe',
      state: 'completed',
      ticketId: 't_completed_abcdef1234567890',
      prNumber: 7,
    });
    const dirty = await insertConversation({
      owner: owner.id,
      repository: repository.id,
      title: '有未保存修改的任务',
      body: '这个任务里也包含 星河',
      state: 'completed',
      ticketId: 't_dirty_abcdef1234567890',
      prNumber: 7,
    });
    dirtyTaskId = dirty.task!.id;
    const review = await insertConversation({
      owner: owner.id,
      repository: repository.id,
      title: '等待审阅的任务',
      body: '普通正文',
      state: 'awaiting_review',
      ticketId: 't_review_abcdef1234567890',
      prNumber: 7,
    });
    await insertConversation({
      owner: owner.id,
      repository: repository.id,
      title: '正在执行的任务',
      body: '运行中正文',
      state: 'running',
      ticketId: 't_running_abcdef1234567890',
      prNumber: null,
    });
    const other = await insertConversation({
      owner: otherOwner.id,
      repository: otherRepository.id,
      title: '另一个所有者的 星河 任务',
      body: 'cross owner secret 星河',
      state: 'completed',
      ticketId: 't_other_abcdef1234567890',
      prNumber: 7,
    });
    conversationId = completed.conversation.id;

    // Completion time is carried by the durable event just like the dispatcher
    // writes it; nothing here mutates the task row's clock.
    await database.insert(events).values([
      {
        type: 'task.state_changed',
        repositoryId: repository.id,
        conversationId: completed.conversation.id,
        taskId: completed.task!.id,
        payload: { task: { state: 'completed' } },
        occurredAt: older,
      },
      {
        type: 'task.state_changed',
        repositoryId: repository.id,
        conversationId: dirty.conversation.id,
        taskId: dirtyTaskId,
        payload: { task: { state: 'completed' } },
        occurredAt: older,
      },
      {
        type: 'task.state_changed',
        repositoryId: repository.id,
        conversationId: review.conversation.id,
        taskId: review.task!.id,
        payload: { task: { state: 'awaiting_review' } },
        occurredAt: new Date(Date.now() - 60_000),
      },
      {
        type: 'task.question',
        repositoryId: repository.id,
        conversationId: review.conversation.id,
        taskId: review.task!.id,
        payload: { task: { state: 'waiting_input', question: '请确认是否继续？' } },
        occurredAt: new Date(Date.now() - 30_000),
      },
      {
        type: 'task.state_changed',
        repositoryId: otherRepository.id,
        conversationId: other.conversation.id,
        taskId: other.task!.id,
        payload: { task: { state: 'completed' } },
        occurredAt: older,
      },
    ]);

    fakeSupervisor.state.inspections.set(
      't_completed_abcdef1234567890',
      fakeInspection('t_completed_abcdef1234567890', true),
    );
    fakeSupervisor.state.inspections.set(
      't_dirty_abcdef1234567890',
      fakeInspection('t_dirty_abcdef1234567890', false),
    );

    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3230',
      WEBAUTHN_RP_ID: '127.0.0.1',
      SUPERVISOR_URL: fakeSupervisor.url,
      SUPERVISOR_TOKEN,
      GITHUB_CLI: githubCli,
    });
    const token = randomToken(32);
    const otherToken = randomToken(32);
    await database.insert(sessions).values([
      {
        ownerId: owner.id,
        tokenHash: hashSecret(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        ownerId: otherOwner.id,
        tokenHash: hashSecret(otherToken),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    cookie = `${sessionCookieName(config)}=${token}`;
    otherCookie = `${sessionCookieName(config)}=${otherToken}`;

    app = buildApp({ config, database });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await fakeSupervisor?.close();
    if (previousGithubState === undefined) delete process.env.GH_FAKE_STATE;
    else process.env.GH_FAKE_STATE = previousGithubState;
    if (githubCliDir) rmSync(githubCliDir, { recursive: true, force: true });
    await testDatabase?.drop();
  });

  it('returns only the owner activity with real categories and running tasks', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?limit=50',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const data = activityDataSchema.parse(envelope(response.json()));
    expect(data.notifications.length).toBeGreaterThanOrEqual(2);
    expect(data.notifications.every((item) => item.repositoryId !== otherRepositoryId)).toBe(true);
    expect(data.notifications.some((item) => item.category === 'review')).toBe(true);
    const question = data.notifications.find((item) => item.category === 'needs_reply');
    expect(question?.summary).toContain('请确认');
    expect(data.running.some((item) => item.state === 'running')).toBe(true);

    const otherResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/activity',
      headers: { cookie: otherCookie },
    });
    const otherData = activityDataSchema.parse(envelope(otherResponse.json()));
    expect(otherData.notifications.some((item) => item.conversationId === conversationId)).toBe(
      false,
    );
  });

  it('searches titles and message bodies literally and scopes pages to the owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/history/search?q=${encodeURIComponent('星河')}&limit=1`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const first = historySearchDataSchema.parse(envelope(response.json()));
    expect(first.items.length).toBe(1);
    expect(first.items.every((item) => item.repository.id === repositoryId)).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/history/search?q=${encodeURIComponent('星河')}&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      headers: { cookie },
    });
    const next = historySearchDataSchema.parse(envelope(second.json()));
    expect(next.items[0]!.conversation.id).not.toBe(first.items[0]!.conversation.id);

    const crossOwner = await app.inject({
      method: 'GET',
      url: `/api/v1/history/search?q=${encodeURIComponent('cross owner secret')}`,
      headers: { cookie },
    });
    expect(historySearchDataSchema.parse(envelope(crossOwner.json())).items).toEqual([]);
  });

  it('handles empty, overlong and special-character keywords without a server error', async () => {
    const special = await app.inject({
      method: 'GET',
      url: `/api/v1/history/search?q=${encodeURIComponent('100%_safe')}`,
      headers: { cookie },
    });
    expect(special.statusCode).toBe(200);
    expect(historySearchDataSchema.parse(envelope(special.json())).items.length).toBe(1);

    const long = await app.inject({
      method: 'GET',
      url: `/api/v1/history/search?q=${encodeURIComponent('星'.repeat(1500))}`,
      headers: { cookie },
    });
    expect(long.statusCode).toBe(200);
    expect(historySearchDataSchema.parse(envelope(long.json())).items).toEqual([]);

    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/history/search?q=',
      headers: { cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(historySearchDataSchema.parse(envelope(empty.json())).items.length).toBeGreaterThan(0);
  });

  it('previews merged clean worktrees and skips dirty or unmerged candidates', async () => {
    process.env.GH_FAKE_STATE = 'merged';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/preview',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const preview = cleanupPreviewDataSchema.parse(envelope(response.json())).run;
    expect(preview.mode).toBe('preview');
    expect(
      preview.items.some((item) => item.eligible && item.ticketId.startsWith('t_completed')),
    ).toBe(true);
    const dirty = preview.items.find((item) => item.ticketId.startsWith('t_dirty'));
    expect(dirty?.eligible).toBe(false);
    expect(dirty?.reason).toContain('未提交');
    expect(preview.items.every((item) => item.repositoryId === repositoryId)).toBe(true);
  });

  it('executes a confirmed preview once, returns the stored result on retry, and never deletes another owner', async () => {
    process.env.GH_FAKE_STATE = 'merged';
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/preview',
      headers: { cookie },
      payload: {},
    });
    const preview = cleanupPreviewDataSchema.parse(envelope(previewResponse.json())).run;
    expect(preview.summary.eligible).toBe(1);
    fakeSupervisor.state.deletes = [];

    const execute = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/execute',
      headers: { cookie },
      payload: { runId: preview.id },
    });
    expect(execute.statusCode).toBe(200);
    const first = cleanupExecuteDataSchema.parse(envelope(execute.json()));
    expect(first.duplicate).toBe(false);
    expect(first.run.summary.removed).toBe(1);
    expect(fakeSupervisor.state.deletes).toEqual(['t_completed_abcdef1234567890']);

    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/execute',
      headers: { cookie },
      payload: { runId: preview.id },
    });
    expect(retry.statusCode).toBe(200);
    const second = cleanupExecuteDataSchema.parse(envelope(retry.json()));
    expect(second.duplicate).toBe(true);
    expect(fakeSupervisor.state.deletes).toEqual(['t_completed_abcdef1234567890']);

    const crossOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/execute',
      headers: { cookie: otherCookie },
      payload: { runId: preview.id },
    });
    expect(crossOwner.statusCode).toBe(404);
    expect(errorCode(crossOwner.json())).toBe('not_found');
  });

  it('skips deletion when the PR is no longer merged at execution time', async () => {
    process.env.GH_FAKE_STATE = 'merged';
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/preview',
      headers: { cookie },
      payload: {},
    });
    const preview = cleanupPreviewDataSchema.parse(envelope(previewResponse.json())).run;
    fakeSupervisor.state.deletes = [];
    process.env.GH_FAKE_STATE = 'open';
    const execute = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/execute',
      headers: { cookie },
      payload: { runId: preview.id },
    });
    const result = cleanupExecuteDataSchema.parse(envelope(execute.json()));
    expect(result.run.summary.removed).toBe(0);
    expect(fakeSupervisor.state.deletes).toEqual([]);
    expect(result.run.items.find((item) => item.ticketId.startsWith('t_completed'))?.state).toBe(
      'skipped',
    );
  });

  it('rejects an expired preview instead of deleting later', async () => {
    process.env.GH_FAKE_STATE = 'merged';
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/preview',
      headers: { cookie },
      payload: {},
    });
    const preview = cleanupPreviewDataSchema.parse(envelope(previewResponse.json())).run;
    await testDatabase.pool.query(
      `update cleanup_runs set expires_at = now() - interval '1 minute' where id = $1`,
      [preview.id],
    );
    const execute = await app.inject({
      method: 'POST',
      url: '/api/v1/cleanup/execute',
      headers: { cookie },
      payload: { runId: preview.id },
    });
    expect(execute.statusCode).toBe(409);
    expect(errorCode(execute.json())).toBe('conflict');
  });

  it('returns cleanup history for the owner only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/cleanup/runs',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const runs = (envelope(response.json()) as { runs: Array<{ items: unknown[] }> }).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => Array.isArray(run.items))).toBe(true);

    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/cleanup/runs',
      headers: { cookie: otherCookie },
    });
    expect((envelope(other.json()) as { runs: unknown[] }).runs).toEqual([]);
  });
});
