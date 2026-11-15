import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  cleanupItemSchema,
  cleanupRunSchema,
  type CleanupItem,
  type CleanupItemState,
  type CleanupRun,
  type CleanupRunStatus,
  type CleanupRunSummary,
} from '@moyu/contracts';
import {
  cleanupItems,
  cleanupRuns,
  type CleanupItem as CleanupItemRow,
  type CleanupRun as CleanupRunRow,
  type Database,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';
import { isUniqueViolation } from '../lib/pg';
import {
  createSupervisorClient,
  type SupervisorCleanupInspection,
  type SupervisorClient,
} from '../runtime/supervisor';
import type { DatabaseTransaction } from '../events/append';
import { pullRequestState } from './review';

/**
 * Worktree cleanup orchestration.
 *
 * The platform decides eligibility from durable task facts and the real PR
 * state, then asks the host supervisor about the real directory. The supervisor
 * owns every path and refuses a dirty, unpushed, occupied or out-of-bound
 * worktree on its own as well, so a stale preview cannot become a deletion.
 */

interface Candidate {
  taskId: string;
  conversationId: string;
  repositoryId: string;
  repositoryName: string;
  ticketId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  title: string | null;
  profile: string | null;
  completedAt: Date;
}

interface ItemInsert {
  runId?: string;
  repositoryId: string;
  conversationId: string | null;
  ticketId: string;
  profile: string | null;
  directory: string | null;
  state: CleanupItemState;
  eligible: boolean;
  reason: string;
  sizeBytes: number | null;
  modifiedAt: Date | null;
  detail: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string | null | undefined): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function summaryOf(row: CleanupRunRow): CleanupRunSummary {
  return {
    candidates: row.candidates,
    eligible: row.eligible,
    skipped: row.skipped,
    removed: row.removed,
    alreadyCleaned: row.alreadyCleaned,
    failed: row.failed,
    totalBytes: row.totalBytes,
    bytesFreed: row.bytesFreed,
  };
}

function detailString(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function detailNumber(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toContractItem(row: CleanupItemRow): CleanupItem {
  return cleanupItemSchema.parse({
    id: row.id,
    ticketId: row.ticketId,
    conversationId: row.conversationId,
    repositoryId: row.repositoryId,
    repositoryName: detailString(row.detail, 'repositoryName') ?? row.repositoryId,
    profile: row.profile,
    directory: row.directory,
    state: row.state,
    eligible: row.eligible,
    reason: row.reason,
    sizeBytes: row.sizeBytes,
    modifiedAt: iso(row.modifiedAt),
    detail: row.detail,
  });
}

function toContractRun(row: CleanupRunRow, items: CleanupItemRow[]): CleanupRun {
  return cleanupRunSchema.parse({
    id: row.id,
    mode: row.mode,
    status: row.status,
    retentionDays: row.retentionDays,
    previewOfRunId: row.previewOfRunId,
    summary: summaryOf(row),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    items: items.map(toContractItem),
  });
}

async function loadRun(
  database: Database,
  ownerId: string,
  runId: string,
): Promise<{ run: CleanupRunRow; items: CleanupItemRow[] } | null> {
  const [run] = await database
    .select()
    .from(cleanupRuns)
    .where(and(eq(cleanupRuns.id, runId), eq(cleanupRuns.ownerId, ownerId)))
    .limit(1);
  if (!run) return null;
  const items = await database
    .select()
    .from(cleanupItems)
    .where(eq(cleanupItems.runId, run.id))
    .orderBy(asc(cleanupItems.createdAt), asc(cleanupItems.id));
  return { run, items };
}

/** Runs an async mapper with bounded concurrency and preserves input order. */
async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function candidateSql(input: {
  ownerId: string;
  repositoryId?: string;
  taskId?: string;
  retentionDays: number;
  limit: number;
}) {
  const repositoryFilter = input.repositoryId
    ? sql`and t.repository_id = ${input.repositoryId}`
    : sql``;
  const taskFilter = input.taskId ? sql`and t.id = ${input.taskId}` : sql``;
  const ageFilter = input.taskId
    ? sql``
    : sql`and completed_at <= now() - make_interval(days => ${input.retentionDays})`;
  return sql`
    with completed as (
      select
        t.id as task_id,
        t.conversation_id,
        t.repository_id,
        r.full_name as repository_name,
        t.upstream_ticket_id as ticket_id,
        t.pr_number,
        t.pr_url,
        c.title,
        i.profile,
        coalesce(
          (
            select max(e.occurred_at)
              from events e
             where e.task_id = t.id
               and e.type = 'task.state_changed'
               and e.payload -> 'task' ->> 'state' = 'completed'
          ),
          t.updated_at
        ) as completed_at
      from task_links t
      join conversations c on c.id = t.conversation_id and c.owner_id = ${input.ownerId}
      join repositories r on r.id = t.repository_id and r.owner_id = ${input.ownerId}
      left join repository_instances i on i.repository_id = t.repository_id
      where t.state = 'completed'
        ${repositoryFilter}
        ${taskFilter}
    )
    select * from completed
    where true
      ${ageFilter}
    order by completed_at asc, task_id asc
    limit ${input.limit}
  `;
}

function toCandidate(row: Record<string, unknown>): Candidate | null {
  const taskId = typeof row.task_id === 'string' ? row.task_id : null;
  const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : null;
  const repositoryId = typeof row.repository_id === 'string' ? row.repository_id : null;
  const repositoryName = typeof row.repository_name === 'string' ? row.repository_name : null;
  const completedAt = toDate(row.completed_at as Date | string | null | undefined);
  if (!taskId || !conversationId || !repositoryId || !repositoryName || !completedAt) {
    return null;
  }
  return {
    taskId,
    conversationId,
    repositoryId,
    repositoryName,
    ticketId: typeof row.ticket_id === 'string' ? row.ticket_id : null,
    prNumber:
      typeof row.pr_number === 'number' && Number.isInteger(row.pr_number) && row.pr_number > 0
        ? row.pr_number
        : null,
    prUrl: typeof row.pr_url === 'string' ? row.pr_url : null,
    title: typeof row.title === 'string' ? row.title : null,
    profile: typeof row.profile === 'string' ? row.profile : null,
    completedAt,
  };
}

async function loadCandidates(
  database: Database,
  input: {
    ownerId: string;
    repositoryId?: string;
    taskId?: string;
    retentionDays: number;
    limit: number;
  },
): Promise<Candidate[]> {
  const result = await database.execute(candidateSql(input));
  const rows = result.rows as unknown as Array<Record<string, unknown>>;
  return rows.map(toCandidate).filter((candidate): candidate is Candidate => candidate !== null);
}

function dayCount(from: Date, retentionDays: number): number {
  return Math.max(retentionDays, Math.floor((Date.now() - from.getTime()) / DAY_MS));
}

function skipReason(
  candidate: Candidate,
  prState: string | null,
  reason: string,
  detail: Record<string, unknown> = {},
): ItemInsert {
  return {
    repositoryId: candidate.repositoryId,
    conversationId: candidate.conversationId,
    ticketId: candidate.ticketId ?? `missing:${candidate.taskId}`,
    profile: candidate.profile,
    directory: null,
    state: 'skipped',
    eligible: false,
    reason,
    sizeBytes: null,
    modifiedAt: null,
    detail: {
      repositoryName: candidate.repositoryName,
      taskId: candidate.taskId,
      title: candidate.title,
      completedAt: candidate.completedAt.toISOString(),
      prNumber: candidate.prNumber,
      prState,
      ...detail,
    },
  };
}

function inspectionDetail(inspection: SupervisorCleanupInspection): Record<string, unknown> {
  return {
    branch: inspection.branch,
    commit: inspection.commit,
    upstream: inspection.upstream,
    ahead: inspection.ahead,
    dirty: inspection.dirty,
    dirtyEntries: inspection.dirtyEntries,
    unpushed: inspection.unpushed,
    unpushedCommits: inspection.unpushedCommits,
    occupied: inspection.occupied,
    occupiedBy: inspection.occupiedBy,
    locked: inspection.locked,
    fileCount: inspection.fileCount,
    reasons: inspection.reasons,
  };
}

function requireSupervisor(config: ApiConfig): SupervisorClient {
  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    throw ApiProblem.unavailable(
      '宿主 supervisor 未配置，无法安全解析工作目录；本次不会删除任何内容。',
    );
  }
  return supervisor;
}

async function evaluateCandidate(input: {
  config: ApiConfig;
  supervisor: SupervisorClient;
  candidate: Candidate;
}): Promise<ItemInsert> {
  const { config, supervisor, candidate } = input;
  if (!candidate.ticketId) {
    return skipReason(candidate, null, '没有运行时 ticket id，无法定位工作目录');
  }
  if (!candidate.profile) {
    return skipReason(candidate, null, '缺少实例 profile，无法定位工作目录');
  }
  if (!candidate.prNumber) {
    return skipReason(candidate, null, '没有关联 PR，无法确认已合并');
  }
  const pr = await pullRequestState(
    config,
    { fullName: candidate.repositoryName },
    { prNumber: candidate.prNumber, prUrl: candidate.prUrl },
  );
  if (!pr || pr.state !== 'merged') {
    return skipReason(
      candidate,
      pr?.state ?? 'unknown',
      pr?.state === 'open'
        ? `PR #${candidate.prNumber} 仍未合并`
        : pr?.state === 'closed'
          ? `PR #${candidate.prNumber} 已关闭但未合并`
          : `无法确认 PR #${candidate.prNumber} 已合并${pr?.unavailableReason ? `：${pr.unavailableReason}` : ''}`,
    );
  }
  const inspection = await supervisor.cleanupInspect(candidate.repositoryId, candidate.ticketId);
  if (inspection.state !== 'available' || !inspection.directory) {
    return {
      ...skipReason(candidate, pr.state, inspection.reason ?? '执行目录不可用', {
        prUrl: pr.url,
      }),
      directory: inspection.directory,
      sizeBytes: inspection.sizeBytes,
      modifiedAt: toDate(inspection.modifiedAt),
      detail: {
        repositoryName: candidate.repositoryName,
        taskId: candidate.taskId,
        title: candidate.title,
        completedAt: candidate.completedAt.toISOString(),
        prNumber: candidate.prNumber,
        prUrl: pr.url,
        prState: pr.state,
        inspectionState: inspection.state,
        ...inspectionDetail(inspection),
      },
    };
  }
  const days = dayCount(candidate.completedAt, config.cleanupRetentionDays);
  const baseDetail = {
    repositoryName: candidate.repositoryName,
    taskId: candidate.taskId,
    title: candidate.title,
    completedAt: candidate.completedAt.toISOString(),
    prNumber: candidate.prNumber,
    prUrl: pr.url,
    prState: pr.state,
    inspectionState: inspection.state,
    profile: inspection.profile,
    ...inspectionDetail(inspection),
  };
  if (!inspection.eligible) {
    return {
      repositoryId: candidate.repositoryId,
      conversationId: candidate.conversationId,
      ticketId: candidate.ticketId,
      profile: inspection.profile,
      directory: inspection.directory,
      state: 'skipped',
      eligible: false,
      reason: inspection.reasons.join('；') || '工作目录仍有未保存工作',
      sizeBytes: inspection.sizeBytes,
      modifiedAt: toDate(inspection.modifiedAt),
      detail: baseDetail,
    };
  }
  return {
    repositoryId: candidate.repositoryId,
    conversationId: candidate.conversationId,
    ticketId: candidate.ticketId,
    profile: inspection.profile,
    directory: inspection.directory,
    state: 'planned',
    eligible: true,
    reason: `PR #${candidate.prNumber} 已合并；已完成 ${days} 天（≥ ${config.cleanupRetentionDays} 天）；无未保存修改`,
    sizeBytes: inspection.sizeBytes,
    modifiedAt: toDate(inspection.modifiedAt),
    detail: baseDetail,
  };
}

function summarize(items: Array<Pick<ItemInsert, 'eligible' | 'state' | 'sizeBytes'>>): {
  candidates: number;
  eligible: number;
  skipped: number;
  totalBytes: number;
} {
  let eligible = 0;
  let skipped = 0;
  let totalBytes = 0;
  for (const item of items) {
    if (item.eligible) {
      eligible += 1;
      totalBytes += item.sizeBytes ?? 0;
    } else {
      skipped += 1;
    }
  }
  return { candidates: items.length, eligible, skipped, totalBytes };
}

async function insertItems(
  database: Database | DatabaseTransaction,
  runId: string,
  items: ItemInsert[],
): Promise<CleanupItemRow[]> {
  if (items.length === 0) return [];
  return database
    .insert(cleanupItems)
    .values(
      items.map((item) => ({
        runId,
        repositoryId: item.repositoryId,
        conversationId: item.conversationId,
        ticketId: item.ticketId,
        profile: item.profile,
        directory: item.directory,
        state: item.state,
        eligible: item.eligible,
        reason: item.reason,
        sizeBytes: item.sizeBytes,
        modifiedAt: item.modifiedAt,
        detail: item.detail,
      })),
    )
    .returning();
}

export async function previewCleanup(input: {
  config: ApiConfig;
  database: Database;
  ownerId: string;
  repositoryId?: string;
}): Promise<CleanupRun> {
  const { config, database, ownerId } = input;
  const supervisor = requireSupervisor(config);
  const candidates = await loadCandidates(database, {
    ownerId,
    repositoryId: input.repositoryId,
    retentionDays: config.cleanupRetentionDays,
    limit: config.cleanupMaxCandidates,
  });
  const items = await mapLimit(candidates, CONCURRENCY, (candidate) =>
    evaluateCandidate({ config, supervisor, candidate }),
  );
  const totals = summarize(items);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.cleanupPreviewTtlMs);

  const created = await database.transaction(async (transaction) => {
    const [run] = await transaction
      .insert(cleanupRuns)
      .values({
        ownerId,
        mode: 'preview',
        status: 'preview',
        retentionDays: config.cleanupRetentionDays,
        candidates: totals.candidates,
        eligible: totals.eligible,
        skipped: totals.skipped,
        totalBytes: totals.totalBytes,
        summary: {
          completedAt: now.toISOString(),
          beforeRemaining: totals.skipped,
        },
        expiresAt,
      })
      .returning();
    if (!run) throw new Error('cleanup run insert returned no row');
    const inserted = await insertItems(transaction, run.id, items);
    return { run, items: inserted };
  });
  return toContractRun(created.run, created.items);
}

async function candidateByTask(
  database: Database,
  ownerId: string,
  taskId: string,
): Promise<Candidate | null> {
  const rows = await loadCandidates(database, {
    ownerId,
    taskId,
    retentionDays: 0,
    limit: 1,
  });
  return rows[0] ?? null;
}

async function executeItem(input: {
  config: ApiConfig;
  supervisor: SupervisorClient;
  candidate: Candidate;
}): Promise<{
  state: CleanupItemState;
  reason: string;
  bytesFreed: number;
  directory: string | null;
  detail: Record<string, unknown>;
}> {
  const { config, supervisor, candidate } = input;
  if (!candidate.ticketId) {
    return {
      state: 'skipped',
      reason: '没有运行时 ticket id，无法定位工作目录',
      bytesFreed: 0,
      directory: null,
      detail: {},
    };
  }
  const retentionMs = config.cleanupRetentionDays * DAY_MS;
  if (Date.now() - candidate.completedAt.getTime() < retentionMs) {
    return {
      state: 'skipped',
      reason: `完成任务未满 ${config.cleanupRetentionDays} 天`,
      bytesFreed: 0,
      directory: null,
      detail: { completedAt: candidate.completedAt.toISOString() },
    };
  }
  if (!candidate.prNumber) {
    return {
      state: 'skipped',
      reason: '没有关联 PR，无法确认已合并',
      bytesFreed: 0,
      directory: null,
      detail: {},
    };
  }
  const pr = await pullRequestState(
    config,
    { fullName: candidate.repositoryName },
    { prNumber: candidate.prNumber, prUrl: candidate.prUrl },
  );
  if (!pr || pr.state !== 'merged') {
    return {
      state: 'skipped',
      reason:
        pr?.state === 'open'
          ? `PR #${candidate.prNumber} 仍未合并`
          : pr?.state === 'closed'
            ? `PR #${candidate.prNumber} 已关闭但未合并`
            : `无法确认 PR #${candidate.prNumber} 已合并`,
      bytesFreed: 0,
      directory: null,
      detail: { prState: pr?.state ?? 'unknown' },
    };
  }
  const inspection = await supervisor.cleanupInspect(candidate.repositoryId, candidate.ticketId);
  if (inspection.state === 'cleaned') {
    return {
      state: 'already_cleaned',
      reason: inspection.reason ?? '执行目录已经不存在',
      bytesFreed: 0,
      directory: null,
      detail: { inspectionState: inspection.state },
    };
  }
  if (inspection.state !== 'available' || !inspection.eligible) {
    return {
      state: 'skipped',
      reason: inspection.reason ?? inspection.reasons.join('；') ?? '工作目录仍有未保存工作',
      bytesFreed: 0,
      directory: inspection.directory,
      detail: inspectionDetail(inspection),
    };
  }
  // Purge leftovers from an earlier interrupted removal before adding another.
  const trash = await supervisor.cleanupTrash(candidate.repositoryId).catch(() => null);
  const removed = await supervisor.cleanupDelete(candidate.repositoryId, candidate.ticketId);
  if (removed.state === 'removed') {
    return {
      state: 'removed',
      reason: removed.reason,
      bytesFreed: removed.bytesFreed,
      directory: removed.directory,
      detail: {
        trashRemoved: trash?.removed ?? 0,
        trashFailures: trash?.failures ?? [],
        worktreePruned: removed.pruned,
        worktreePruneError: removed.pruneError,
        inspection: inspectionDetail(inspection),
      },
    };
  }
  if (removed.state === 'already_cleaned') {
    return {
      state: 'already_cleaned',
      reason: removed.reason,
      bytesFreed: 0,
      directory: null,
      detail: {},
    };
  }
  return {
    state: 'failed',
    reason: removed.reason,
    bytesFreed: 0,
    directory: removed.directory,
    detail: {
      trashPath: removed.trashPath,
      trashRemoved: trash?.removed ?? 0,
      trashFailures: trash?.failures ?? [],
      worktreePruned: removed.pruned,
      worktreePruneError: removed.pruneError,
    },
  };
}

function statusFor(items: Array<{ state: CleanupItemState }>): CleanupRunStatus {
  const failed = items.filter((item) => item.state === 'failed').length;
  const removed = items.filter(
    (item) => item.state === 'removed' || item.state === 'already_cleaned',
  ).length;
  if (failed === 0) return 'completed';
  return removed > 0 ? 'partial' : 'failed';
}

export async function executeCleanup(input: {
  config: ApiConfig;
  database: Database;
  ownerId: string;
  previewRunId: string;
}): Promise<{ run: CleanupRun; duplicate: boolean }> {
  const { config, database, ownerId } = input;
  const loaded = await loadRun(database, ownerId, input.previewRunId);
  if (!loaded) {
    throw ApiProblem.notFound('Cleanup preview not found');
  }
  if (loaded.run.mode !== 'preview') {
    throw ApiProblem.invalid('Only a preview run can be executed');
  }

  // One execution per preview. A repeated call returns the stored result instead
  // of deleting again, so a retried request is idempotent.
  const [existing] = await database
    .select()
    .from(cleanupRuns)
    .where(eq(cleanupRuns.previewOfRunId, loaded.run.id))
    .limit(1);
  if (existing) {
    const items = await database
      .select()
      .from(cleanupItems)
      .where(eq(cleanupItems.runId, existing.id))
      .orderBy(asc(cleanupItems.createdAt), asc(cleanupItems.id));
    return { run: toContractRun(existing, items), duplicate: true };
  }
  if (loaded.run.status !== 'preview') {
    throw ApiProblem.conflict('Cleanup preview has already been used');
  }
  if (loaded.run.expiresAt.getTime() <= Date.now()) {
    throw ApiProblem.conflict('清理预览已过期，请重新预览并确认');
  }

  const supervisor = requireSupervisor(config);
  const now = new Date();
  let created: { run: CleanupRunRow; items: CleanupItemRow[] };
  try {
    created = await database.transaction(async (transaction) => {
      const [run] = await transaction
        .insert(cleanupRuns)
        .values({
          ownerId,
          mode: 'execute',
          status: 'running',
          retentionDays: loaded.run.retentionDays,
          previewOfRunId: loaded.run.id,
          candidates: loaded.items.length,
          eligible: loaded.items.filter((item) => item.eligible).length,
          skipped: loaded.items.filter((item) => !item.eligible).length,
          totalBytes: loaded.run.totalBytes,
          expiresAt: loaded.run.expiresAt,
          startedAt: now,
          summary: { previewRunId: loaded.run.id },
        })
        .returning();
      if (!run) throw new Error('cleanup execution insert returned no row');
      const copied = await transaction
        .insert(cleanupItems)
        .values(
          loaded.items.map((item) => ({
            runId: run.id,
            repositoryId: item.repositoryId,
            conversationId: item.conversationId,
            ticketId: item.ticketId,
            profile: item.profile,
            directory: item.directory,
            state: item.eligible ? ('planned' as const) : ('skipped' as const),
            eligible: item.eligible,
            reason: item.reason,
            sizeBytes: item.sizeBytes,
            modifiedAt: item.modifiedAt,
            detail: item.detail,
          })),
        )
        .returning();
      return { run, items: copied };
    });
  } catch (error) {
    // Two concurrent confirms for the same preview: the unique index elects one
    // executor. The loser returns the winner's stored result instead of failing.
    if (!isUniqueViolation(error, 'cleanup_runs_preview_uq')) throw error;
    const [existing] = await database
      .select()
      .from(cleanupRuns)
      .where(eq(cleanupRuns.previewOfRunId, loaded.run.id))
      .limit(1);
    if (!existing) throw error;
    const items = await database
      .select()
      .from(cleanupItems)
      .where(eq(cleanupItems.runId, existing.id))
      .orderBy(asc(cleanupItems.createdAt), asc(cleanupItems.id));
    return { run: toContractRun(existing, items), duplicate: true };
  }

  let removed = 0;
  let alreadyCleaned = 0;
  let failed = 0;
  let bytesFreed = 0;
  for (const item of created.items) {
    if (!item.eligible) continue;
    const candidate = await candidateByTask(
      database,
      ownerId,
      detailString(item.detail, 'taskId') ?? '',
    );
    if (!candidate || candidate.conversationId !== item.conversationId) {
      await database
        .update(cleanupItems)
        .set({
          state: 'skipped',
          eligible: false,
          reason: '任务状态或归属已变化，跳过',
          updatedAt: new Date(),
        })
        .where(eq(cleanupItems.id, item.id));
      continue;
    }
    try {
      const result = await executeItem({ config, supervisor, candidate });
      removed += result.state === 'removed' ? 1 : 0;
      alreadyCleaned += result.state === 'already_cleaned' ? 1 : 0;
      failed += result.state === 'failed' ? 1 : 0;
      bytesFreed += result.bytesFreed;
      await database
        .update(cleanupItems)
        .set({
          state: result.state,
          eligible: false,
          reason: result.reason,
          sizeBytes: result.state === 'removed' ? (item.sizeBytes ?? null) : item.sizeBytes,
          detail: { ...item.detail, ...result.detail },
          updatedAt: new Date(),
        })
        .where(eq(cleanupItems.id, item.id));
    } catch (error) {
      failed += 1;
      await database
        .update(cleanupItems)
        .set({
          state: 'failed',
          eligible: false,
          reason: error instanceof Error ? error.message.slice(0, 500) : '清理失败',
          updatedAt: new Date(),
        })
        .where(eq(cleanupItems.id, item.id));
    }
  }

  const finishedAt = new Date();
  const itemsAfter = await database
    .select()
    .from(cleanupItems)
    .where(eq(cleanupItems.runId, created.run.id))
    .orderBy(asc(cleanupItems.createdAt), asc(cleanupItems.id));
  const status = statusFor(itemsAfter);
  const [updated] = await database
    .update(cleanupRuns)
    .set({
      status,
      removed,
      alreadyCleaned,
      failed,
      bytesFreed,
      finishedAt,
      summary: {
        previewRunId: loaded.run.id,
        finishedAt: finishedAt.toISOString(),
        trashPurged: true,
      },
      updatedAt: finishedAt,
    })
    .where(eq(cleanupRuns.id, created.run.id))
    .returning();
  if (!updated) throw new Error('cleanup run update returned no row');
  return { run: toContractRun(updated, itemsAfter), duplicate: false };
}

export async function listCleanupRuns(input: {
  database: Database;
  ownerId: string;
  limit?: number;
}): Promise<CleanupRun[]> {
  const limit = input.limit ?? 20;
  const runs = await input.database
    .select()
    .from(cleanupRuns)
    .where(eq(cleanupRuns.ownerId, input.ownerId))
    .orderBy(desc(cleanupRuns.createdAt), desc(cleanupRuns.id))
    .limit(limit);
  if (runs.length === 0) return [];
  const items = await input.database
    .select()
    .from(cleanupItems)
    .where(
      inArray(
        cleanupItems.runId,
        runs.map((run) => run.id),
      ),
    )
    .orderBy(asc(cleanupItems.createdAt), asc(cleanupItems.id));
  const byRun = new Map<string, CleanupItemRow[]>();
  for (const item of items) {
    const list = byRun.get(item.runId) ?? [];
    list.push(item);
    byRun.set(item.runId, list);
  }
  return runs.map((run) => toContractRun(run, byRun.get(run.id) ?? []));
}

/** Exported for tests: the shared summary projection of a preview. */
export const __test = { dayCount, summaryOf, detailNumber };
