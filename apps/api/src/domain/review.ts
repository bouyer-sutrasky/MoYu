import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  reviewChangesSchema,
  reviewCheckRunSchema,
  reviewChecksSchema,
  reviewPullRequestSchema,
  taskReviewSchema,
  type ReviewChanges,
  type ReviewCheckRun,
  type ReviewChecks,
  type ReviewPullRequest,
  type TaskReview,
} from '@moyu/contracts';
import {
  artifacts,
  conversations,
  repositories,
  taskLinks,
  type Conversation,
  type Database,
  type Repository,
  type TaskLink,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';
import { createSupervisorClient, SupervisorRequestError } from '../runtime/supervisor';

const execFileAsync = promisify(execFile);

/** The empty projection used before the first collection, with a stated reason. */
function pendingChanges(reason: string): ReviewChanges {
  return reviewChangesSchema.parse({
    state: 'unavailable',
    reason,
    collectedAt: null,
    branch: null,
    commit: null,
    commitSubject: null,
    committedAt: null,
    files: [],
    additions: 0,
    deletions: 0,
    filesOmitted: 0,
  });
}

function pendingChecks(): ReviewChecks {
  return reviewChecksSchema.parse({
    state: 'not_run',
    reason: null,
    collectedAt: null,
    runs: [],
  });
}

interface DiffMetadata {
  collectedAt?: string;
  changes?: unknown;
  pullRequest?: unknown;
}

interface CheckMetadata {
  collectedAt?: string;
  state?: unknown;
  reason?: unknown;
  runs?: unknown;
}

async function latestArtifact(
  database: Database,
  taskId: string,
  type: 'diff' | 'check_report',
): Promise<{ metadata: Record<string, unknown>; createdAt: Date } | null> {
  const [row] = await database
    .select({ metadata: artifacts.metadata, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.type, type)))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(1);
  return row ?? null;
}

/** Projects the stored review artifacts of one task; it never invents data. */
export async function projectReview(
  database: Database,
  task: TaskLink,
  conversation: Conversation,
): Promise<TaskReview> {
  const diffRow = await latestArtifact(database, task.id, 'diff');
  const checkRow = await latestArtifact(database, task.id, 'check_report');
  const diffMetadata = (diffRow?.metadata ?? {}) as DiffMetadata;
  const checkMetadata = (checkRow?.metadata ?? {}) as CheckMetadata;

  const parsedChanges = diffMetadata.changes
    ? reviewChangesSchema.safeParse({
        ...(diffMetadata.changes as Record<string, unknown>),
        collectedAt: diffMetadata.collectedAt ?? null,
      })
    : null;
  const changes = parsedChanges?.success
    ? parsedChanges.data
    : pendingChanges('尚未从运行时采集变更；打开详情面板后会自动采集一次。');

  const parsedChecks = checkMetadata.runs
    ? reviewChecksSchema.safeParse({
        state: checkMetadata.state ?? 'available',
        reason: checkMetadata.reason ?? null,
        collectedAt: checkMetadata.collectedAt ?? null,
        runs: Array.isArray(checkMetadata.runs)
          ? checkMetadata.runs.filter((run) => reviewCheckRunSchema.safeParse(run).success)
          : [],
      })
    : null;
  const checks = parsedChecks?.success ? parsedChecks.data : pendingChecks();

  const parsedPullRequest = diffMetadata.pullRequest
    ? reviewPullRequestSchema.safeParse(diffMetadata.pullRequest)
    : null;

  return taskReviewSchema.parse({
    taskId: task.id,
    conversationId: conversation.id,
    changes,
    checks,
    pullRequest: parsedPullRequest?.success ? parsedPullRequest.data : null,
  });
}

/**
 * Reads the pull request state from GitHub. A missing number is simply "no pull
 * request yet"; a failed query keeps the last known number and states the reason
 * instead of inferring a state.
 */
export async function pullRequestState(
  config: ApiConfig,
  repository: Pick<Repository, 'fullName'>,
  task: Pick<TaskLink, 'prNumber' | 'prUrl'>,
): Promise<ReviewPullRequest | null> {
  if (!task.prNumber) return null;
  const number = task.prNumber;
  const fallback: ReviewPullRequest = reviewPullRequestSchema.parse({
    number,
    url: task.prUrl ?? '',
    state: 'unknown',
    headSha: null,
    baseBranch: null,
    updatedAt: null,
    unavailableReason: null,
  });
  try {
    const { stdout } = await execFileAsync(
      config.githubCli,
      [
        'pr',
        'view',
        String(number),
        '--repo',
        repository.fullName,
        '--json',
        'number,url,state,headRefOid,baseRefName,updatedAt,closedAt,mergedAt',
      ],
      { timeout: 15_000, maxBuffer: 256 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      number?: number;
      url?: string;
      state?: string;
      headRefOid?: string;
      baseRefName?: string;
      updatedAt?: string;
      mergedAt?: string | null;
    };
    // `gh` reports MERGED for a merged PR; a closed-but-unmerged one stays
    // CLOSED with no mergedAt. Both are shown as what GitHub says.
    const state =
      parsed.state === 'MERGED' || parsed.mergedAt
        ? 'merged'
        : parsed.state === 'CLOSED'
          ? 'closed'
          : parsed.state === 'OPEN'
            ? 'open'
            : 'unknown';
    return reviewPullRequestSchema.parse({
      number: parsed.number ?? number,
      url: parsed.url ?? fallback.url,
      state,
      headSha: parsed.headRefOid ?? null,
      baseBranch: parsed.baseRefName ?? null,
      updatedAt: parsed.updatedAt ?? null,
      unavailableReason: state === 'unknown' ? 'GitHub 未返回可识别的 PR 状态' : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reviewPullRequestSchema.parse({
      ...fallback,
      unavailableReason: `无法从 GitHub 读取 PR 状态：${message.slice(0, 300)}`,
    });
  }
}

async function pruneOldReviews(database: Database, taskId: string, type: 'diff' | 'check_report') {
  const rows = await database
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.type, type)))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id));
  const stale = rows.slice(5).map((row) => row.id);
  if (stale.length > 0) {
    await database.delete(artifacts).where(inArray(artifacts.id, stale));
  }
}

async function storeReviewArtifact(
  database: Database,
  task: TaskLink,
  conversation: Conversation,
  type: 'diff' | 'check_report',
  metadata: Record<string, unknown>,
): Promise<void> {
  await database.insert(artifacts).values({
    repositoryId: conversation.repositoryId,
    conversationId: conversation.id,
    taskId: task.id,
    type,
    metadata,
  });
  await pruneOldReviews(database, task.id, type);
}

/**
 * Collects the current worktree diff from the supervisor and stores it with the
 * delivery state. The supervisor is the only component allowed to read the
 * runtime filesystem; this function only names a ticket id.
 */
export async function collectChanges(
  database: Database,
  config: ApiConfig,
  repository: Repository,
  task: TaskLink,
  conversation: Conversation,
): Promise<TaskReview> {
  const supervisor = createSupervisorClient(config);
  const collectedAt = new Date().toISOString();
  if (!supervisor) {
    throw ApiProblem.unavailable(
      '宿主 supervisor 未配置，无法读取运行时执行目录；不以内联占位数据代替真实 diff。',
    );
  }
  if (!task.upstreamTicketId) {
    throw ApiProblem.conflict('运行时尚未接单，还没有可读取的执行目录');
  }

  let changes: ReviewChanges;
  try {
    const payload = await supervisor.reviewChanges(repository.id, task.upstreamTicketId);
    changes = reviewChangesSchema.parse({
      state: payload.state,
      reason: payload.reason,
      collectedAt,
      branch: payload.branch,
      commit: payload.commit,
      commitSubject: payload.commitSubject,
      committedAt: payload.committedAt,
      files: payload.files,
      additions: payload.additions,
      deletions: payload.deletions,
      filesOmitted: payload.filesOmitted,
    });
  } catch (error) {
    throw ApiProblem.unavailable(
      `宿主 supervisor 无法读取执行目录：${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    );
  }

  const pullRequest = await pullRequestState(config, repository, task);
  await storeReviewArtifact(database, task, conversation, 'diff', {
    collectedAt,
    changes,
    pullRequest,
  });
  return projectReview(database, task, conversation);
}

/** Runs the configured check commands in the ticket worktree and stores the result. */
export async function runChecks(
  database: Database,
  config: ApiConfig,
  repository: Repository,
  task: TaskLink,
  conversation: Conversation,
): Promise<TaskReview> {
  const supervisor = createSupervisorClient(config);
  const collectedAt = new Date().toISOString();
  if (!supervisor) {
    throw ApiProblem.unavailable(
      '宿主 supervisor 未配置，无法在运行时执行目录中运行检查；不伪造检查结果。',
    );
  }
  if (!task.upstreamTicketId) {
    throw ApiProblem.conflict('运行时尚未接单，还没有可运行检查的执行目录');
  }
  let runs: ReviewCheckRun[];
  try {
    const result = await supervisor.reviewChecks(repository.id, task.upstreamTicketId);
    runs = result.runs.map((run) => reviewCheckRunSchema.parse(run));
  } catch (error) {
    if (error instanceof SupervisorRequestError) {
      if (error.statusCode === 422) {
        throw ApiProblem.invalid(error.message);
      }
      if (error.statusCode === 409) {
        throw ApiProblem.conflict(error.message);
      }
      if (error.statusCode === 404) {
        throw ApiProblem.notFound(error.message);
      }
    }
    throw ApiProblem.unavailable(
      `无法在运行时执行目录中运行检查：${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    );
  }
  await storeReviewArtifact(database, task, conversation, 'check_report', {
    collectedAt,
    state: 'available',
    reason: null,
    runs,
  });
  return projectReview(database, task, conversation);
}

/** Loads a task and its conversation for the owner, or 404. */
export async function loadOwnedTask(
  database: Database,
  ownerId: string,
  taskId: string,
): Promise<{ task: TaskLink; conversation: Conversation; repository: Repository }> {
  const [row] = await database
    .select({ task: taskLinks, conversation: conversations, repository: repositories })
    .from(taskLinks)
    .innerJoin(conversations, eq(taskLinks.conversationId, conversations.id))
    .innerJoin(repositories, eq(repositories.id, conversations.repositoryId))
    .where(and(eq(taskLinks.id, taskId), eq(repositories.ownerId, ownerId)))
    .limit(1);
  if (!row) {
    throw ApiProblem.notFound('Task not found');
  }
  return row;
}
