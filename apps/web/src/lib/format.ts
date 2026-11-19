import type {
  DeliveryState,
  MessageKind,
  ModelSelection,
  RepositoryRuntime,
  RuntimeResource,
  TaskDecision,
  TaskState,
} from '@moyu/contracts';

/** Task states are rendered with the exact Chinese labels agreed in the design. */
export const TASK_STATE_LABELS: Record<TaskState, string> = {
  pending_admission: '待接单',
  discussing: '讨论中',
  queued: '已入队',
  running: '执行中',
  waiting_input: '等待回复',
  awaiting_review: '待审阅',
  stopping: '停止中',
  stopped: '已停止',
  blocked: '受阻',
  failed: '失败',
  completed: '已完成',
  closed_unmerged: '已关闭未合并',
  not_accepted: '未接单',
};

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  stored: '平台收件',
  delivering: '投递中',
  delivered: '运行时已接收',
  read: '已读取',
  failed: '投递失败',
};

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  user: '你',
  acknowledgement: '执行器确认',
  question: '执行器提问',
  reply: '执行器回复',
  result: '执行结果',
  notice: '执行器通知',
  progress: '执行进度',
};

/** Owner-facing state label; a routed admission says "已转交" instead of "未接单". */
export function taskStateLabel(
  state: TaskState | null | undefined,
  decision?: TaskDecision | null,
): string {
  if (state === 'not_accepted' && decision?.outcome === 'routed') {
    switch (decision.routingState) {
      case 'pending':
        return '转交中';
      case 'failed':
        return '转交失败';
      case 'deferred':
        return '已转交（目标已暂停）';
      default:
        return '已转交';
    }
  }
  return state ? TASK_STATE_LABELS[state] : '状态未知';
}

const DECISION_REASON_LABELS: Record<string, string> = {
  routed: '已交给同一仓库里的目标工单',
  said: '执行器判断这条消息不构成任务',
  not_human: '消息不是人工发出的',
  not_a_member: '发送者不在这个来源的允许名单里',
  no_mention: '没有明确点名执行器',
  admission_ignored: '这个来源的准入设为忽略',
  chat_not_allowed: '这个群不在监听范围',
  direct_messages_not_allowed: '私聊未开放',
  observation_only: '仅观察的群',
  untracked_source: '线程未被订阅',
  issue_assigned: 'Issue 已有负责人',
  issue_closed: 'Issue 已关闭',
  issue_has_pull_request: 'Issue 已有关联 PR',
  issue_unclaimed_less_than_day: 'Issue 认领不足一天',
  task_ended: '工单已结束',
  task_paused: '工单已暂停',
  subscription_inactive: '订阅未生效',
  subscription_removed: '订阅已移除',
  issue_awaiting_eligibility: '等待 Issue 满足资格',
  timeout: '评估超时未决定',
  policyChanged: '评估期间策略已变更',
  noAdmissible: '没有可准入的触发',
  startedTicket: '这条消息已经开过工单',
  acceptedBefore: '这条消息之前已接单',
  stopUnknown: '要停止的工单不存在或已结束',
  stopNotExplicit: '停止指令不够明确',
  directionUnsettled: '要实现的方向还没确定',
  noRuleMatched: '没有启用的准入规则匹配',
  ignoredFromCard: '在评估卡上被忽略',
  observed: '仅观察模式，没有接单',
  legacyImport: '从旧版工单记录导入',
  channelGone: '原对话已无法接收消息',
  channelIgnored: '对话不在接收范围',
  hostRestarted: 'dsh-superagent 重启',
  retried: '人工重试',
  merged: 'PR 已合并',
  closed: 'PR 已关闭',
};

/** Why the runtime's admission was ignored, without leaking internal ids. */
export function decisionReasonText(decision: TaskDecision | null | undefined): string {
  if (!decision) return '未接单';
  const primary =
    decision.reason.find((reason) => reason.code === decision.code) ?? decision.reason[0];
  if (primary?.code === 'said') {
    const text = primary.values?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return DECISION_REASON_LABELS[decision.code] ?? `未接单（${decision.code}）`;
}

/** What the owner can do next after an admission did not become a task. */
export function decisionNextStep(decision: TaskDecision | null | undefined): string {
  switch (decision?.code) {
    case 'no_mention':
    case 'not_a_member':
    case 'not_human':
    case 'chat_not_allowed':
    case 'direct_messages_not_allowed':
      return '请在允许的会话里明确 @ 执行器，或直接新建一个任务。';
    case 'issue_assigned':
    case 'issue_closed':
    case 'issue_has_pull_request':
    case 'issue_unclaimed_less_than_day':
    case 'issue_awaiting_eligibility':
      return '请先确认这个 Issue 的负责人、状态和关联 PR，再在网页新建任务。';
    case 'task_ended':
    case 'task_paused':
    case 'stopUnknown':
      return '目标工单当前不接收输入；请先让目标工单继续，或新建一个任务。';
    case 'directionUnsettled':
      return '请先明确要修改的文件或行为，再新建任务。';
    default:
      return '可以新建一个更具体的任务，或到目标工单继续。';
  }
}

/** The one-line outcome and detail shown under a not-accepted or routed task. */
export function taskDecisionSummary(decision: TaskDecision | null | undefined): {
  headline: string;
  detail: string;
  targetConversationId: string | null;
} {
  if (!decision) {
    return { headline: '未接单', detail: '', targetConversationId: null };
  }
  if (decision.outcome !== 'routed') {
    return {
      headline: '未接单',
      detail: `${decisionReasonText(decision).replace(/[。.!！]+$/, '')}。下一步：${decisionNextStep(decision)}`,
      targetConversationId: null,
    };
  }
  const target = decision.targetTitle ? `「${decision.targetTitle}」` : '同仓库目标工单';
  const delivery =
    decision.deliveryState === 'read'
      ? '目标执行器已读取这条输入。'
      : decision.deliveryState === 'delivered'
        ? '目标执行器已接收这条输入。'
        : decision.deliveryState === 'failed'
          ? '这条输入投递失败，请在目标工单里补充说明。'
          : '输入已随目标工单排队。';
  switch (decision.routingState) {
    case 'pending':
      return {
        headline: '转交中',
        detail: `正在唤醒${target}并交接输入；完成后会显示为「已转交」。`,
        targetConversationId: decision.targetConversationId ?? null,
      };
    case 'deferred':
      return {
        headline: '已转交（目标已暂停）',
        detail: `输入已挂在${target}上；目标工单手动继续后会自动交接。${delivery}`,
        targetConversationId: decision.targetConversationId ?? null,
      };
    case 'failed':
      return {
        headline: '转交失败',
        detail: decision.routingError ?? decision.routingDetail ?? '目标工单没有接收这条输入。',
        targetConversationId: decision.targetConversationId ?? null,
      };
    default:
      return {
        headline: '已转交',
        detail: `这条返修已交给${target}。${delivery}`,
        targetConversationId: decision.targetConversationId ?? null,
      };
  }
}

/** Short lifecycle label for the repository navigation and status panel. */
export function repositoryRuntimeLabel(runtime: RepositoryRuntime | null | undefined): string {
  if (!runtime) return '状态未知';
  if (runtime.state === 'sleeping' && runtime.reasonCode === 'capacity_wait') return '排队中';
  switch (runtime.state) {
    case 'sleeping':
      return '休眠';
    case 'starting':
      return '启动中';
    case 'online':
      return '在线';
    case 'stopping':
      return '停止中';
    case 'fault':
      return '故障';
    default:
      return '状态未知';
  }
}

/** A compact, real duration. Never used with an estimated or invented time. */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return '不到 1 秒';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours} 小时` : `${hours} 小时 ${remaining} 分`;
}

/**
 * The real phase of the current/last switch, as distinct from the process
 * lifecycle label. "切换中" covers waiting for a slot, preparing the repository
 * copy and starting the process; each has its own reason so the UI cannot sit
 * on one indefinite "启动中".
 */
export function repositoryActivationLabel(
  activation: RepositoryRuntime['activation'] | null | undefined,
): string | null {
  if (!activation) return null;
  switch (activation.phase) {
    case 'queued':
      return '切换中 · 等待在线名额';
    case 'preparing':
      return '切换中 · 仓库准备中';
    case 'starting':
      return '切换中 · 启动中';
    case 'failed':
      return '切换失败';
    default:
      return null;
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

/** One line for the repository's reusable Git copy, from real phase/progress. */
export function repositoryPreparationLabel(
  preparation: RepositoryRuntime['preparation'],
): string | null {
  if (preparation.state === 'none') return null;
  if (preparation.state === 'ready') {
    return preparation.headCommit
      ? `仓库副本已就绪 · ${shortCommit(preparation.headCommit)}`
      : '仓库副本已就绪';
  }
  if (preparation.state === 'failed') return '仓库副本准备失败';
  const phase = preparation.phase
    ? (GIT_PHASE_LABELS[preparation.phase] ?? preparation.phase)
    : '准备中';
  return preparation.progress === null
    ? `仓库副本准备中 · ${phase}`
    : `仓库副本准备中 · ${phase} ${preparation.progress}%`;
}

export function waitingForLabel(waitingFor: string | null | undefined): string | null {
  switch (waitingFor) {
    case 'capacity':
      return '等待在线名额';
    case 'execution':
      return '等待执行结束';
    case 'background_service':
      return '等待后台服务结束';
    case 'owner_input':
      return '等待你的回复';
    case 'review':
      return '等待你审阅';
    case 'supervisor':
      return '等待 supervisor';
    case 'memory':
      return '等待内存余量';
    case 'execution_stop_proof':
      return '等待旧执行停止证明';
    case 'runtime_ticket':
      return '等待运行时票据';
    case 'runtime':
      return '等待运行时';
    case 'repository_copy':
      return '等待仓库副本';
    default:
      return null;
  }
}

/** A measured cgroup size for the repository panel; zero is a real value, not unknown. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export function runtimeResourceLabel(resource: RuntimeResource | null | undefined): string | null {
  if (!resource) return null;
  if (resource.state === 'oom') return '已发生 OOM，等待人工处理';
  if (resource.state === 'resource_wait' || resource.state === 'over_budget') {
    return '内存不足，等待实测余量';
  }
  const size = formatBytes(resource.memoryCurrentBytes);
  if (resource.state === 'unknown') return size ? `内存 ${size}（限额未知）` : '内存占用未知';
  return size ? `内存 ${size}` : null;
}

export function formatModel(model: ModelSelection | null | undefined): string {
  if (!model) {
    return '实例默认模型';
  }
  const identity = `${model.provider}/${model.model}`;
  return model.reasoningEffort ? `${identity} · ${model.reasoningEffort}` : identity;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function formatPrLabel(prNumber: number | null): string {
  return prNumber ? `查看 PR #${prNumber}` : '查看 PR';
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** Compact "updated at" copy for the conversation list. */
export function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (isSameDay(date, now)) {
    return `今天 ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Time shown next to one message. */
export function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (isSameDay(date, now)) {
    return time;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
