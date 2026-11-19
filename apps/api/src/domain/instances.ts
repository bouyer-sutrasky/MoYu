import { and, desc, eq, max } from 'drizzle-orm';

import type {
  RepositoryGitPreparation,
  RepositoryActivation,
  RepositoryRuntime,
  RepositoryRuntimeAction,
  RuntimeInstanceState,
  RuntimeLeaseProjection,
  RuntimeResource,
} from '@moyu/contracts';
import {
  repositoryInstances,
  runtimeLeases,
  taskLinks,
  type Database,
  type Repository,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import { createSupervisorClient, type SupervisorInstance } from '../runtime/supervisor';
import { ApiProblem } from '../lib/errors';

const ACTIVE_STATES = ['pending_admission', 'queued', 'discussing', 'running', 'stopping'] as const;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*\S+/gi, 'token=[redacted]')
    .slice(0, 400);
}

function baseActionsFor(
  state: RuntimeInstanceState,
  reasonCode: string,
  executionSlot: 'free' | 'busy' | 'unknown',
): RepositoryRuntimeAction[] {
  const wake = (enabled: boolean, reason: string | null): RepositoryRuntimeAction => ({
    action: 'wake',
    label: '唤醒实例',
    enabled,
    unavailableReason: reason,
  });
  const sleep = (enabled: boolean, reason: string | null): RepositoryRuntimeAction => ({
    action: 'sleep',
    label: '休眠实例',
    enabled,
    unavailableReason: reason,
  });
  const retry: RepositoryRuntimeAction = {
    action: 'retry',
    label: '重试启动',
    enabled: true,
    unavailableReason: null,
  };
  switch (state) {
    case 'sleeping':
      if (reasonCode === 'capacity_wait') {
        return [wake(false, '已进入唤醒队列，等待在线名额'), sleep(false, '实例不在线')];
      }
      if (reasonCode === 'resource_wait' || reasonCode === 'resource_over_budget') {
        return [wake(false, '等待实测内存余量恢复'), sleep(false, '实例不在线')];
      }
      return [wake(true, null), sleep(false, '实例不在线')];
    case 'starting':
      return [wake(false, '实例正在启动'), sleep(true, null)];
    case 'online':
      return [
        wake(false, '实例已在线'),
        sleep(
          executionSlot === 'busy' ? false : true,
          executionSlot === 'busy' ? '有任务正在执行；完成后或等待人工时才能休眠' : null,
        ),
      ];
    case 'stopping':
      if (reasonCode === 'stop_failed') {
        return [
          wake(false, '旧进程尚未完全退出'),
          {
            action: 'retry_stop',
            label: '重试停止',
            enabled: true,
            unavailableReason: null,
          },
        ];
      }
      return [wake(false, '实例正在停止'), sleep(false, '实例正在停止')];
    case 'fault':
      return [retry, sleep(false, '先重试启动')];
    default:
      return [wake(false, '状态未知'), sleep(false, '状态未知')];
  }
}

const GIT_PHASE_LABELS: Record<string, string> = {
  connecting: '连接远端',
  receiving: '接收对象',
  resolving: '解析差异',
  finalizing: '写入对象',
  verifying: '核对副本',
  ready: '就绪',
};

/** The owner-facing preparation action; readiness gates new execution, not settings. */
function preparationAction(preparation: RepositoryGitPreparation): RepositoryRuntimeAction {
  if (preparation.state === 'preparing') {
    const phase = preparation.phase
      ? (GIT_PHASE_LABELS[preparation.phase] ?? preparation.phase)
      : '准备中';
    return {
      action: 'prepare',
      label: '仓库副本准备中…',
      enabled: false,
      unavailableReason: `仓库副本正在准备（${phase}）`,
    };
  }
  if (preparation.state === 'failed') {
    return {
      action: 'prepare',
      label: '重试准备仓库副本',
      enabled: true,
      unavailableReason: null,
    };
  }
  if (preparation.state === 'ready') {
    return {
      action: 'prepare',
      label: '刷新仓库副本',
      enabled: true,
      unavailableReason: null,
    };
  }
  return {
    action: 'prepare',
    label: '准备仓库副本',
    enabled: true,
    unavailableReason: null,
  };
}

function actionsFor(
  state: RuntimeInstanceState,
  reasonCode: string,
  executionSlot: 'free' | 'busy' | 'unknown',
  preparation: RepositoryGitPreparation,
): RepositoryRuntimeAction[] {
  return [...baseActionsFor(state, reasonCode, executionSlot), preparationAction(preparation)];
}

/** The Chinese explanation for a preparation that blocks a new execution. */
function preparationReason(preparation: RepositoryGitPreparation): string | null {
  if (preparation.state === 'preparing') {
    const phase = preparation.phase
      ? (GIT_PHASE_LABELS[preparation.phase] ?? preparation.phase)
      : '准备中';
    const percent = preparation.progress === null ? '' : ` ${preparation.progress}%`;
    return `仓库副本准备中：${phase}${percent}。准备好之前不会接受新任务；无需重新添加仓库。`;
  }
  if (preparation.state === 'failed') {
    const detail = (preparation.detail ?? '原因未知').replace(/^仓库副本准备失败[：:]\s*/, '');
    return `仓库副本准备失败：${detail} 请使用「重试准备仓库副本」后继续。`;
  }
  return null;
}

export function emptyPreparation(): RepositoryGitPreparation {
  return {
    state: 'none',
    phase: null,
    progress: null,
    detail: null,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    headCommit: null,
  };
}

/** The persisted preparation projection, shared by the runtime view and the execution gate. */
export function preparationFor(instance: SupervisorInstance): RepositoryGitPreparation {
  return {
    state: instance.gitState,
    phase: (instance.gitPhase as RepositoryGitPreparation['phase']) ?? null,
    progress: instance.gitProgress,
    detail: safeDetail(instance.gitDetail),
    startedAt: instance.gitStartedAt,
    finishedAt: instance.gitFinishedAt,
    attempts: instance.gitAttempts,
    headCommit: instance.gitHead,
  };
}

const QUEUED_REASONS = new Set(['capacity_wait', 'resource_wait', 'resource_over_budget']);

/**
 * The measured activation path: request -> queue -> repository copy ->
 * process start -> online. Values come from persisted timestamps and the actual
 * preparation row, so a long switch is explained by its real phase rather than
 * one indefinite "starting" label.
 */
export function activationFor(
  instance: SupervisorInstance,
  preparation: RepositoryGitPreparation,
  now: Date = new Date(),
): RepositoryActivation {
  const requestedAt = instance.activationRequestedAt
    ? new Date(instance.activationRequestedAt)
    : null;
  const onlineAt = instance.lastOnlineAt ? new Date(instance.lastOnlineAt) : null;
  let phase: RepositoryActivation['phase'];
  if (instance.state === 'fault' || preparation.state === 'failed') {
    phase = 'failed';
  } else if (instance.state === 'starting') {
    phase = 'starting';
  } else if (preparation.state === 'preparing') {
    phase = 'preparing';
  } else if (instance.state === 'online' && preparation.state === 'ready') {
    phase = 'ready';
  } else if (
    instance.desiredState === 'online' &&
    (instance.state === 'sleeping' || instance.state === 'stopping')
  ) {
    phase = 'queued';
  } else {
    phase = 'idle';
  }
  const readyMs =
    requestedAt && onlineAt ? Math.max(0, onlineAt.getTime() - requestedAt.getTime()) : null;
  // A failed activation has no end timestamp; do not keep counting time as if
  // it were still progressing. The failure detail explains where it stopped.
  const live =
    phase === 'queued' || phase === 'preparing' || phase === 'starting' || phase === 'ready';
  const elapsedMs =
    requestedAt && live
      ? Math.max(
          0,
          (phase === 'ready' && onlineAt ? onlineAt : now).getTime() - requestedAt.getTime(),
        )
      : null;
  const detail =
    phase === 'failed'
      ? (safeDetail(instance.reasonDetail) ?? preparation.detail)
      : phase === 'preparing'
        ? preparation.detail
        : phase === 'queued'
          ? (safeDetail(instance.reasonDetail) ??
            (QUEUED_REASONS.has(instance.reasonCode) ? '等待在线名额或内存余量' : null))
          : null;
  const retryAction: RepositoryActivation['retryAction'] =
    phase === 'failed'
      ? preparation.state === 'failed'
        ? 'prepare'
        : 'retry'
      : phase === 'idle' && instance.state === 'sleeping'
        ? 'wake'
        : null;
  return {
    phase,
    requestedAt: iso(requestedAt),
    onlineAt: iso(onlineAt),
    elapsedMs,
    readyMs,
    detail,
    retryAction,
  };
}

function reasonFor(
  instance: Pick<SupervisorInstance, 'state' | 'reasonCode' | 'reasonDetail' | 'lastHealthAt'>,
): { reasonCode: string; reason: string; listener: 'active' | 'paused' | 'unknown' } {
  const detail = safeDetail(instance.reasonDetail);
  switch (instance.state) {
    case 'sleeping':
      if (instance.reasonCode === 'capacity_wait') {
        return {
          reasonCode: 'capacity_wait',
          reason: '已在唤醒队列中：两个在线实例名额都在使用，释放或最久无交互淘汰后启动。',
          listener: 'paused',
        };
      }
      if (
        instance.reasonCode === 'resource_wait' ||
        instance.reasonCode === 'resource_over_budget'
      ) {
        return {
          reasonCode: instance.reasonCode,
          reason: detail
            ? `等待内存余量：${detail}。不会启动新实例，也不会为腾出内存杀死正在工作的任务。`
            : '内存余量不足，暂不启动新实例；等待已实测的余量恢复。',
          listener: 'paused',
        };
      }
      return {
        reasonCode: instance.reasonCode || 'sleeping',
        reason: '仓库休眠。GitHub 监听已暂停，GitHub @ 不会自动唤醒；网页提交或回复会请求唤醒。',
        listener: 'paused',
      };
    case 'starting':
      return {
        reasonCode: 'starting',
        reason: '实例启动中：正在核验独立 profile、state、端口与 Bridge。',
        listener: 'unknown',
      };
    case 'online': {
      if (instance.reasonCode === 'sleep_refused') {
        return {
          reasonCode: 'sleep_refused',
          reason: detail
            ? `暂不能休眠：${detail}`
            : '暂不能休眠：仍有任务、命令或保留的后台服务需要这个实例。',
          listener: 'active',
        };
      }
      if (instance.reasonCode === 'bridge_unreachable') {
        return {
          reasonCode: 'bridge_unreachable',
          reason:
            detail ??
            '实例进程仍存活，但 Bridge 健康检查没有响应；实例保持在线，不猜测它已经停止。',
          listener: 'unknown',
        };
      }
      const stale =
        !instance.lastHealthAt || Date.now() - new Date(instance.lastHealthAt).getTime() > 60_000;
      return {
        reasonCode: stale ? 'health_stale' : instance.reasonCode || 'listening',
        reason: stale
          ? '上次健康检查已过期，实例可能已不可用；正在等待下一次核验，不猜测完成时间。'
          : '在线：GitHub 监听中，可提交或继续任务。',
        listener: stale ? 'unknown' : 'active',
      };
    }
    case 'stopping':
      return {
        reasonCode: 'stopping',
        reason: '正在停止实例，并核验进程、端口与保留的后台服务。',
        listener: 'paused',
      };
    case 'fault':
      if (instance.reasonCode === 'retry_exhausted') {
        return {
          reasonCode: 'retry_exhausted',
          reason: detail
            ? `自动重试已用尽：${detail}`
            : '自动重试已用尽；需要你确认后手动重试启动。',
          listener: 'unknown',
        };
      }
      return {
        reasonCode: instance.reasonCode || 'fault',
        reason: detail
          ? `实例故障：${detail}。在线名额已回收，可重试启动。`
          : '实例故障；在线名额已回收，可重试启动。',
        listener: 'unknown',
      };
    default:
      return { reasonCode: 'unknown', reason: '实例状态未知。', listener: 'unknown' };
  }
}

function resourceForRow(
  row:
    | {
        resourceState: string;
        resourceDetail: string | null;
        memoryCurrentBytes: number | null;
        memoryPeakBytes: number | null;
        memoryLimitBytes: number | null;
        memoryEvents: Record<string, number>;
        resourceCheckedAt: Date | null;
      }
    | undefined,
): RuntimeResource | null {
  if (!row) return null;
  if (!row.resourceCheckedAt && row.memoryCurrentBytes == null) return null;
  const allowed = ['ok', 'resource_wait', 'over_budget', 'oom', 'unknown'] as const;
  const state = allowed.includes(row.resourceState as (typeof allowed)[number])
    ? (row.resourceState as (typeof allowed)[number])
    : 'unknown';
  return {
    state,
    detail: safeDetail(row.resourceDetail),
    memoryCurrentBytes: row.memoryCurrentBytes,
    memoryPeakBytes: row.memoryPeakBytes,
    memoryLimitBytes: row.memoryLimitBytes,
    oomKillCount: row.memoryEvents?.oom_kill ?? 0,
    checkedAt: iso(row.resourceCheckedAt),
  };
}

async function leaseFor(
  database: Database,
  repositoryId: string,
): Promise<RuntimeLeaseProjection | null> {
  const [row] = await database
    .select()
    .from(runtimeLeases)
    .where(and(eq(runtimeLeases.repositoryId, repositoryId), eq(runtimeLeases.state, 'active')))
    .orderBy(desc(runtimeLeases.acquiredAt))
    .limit(1);
  if (!row) return null;
  return {
    fencingToken: String(row.fencingToken),
    recoveryState: row.recoveryState,
    waitingFor: row.waitingFor,
    detail: safeDetail(row.lastError ?? row.recoveryReason),
    stopProvenAt: iso(row.stopProvenAt),
  };
}

async function loadInstance(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<SupervisorInstance> {
  const [row] = await database
    .select()
    .from(repositoryInstances)
    .where(eq(repositoryInstances.repositoryId, repository.id))
    .limit(1);
  if (row) {
    return {
      repositoryId: row.repositoryId,
      state: row.state,
      desiredState: row.desiredState,
      reasonCode: row.reasonCode,
      reasonDetail: row.reasonDetail,
      waitingFor: row.waitingFor,
      queuePriority: row.queuePriority,
      wakeRequestedAt: iso(row.wakeRequestedAt),
      activationRequestedAt: iso(row.activationRequestedAt),
      lastActivityAt: iso(row.lastActivityAt),
      lastProgressAt: iso(row.lastProgressAt),
      lastStartedAt: iso(row.lastStartedAt),
      lastOnlineAt: iso(row.lastOnlineAt),
      lastStoppedAt: iso(row.lastStoppedAt),
      lastHealthAt: iso(row.lastHealthAt),
      pid: row.pid,
      port: row.port,
      profile: row.profile,
      attemptCount: row.attemptCount,
      errorCode: row.errorCode,
      errorDetail: row.errorDetail,
      gitState:
        row.gitState === 'preparing' || row.gitState === 'ready' || row.gitState === 'failed'
          ? row.gitState
          : 'none',
      gitPhase: row.gitPhase,
      gitProgress: row.gitProgress,
      gitDetail: row.gitDetail,
      gitStartedAt: iso(row.gitStartedAt),
      gitFinishedAt: iso(row.gitFinishedAt),
      gitAttempts: row.gitAttempts,
      gitHead: row.gitHead,
      updatedAt: iso(row.updatedAt) ?? new Date().toISOString(),
    };
  }
  // Legacy single-repository deployments had a Bridge and no supervisor row.
  const legacyOnline =
    !config.supervisorUrl && !!config.bridgeUrl && config.bridgeRepository === repository.fullName;
  const [created] = await database
    .insert(repositoryInstances)
    .values({
      repositoryId: repository.id,
      state: legacyOnline ? 'online' : 'sleeping',
      desiredState: legacyOnline ? 'online' : 'sleeping',
      reasonCode: legacyOnline ? 'listening' : 'never_started',
      lastHealthAt: legacyOnline ? new Date() : null,
      // Legacy single-repository deployments have no supervisor Git copy; the
      // platform keeps its previous behaviour and does not gate execution.
      gitState: 'none',
    })
    .onConflictDoNothing()
    .returning();
  if (!created) return loadInstance(database, config, repository);
  return loadInstance(database, config, repository);
}

async function facts(
  database: Database,
  repositoryId: string,
): Promise<{
  executionSlot: 'free' | 'busy' | 'unknown';
  active: number;
  waitingInput: number;
  awaitingReview: number;
  lastProgressAt: Date | null;
}> {
  const [activeRow] = await database
    .select({ count: max(taskLinks.updatedAt) })
    .from(taskLinks)
    .where(eq(taskLinks.repositoryId, repositoryId));
  const rows = await database
    .select({ state: taskLinks.state, updatedAt: taskLinks.updatedAt })
    .from(taskLinks)
    .where(eq(taskLinks.repositoryId, repositoryId))
    .orderBy(desc(taskLinks.updatedAt))
    .limit(200);
  const active = rows.filter((row) => ACTIVE_STATES.includes(row.state as never)).length;
  return {
    executionSlot: active > 0 ? 'busy' : 'free',
    active,
    waitingInput: rows.filter((row) => row.state === 'waiting_input').length,
    awaitingReview: rows.filter((row) => row.state === 'awaiting_review').length,
    lastProgressAt: activeRow?.count ?? rows[0]?.updatedAt ?? null,
  };
}

/** Builds the repository runtime projection shared by list, detail and action responses. */
export async function projectRuntime(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<RepositoryRuntime> {
  if (repository.deletionState === 'removed') {
    // A removed repository has no runtime and must not be given a new dormant
    // instance row just because its removal response or an audit view asks for
    // a projection.
    return {
      state: 'sleeping',
      desiredState: 'sleeping',
      reasonCode: 'removed',
      reason: '该仓库已从 MoYu 移除；历史任务与会话在 30 天保留期内只读保存。',
      waitingFor: null,
      listener: 'paused',
      executionSlot: 'unknown',
      lastProgressAt: null,
      lastActivityAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastHealthAt: null,
      resource: null,
      lease: null,
      preparation: {
        state: 'none',
        phase: null,
        progress: null,
        detail: null,
        startedAt: null,
        finishedAt: null,
        attempts: 0,
        headCommit: null,
      },
      activation: {
        phase: 'idle',
        requestedAt: null,
        onlineAt: null,
        elapsedMs: null,
        readyMs: null,
        detail: null,
        retryAction: null,
      },
      actions: [],
    };
  }
  const instance = await loadInstance(database, config, repository);
  const [stateRow] = await database
    .select()
    .from(repositoryInstances)
    .where(eq(repositoryInstances.repositoryId, repository.id))
    .limit(1);
  const lease = await leaseFor(database, repository.id);
  const taskFacts = await facts(database, repository.id);
  const preparation = preparationFor(instance);
  const activation = activationFor(instance, preparation);
  const preparationBlock = preparationReason(preparation);
  const baseReason = reasonFor(instance);
  const reason = preparationBlock ? { ...baseReason, reason: preparationBlock } : baseReason;
  let executionSlot = taskFacts.executionSlot;
  let waitingFor = instance.waitingFor;
  if (preparation.state === 'preparing' || preparation.state === 'failed') {
    waitingFor = 'repository_copy';
  }
  if (taskFacts.waitingInput > 0) waitingFor = 'owner_input';
  else if (taskFacts.awaitingReview > 0) waitingFor = 'review';
  else if (instance.reasonCode === 'capacity_wait') waitingFor = 'capacity';
  else if (
    instance.reasonCode === 'resource_wait' ||
    instance.reasonCode === 'resource_over_budget'
  ) {
    waitingFor = 'memory';
  }
  if (lease && ['required', 'verifying', 'blocked'].includes(lease.recoveryState)) {
    executionSlot = 'unknown';
    waitingFor = lease.waitingFor ?? 'execution_stop_proof';
  }
  return {
    state: instance.state,
    desiredState: instance.desiredState,
    reasonCode: reason.reasonCode,
    reason: reason.reason,
    waitingFor,
    listener: reason.listener,
    executionSlot,
    lastProgressAt: iso(instance.lastProgressAt ?? taskFacts.lastProgressAt),
    lastActivityAt: iso(instance.lastActivityAt),
    lastStartedAt: iso(instance.lastStartedAt),
    lastStoppedAt: iso(instance.lastStoppedAt),
    lastHealthAt: iso(instance.lastHealthAt),
    actions: actionsFor(instance.state, instance.reasonCode, executionSlot, preparation),
    resource: resourceForRow(stateRow),
    lease,
    preparation,
    activation,
  };
}

/**
 * A new execution may only start when the repository's reusable Git copy is
 * ready. Discuss mode never touches the worktree, so callers skip this check
 * for it. A legacy row with no preparation starts one now and reports that
 * state instead of running a task that would fail inside the executor.
 */
export async function assertExecutionPrepared(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<void> {
  if (!config.supervisorUrl) return;
  const instance = await loadInstance(database, config, repository);
  const preparation = preparationFor(instance);
  if (preparation.state === 'ready') return;
  if (preparation.state === 'preparing') {
    throw ApiProblem.conflict(
      preparationReason(preparation) ??
        '仓库副本准备中。准备好之前不会接受新任务；无需重新添加仓库。',
    );
  }
  if (preparation.state === 'failed') {
    throw ApiProblem.conflict(
      preparationReason(preparation) ?? '仓库副本准备失败。请使用「重试准备仓库副本」后继续。',
    );
  }
  const supervisor = createSupervisorClient(config);
  if (supervisor) {
    try {
      await supervisor.prepareGit(repository.id);
    } catch {
      // The conflict below still tells the owner what to do; the repository
      // panel is the recovery entry if the supervisor refused the request.
    }
  }
  throw ApiProblem.conflict(
    '仓库副本尚未准备，已请求仓库层开始准备；准备好后可重试，无需重新添加仓库。',
  );
}

export async function requestWake(
  database: Database,
  config: ApiConfig,
  repository: Repository,
  reason: 'new_task' | 'reply' | 'manual' | 'retry',
  logger?: { warn: (fields: Record<string, unknown>, message: string) => void },
): Promise<void> {
  const supervisor = createSupervisorClient(config);
  if (!supervisor) return;
  try {
    await supervisor.wake(repository.id, reason);
    await database
      .update(repositoryInstances)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(repositoryInstances.repositoryId, repository.id));
  } catch (error) {
    logger?.warn(
      {
        event: 'runtime.wake_failed',
        repositoryId: repository.id,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      },
      'could not request a runtime wake; the task remains stored for a later attempt',
    );
  }
}

export async function wakeRepository(
  database: Database,
  config: ApiConfig,
  repository: Repository,
  reason: 'manual' | 'new_task' | 'reply' | 'retry' = 'manual',
): Promise<RepositoryRuntime> {
  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    throw ApiProblem.unavailable('The host supervisor is not configured');
  }
  try {
    await supervisor.wake(repository.id, reason);
  } catch (error) {
    throw ApiProblem.unavailable(
      `The host supervisor could not accept the wake request: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    );
  }
  return projectRuntime(database, config, repository);
}

export async function sleepRepository(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<{ runtime: RepositoryRuntime; accepted: boolean }> {
  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    throw ApiProblem.unavailable('The host supervisor is not configured');
  }
  try {
    const result = await supervisor.sleep(repository.id, true);
    return {
      runtime: await projectRuntime(database, config, repository),
      accepted: result.accepted,
    };
  } catch (error) {
    throw ApiProblem.unavailable(
      `The host supervisor could not accept the sleep request: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    );
  }
}

/**
 * Legacy single-repository startup marks its Bridge as online without a
 * supervisor. M5 repositories keep the supervisor projection untouched.
 */
export async function ensureLegacyInstance(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<void> {
  const legacyOnline =
    !config.supervisorUrl && !!config.bridgeUrl && config.bridgeRepository === repository.fullName;
  if (!legacyOnline) return;
  await database
    .insert(repositoryInstances)
    .values({
      repositoryId: repository.id,
      state: 'online',
      desiredState: 'online',
      reasonCode: 'listening',
      lastHealthAt: new Date(),
      lastStartedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: repositoryInstances.repositoryId,
      set: {
        state: 'online',
        desiredState: 'online',
        reasonCode: 'listening',
        lastHealthAt: new Date(),
        updatedAt: new Date(),
      },
      setWhere: eq(repositoryInstances.state, 'sleeping'),
    });
}

export { createSupervisorClient };
