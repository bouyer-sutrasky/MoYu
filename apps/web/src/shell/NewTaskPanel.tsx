import { useEffect, useRef, useState } from 'react';

import type {
  ConversationSummary,
  ModelOption,
  ModelSelection,
  RepositorySummary,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { Icon } from '../components/Icon';
import styles from './WorkspaceShell.module.css';

interface NewTaskPanelProps {
  repository: RepositorySummary;
  onCancel: () => void;
  onCreated: (conversation: ConversationSummary) => void;
  onSessionLost: () => void;
}

type ModelsStatus = 'loading' | 'ready' | 'error';

interface PendingRequest {
  fingerprint: string;
  id: string;
}

function modelKey(model: ModelOption): string {
  return JSON.stringify([model.provider, model.model]);
}

/**
 * Creates a real Work conversation. The runtime model catalog is read from the
 * repository's Bridge; when it is unreachable, creation stays disabled instead
 * of silently falling back to an unverified default.
 */
export function NewTaskPanel({
  repository,
  onCancel,
  onCreated,
  onSessionLost,
}: NewTaskPanelProps) {
  const [baseBranch, setBaseBranch] = useState(repository.defaultBranch);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('loading');
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [modelKeyValue, setModelKeyValue] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<PendingRequest | null>(null);

  useEffect(() => {
    setBaseBranch(repository.defaultBranch);
    setModelKeyValue('');
    setReasoningEffort('');
    setError(null);
    requestRef.current = null;
  }, [repository.id, repository.defaultBranch]);

  useEffect(() => {
    let cancelled = false;
    setModelsStatus('loading');
    setModelsError(null);
    api
      .models(repository.id)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setModels(data.models);
        setModelsStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setModels([]);
        setModelsStatus('error');
        setModelsError(describeApiError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [repository.id, modelsAttempt, onSessionLost]);

  const selectedModel = models.find((model) => modelKey(model) === modelKeyValue) ?? null;
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const branchValue = baseBranch.trim();

  const blockedReason =
    modelsStatus === 'loading'
      ? '正在读取运行时模型目录…'
      : modelsStatus === 'error'
        ? '运行时不可达，无法确认可用模型；创建已禁用。'
        : branchValue.length === 0
          ? '请填写起点分支。'
          : creating
            ? '正在创建任务…'
            : null;
  const canCreate = blockedReason === null;

  async function submit() {
    if (!canCreate) {
      return;
    }
    const model: ModelSelection | null = selectedModel
      ? {
          provider: selectedModel.provider,
          model: selectedModel.model,
          reasoningEffort: reasoningEffort || null,
        }
      : null;
    const payload = {
      repositoryId: repository.id,
      mode: 'work' as const,
      executionMode: 'execute' as const,
      baseBranch: branchValue,
      model,
    };
    const fingerprint = JSON.stringify(payload);
    let pending = requestRef.current;
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, id: crypto.randomUUID() };
      requestRef.current = pending;
    }

    setCreating(true);
    setError(null);
    try {
      const result = await api.createConversation({ ...payload, clientRequestId: pending.id });
      requestRef.current = null;
      onCreated(result.conversation);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setError(describeApiError(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className={styles.newTaskPanel} aria-labelledby="new-task-heading">
      <header className={styles.newTaskHeader}>
        <div>
          <p className={styles.heroEyebrow}>Work · 新建任务</p>
          <h1 id="new-task-heading" className={styles.newTaskTitle}>
            在 {repository.fullName} 开始任务
          </h1>
          <p className={styles.newTaskLead}>
            会话创建后会先进入待接单；发送第一条消息后才会投递给执行器。仓库、起点分支与执行方式会随会话冻结。
          </p>
        </div>
        <button type="button" className={styles.ghostButton} onClick={onCancel}>
          取消
        </button>
      </header>

      <form
        className={styles.newTaskForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>仓库</span>
            <input className={styles.textInput} value={repository.fullName} readOnly />
            <span className={styles.fieldHint}>新建任务固定使用当前选择的仓库。</span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>起点分支</span>
            <input
              className={styles.textInput}
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              placeholder={repository.defaultBranch}
              autoComplete="off"
              spellCheck={false}
            />
            <span className={styles.fieldHint}>
              默认 {repository.defaultBranch}；起点 commit 在首次投递时记录。
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>模型</span>
            <select
              className={styles.selectInput}
              value={modelKeyValue}
              onChange={(event) => {
                setModelKeyValue(event.target.value);
                setReasoningEffort('');
              }}
              disabled={modelsStatus !== 'ready'}
            >
              {modelsStatus === 'loading' ? <option value="">正在读取模型目录…</option> : null}
              {modelsStatus === 'error' ? <option value="">模型目录不可用</option> : null}
              {modelsStatus === 'ready' ? (
                <>
                  <option value="">实例默认模型</option>
                  {models.map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {model.displayName
                        ? `${model.displayName} · ${model.provider}/${model.model}`
                        : `${model.provider}/${model.model}`}
                    </option>
                  ))}
                </>
              ) : null}
            </select>
            <span className={styles.fieldHint}>
              {modelsStatus === 'ready' && models.length === 0
                ? '运行时没有返回可用模型；创建后将依赖实例默认配置。'
                : '模型来自仓库运行时的已配置目录，不会回退到未知模型。'}
            </span>
          </label>

          {reasoningEfforts.length > 0 ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>推理强度</span>
              <select
                className={styles.selectInput}
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
              >
                <option value="">实例默认</option>
                {reasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className={styles.fieldHint}>只列出该模型支持的推理强度。</span>
            </label>
          ) : null}

          <fieldset className={styles.modeGroup}>
            <legend className={styles.fieldLabel}>执行方式</legend>
            <div className={styles.modeOptions}>
              <label className={styles.modeOptionActive}>
                <input type="radio" name="execution-mode" checked readOnly />
                <span>
                  <strong>直接执行</strong>
                  <em>创建后可直接发送任务并投递。</em>
                </span>
              </label>
              <label
                className={styles.modeOptionDisabled}
                title="先讨论属于 M4：只读讨论与按方案开始执行尚未接入"
              >
                <input type="radio" name="execution-mode" disabled />
                <span>
                  <strong>
                    先讨论 <span className={styles.phaseTag}>M4</span>
                  </strong>
                  <em>只读讨论与“按此方案开始执行”在 M4 接入，当前不可选。</em>
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        {modelsStatus === 'error' ? (
          <div className={styles.formError} role="alert">
            <p>模型目录读取失败：{modelsError}</p>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setModelsAttempt((current) => current + 1)}
            >
              重新读取
            </button>
          </div>
        ) : null}

        {error ? (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.formActions}>
          <div className={styles.formActionsText}>
            <Icon name="work" size={14} />
            <span>
              {blockedReason ??
                '创建后进入待接单，发送第一条消息后由执行器接收。创建请求使用稳定幂等键重试。'}
            </span>
          </div>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={!canCreate}
            title={blockedReason ?? undefined}
          >
            {creating ? '正在创建…' : '创建任务'}
          </button>
        </div>
      </form>
    </section>
  );
}
