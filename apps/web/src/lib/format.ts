import type {
  DeliveryState,
  MessageKind,
  ModelSelection,
  RepositoryRuntime,
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
  delivered: '执行器已接收',
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

export function taskStateLabel(state: TaskState | null | undefined): string {
  return state ? TASK_STATE_LABELS[state] : '状态未知';
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
    default:
      return null;
  }
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
