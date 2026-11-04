import { useEffect, useRef, useState } from 'react';

import type {
  ConversationSummary,
  ModelOption,
  ModelSelection,
  RepositoryPreferencesData,
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
type BranchesStatus = 'loading' | 'ready' | 'unsupported' | 'error';
type PreferencesStatus = 'loading' | 'ready' | 'error';

interface PendingRequest {
  fingerprint: string;
  id: string;
}

function modelKey(model: ModelOption): string {
  return JSON.stringify([model.provider, model.model]);
}

function keyOfSelection(model: ModelSelection | null): string {
  return model ? JSON.stringify([model.provider, model.model]) : '';
}

/**
 * Creates a real Work conversation. The effective configuration is shown
 * before creation; a saved repository preference supplies the defaults, a
 * deleted branch or unavailable model is reported instead of silently
 * substituted, and the runtime catalog remains the authority.
 */
export function NewTaskPanel({
  repository,
  onCancel,
  onCreated,
  onSessionLost,
}: NewTaskPanelProps) {
  const [baseBranch, setBaseBranch] = useState(repository.defaultBranch);
  const [missingSavedBranch, setMissingSavedBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesStatus, setBranchesStatus] = useState<BranchesStatus>('loading');
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesAttempt, setBranchesAttempt] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('loading');
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [modelKeyValue, setModelKeyValue] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [executionMode, setExecutionMode] = useState<'execute' | 'discuss'>('execute');
  const [preferences, setPreferences] = useState<RepositoryPreferencesData | null>(null);
  const [preferencesStatus, setPreferencesStatus] = useState<PreferencesStatus>('loading');
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [rememberDefaults, setRememberDefaults] = useState(true);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsNotice, setDefaultsNotice] = useState<string | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<PendingRequest | null>(null);
  const initialisedRef = useRef(false);
  const touchedRef = useRef(false);

  useEffect(() => {
    setBaseBranch(repository.defaultBranch);
    setMissingSavedBranch(null);
    setModelKeyValue('');
    setReasoningEffort('');
    setExecutionMode('execute');
    setBranches([]);
    setBranchesStatus('loading');
    setBranchesError(null);
    setModels([]);
    setModelsStatus('loading');
    setModelsError(null);
    setPreferences(null);
    setPreferencesStatus('loading');
    setPreferencesError(null);
    setError(null);
    setDefaultsNotice(null);
    setDefaultsError(null);
    setRememberDefaults(true);
    requestRef.current = null;
    initialisedRef.current = false;
    touchedRef.current = false;
  }, [repository.id, repository.defaultBranch]);

  useEffect(() => {
    let cancelled = false;
    setPreferencesStatus('loading');
    setPreferencesError(null);
    api
      .preferences(repository.id)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setPreferences(data);
        setPreferencesStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        // The repository defaults remain usable when the preference read fails.
        setPreferences(null);
        setPreferencesStatus('error');
        setPreferencesError(describeApiError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [repository.id, onSessionLost]);

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

  useEffect(() => {
    let cancelled = false;
    setBranchesStatus('loading');
    setBranchesError(null);
    api
      .branches(repository.id)
      .then((data) => {
        if (cancelled) {
          return;
        }
        if (data.status === 'unsupported') {
          setBranches([]);
          setBranchesStatus('unsupported');
          return;
        }
        setBranches(data.branches.map((branch) => branch.name));
        setBranchesStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setBranches([]);
        setBranchesStatus('error');
        setBranchesError(describeApiError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [repository.id, branchesAttempt, onSessionLost]);

  const selectedModel = models.find((model) => modelKey(model) === modelKeyValue) ?? null;
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const branchValue = baseBranch.trim();
  const branchVerified = branchesStatus === 'ready';
  const branchMissing = branchVerified && branchValue.length > 0 && !branches.includes(branchValue);
  const modelMissing = modelsStatus === 'ready' && modelKeyValue.length > 0 && !selectedModel;
  const preferredModel = preferences?.effective.model ?? null;

  // Apply the saved preference once the catalogs needed to validate it are
  // available. A deleted branch or unavailable model is surfaced and forces a
  // fresh choice instead of silently becoming the new default.
  useEffect(() => {
    if (initialisedRef.current || preferencesStatus !== 'ready' || !preferences) {
      return;
    }
    if (modelsStatus === 'loading' || branchesStatus === 'loading') {
      return;
    }
    initialisedRef.current = true;
    if (touchedRef.current) {
      return;
    }
    setExecutionMode(preferences.effective.executionMode);
    const preferredBranch = preferences.effective.baseBranch;
    if (branchesStatus === 'ready' && !branches.includes(preferredBranch)) {
      setBaseBranch('');
      setMissingSavedBranch(preferredBranch);
    } else {
      setBaseBranch(preferredBranch);
      setMissingSavedBranch(null);
    }
    if (preferredModel) {
      const key = keyOfSelection(preferredModel);
      const available = models.some((model) => modelKey(model) === key);
      // Keep the saved identity even when the catalog is unavailable, so a
      // failed catalog read does not silently replace the preference.
      setModelKeyValue(key);
      if (available) {
        const model = models.find((candidate) => modelKey(candidate) === key) ?? null;
        const effort = preferredModel.reasoningEffort ?? '';
        setReasoningEffort(
          model && effort && (model.reasoningEfforts ?? []).includes(effort) ? effort : '',
        );
      } else {
        setReasoningEffort('');
      }
    }
  }, [branches, branchesStatus, models, modelsStatus, preferences, preferencesStatus]);

  const blockedReason =
    modelsStatus === 'loading'
      ? '正在读取运行时模型目录…'
      : modelsStatus === 'error'
        ? '运行时不可达，无法确认可用模型；创建已禁用。'
        : modelMissing
          ? `已保存的模型 ${modelKeyValue ? JSON.parse(modelKeyValue).join('/') : ''} 当前不可用，请重新选择有效模型。`
          : branchesStatus === 'ready' && branchValue.length === 0
            ? '请选择起点分支。'
            : branchMissing
              ? `起点分支 ${branchValue} 已不在当前仓库，请选择有效分支。`
              : missingSavedBranch && branchValue.length === 0
                ? `已保存的分支 ${missingSavedBranch} 已不存在，请选择有效分支。`
                : branchValue.length === 0
                  ? '请填写起点分支。'
                  : creating
                    ? '正在创建任务…'
                    : null;
  const canCreate = blockedReason === null;

  const preferenceSource = preferences?.preferences ? '已保存偏好' : '仓库默认';
  const selectedKeyParts = modelKeyValue
    ? (() => {
        try {
          return JSON.parse(modelKeyValue) as [string, string];
        } catch {
          return null;
        }
      })()
    : null;
  const actualModelLabel = selectedModel
    ? selectedModel.displayName
      ? `${selectedModel.displayName} · ${selectedModel.provider}/${selectedModel.model}`
      : `${selectedModel.provider}/${selectedModel.model}`
    : selectedKeyParts
      ? `已保存：${selectedKeyParts.join('/')}（${modelsStatus === 'ready' ? '当前不可用' : '当前目录未确认'}）`
      : '实例默认模型';
  const actualReasoning = reasoningEffort || (selectedModel ? '模型默认' : '实例默认');
  const actualMode = executionMode === 'discuss' ? '先讨论' : '直接执行';

  function buildModelSelection(): ModelSelection | null {
    if (!selectedModel) {
      return null;
    }
    return {
      provider: selectedModel.provider,
      model: selectedModel.model,
      reasoningEffort: reasoningEffort || null,
    };
  }

  function branchNotice(): string {
    if (branchesStatus === 'loading') {
      return '正在读取分支列表…';
    }
    if (branchesStatus === 'unsupported') {
      return '该运行时未提供分支列表，无法确认分支是否仍在；创建后由运行时解析，失败会显示原因。';
    }
    if (branchesStatus === 'error') {
      return `分支列表读取失败：${branchesError ?? '未知错误'}。可重试；当前按输入的起点分支创建。`;
    }
    if (
      preferences?.preferences &&
      baseBranch === preferences.effective.baseBranch &&
      !touchedRef.current
    ) {
      return `已保存偏好中的分支为 ${preferences.effective.baseBranch}；分支列表由运行时提供。`;
    }
    return `默认 ${repository.defaultBranch}；起点 commit 在首次投递时记录。`;
  }

  async function saveDefaults(silent = false): Promise<boolean> {
    if (!canCreate && !silent) {
      return false;
    }
    const model = buildModelSelection();
    if (modelsStatus !== 'ready' || modelMissing) {
      if (!silent) {
        setDefaultsError('运行时模型目录不可用或所选模型无效，无法保存偏好。');
      }
      return false;
    }
    setSavingDefaults(true);
    if (!silent) {
      setDefaultsError(null);
      setDefaultsNotice(null);
    }
    try {
      const saved = await api.savePreferences(repository.id, {
        executionMode,
        baseBranch: branchValue,
        model,
      });
      setPreferences(saved);
      setPreferencesStatus('ready');
      if (!silent) {
        setDefaultsNotice('已保存为该仓库的新任务默认配置。');
      }
      return true;
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return false;
      }
      if (!silent) {
        setDefaultsError(
          caught instanceof ApiClientError && caught.status === 422
            ? `无法保存偏好：${caught.message}`
            : describeApiError(caught),
        );
      }
      return false;
    } finally {
      setSavingDefaults(false);
    }
  }

  async function submit() {
    if (!canCreate) {
      return;
    }
    const model = buildModelSelection();
    const payload = {
      repositoryId: repository.id,
      mode: 'work' as const,
      executionMode,
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
      if (rememberDefaults) {
        void saveDefaults(true);
      }
      onCreated(result.conversation);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setError(
        caught instanceof ApiClientError && caught.status === 422
          ? `无法创建任务：${caught.message}`
          : describeApiError(caught),
      );
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
            会话创建后会先进入待接单；发送第一条消息后才会投递给执行器。仓库、起点分支、模型与执行方式会随会话冻结。
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
            {branchesStatus === 'ready' ? (
              <select
                className={styles.selectInput}
                value={branchValue}
                data-field="base-branch"
                onChange={(event) => {
                  touchedRef.current = true;
                  setMissingSavedBranch(null);
                  setBaseBranch(event.target.value);
                }}
                aria-invalid={
                  branchMissing || missingSavedBranch !== null || branchValue.length === 0
                }
              >
                <option value="">请选择分支</option>
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                    {branch === repository.defaultBranch ? '（默认分支）' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={styles.textInput}
                value={baseBranch}
                data-field="base-branch"
                onChange={(event) => {
                  touchedRef.current = true;
                  setMissingSavedBranch(null);
                  setBaseBranch(event.target.value);
                }}
                placeholder={repository.defaultBranch}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={branchValue.length === 0}
              />
            )}
            <span
              className={styles.fieldHint}
              data-kind={
                branchMissing || missingSavedBranch
                  ? 'error'
                  : branchesStatus === 'error'
                    ? 'warning'
                    : undefined
              }
            >
              {missingSavedBranch
                ? `已保存的分支 ${missingSavedBranch} 已不存在，请选择有效分支。`
                : branchMissing
                  ? `起点分支 ${branchValue} 已不存在，请选择有效分支。`
                  : branchNotice()}
            </span>
            {branchesStatus === 'error' ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={() => setBranchesAttempt((current) => current + 1)}
              >
                重新读取分支
              </button>
            ) : null}
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>模型</span>
            <select
              className={styles.selectInput}
              value={modelKeyValue}
              data-field="model"
              onChange={(event) => {
                touchedRef.current = true;
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
            <span className={styles.fieldHint} data-kind={modelMissing ? 'error' : undefined}>
              {modelMissing
                ? '已保存的模型当前不可用，请重新选择有效模型。'
                : preferredModel
                  ? '已从仓库偏好载入；只列出运行时当前可用的模型。'
                  : '模型来自仓库运行时的已配置目录，不会回退到未知模型。'}
            </span>
          </label>

          {reasoningEfforts.length > 0 ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>推理强度</span>
              <select
                className={styles.selectInput}
                value={reasoningEffort}
                data-field="reasoning"
                onChange={(event) => {
                  touchedRef.current = true;
                  setReasoningEffort(event.target.value);
                }}
              >
                <option value="">模型默认</option>
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
              <label
                className={
                  executionMode === 'execute' ? styles.modeOptionActive : styles.modeOptionDisabled
                }
              >
                <input
                  type="radio"
                  name="execution-mode"
                  checked={executionMode === 'execute'}
                  onChange={() => {
                    touchedRef.current = true;
                    setExecutionMode('execute');
                  }}
                />
                <span>
                  <strong>直接执行</strong>
                  <em>创建后可发送任务并投递，执行器可修改工作目录并创建 PR。</em>
                </span>
              </label>
              <label
                className={
                  executionMode === 'discuss' ? styles.modeOptionActive : styles.modeOptionDisabled
                }
              >
                <input
                  type="radio"
                  name="execution-mode"
                  checked={executionMode === 'discuss'}
                  onChange={() => {
                    touchedRef.current = true;
                    setExecutionMode('discuss');
                  }}
                />
                <span>
                  <strong>先讨论</strong>
                  <em>只读讨论：没有写工具、shell 或写凭据；确认方案后才转执行。</em>
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        <div className={styles.configSummary} aria-live="polite" data-field="config-summary">
          <div className={styles.configSummaryHead}>
            <strong>本次创建实际配置</strong>
            <span className={styles.configSource}>
              来源：{preferenceSource}
              {preferencesStatus === 'error' ? '（偏好读取失败，使用仓库默认）' : ''}
            </span>
          </div>
          <ul className={styles.configList}>
            <li>
              <span>仓库</span>
              <strong>{repository.fullName}</strong>
            </li>
            <li>
              <span>分支</span>
              <strong>{branchValue || '未选择'}</strong>
            </li>
            <li>
              <span>模型</span>
              <strong>{actualModelLabel}</strong>
            </li>
            <li>
              <span>推理</span>
              <strong>{actualReasoning}</strong>
            </li>
            <li>
              <span>执行方式</span>
              <strong>{actualMode}</strong>
            </li>
          </ul>
          {preferencesError ? <p className={styles.configWarning}>{preferencesError}</p> : null}
        </div>

        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={rememberDefaults}
            onChange={(event) => setRememberDefaults(event.target.checked)}
          />
          <span>创建成功后把以上分支、模型与执行方式保存为 {repository.fullName} 的默认配置</span>
        </label>

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

        {defaultsNotice ? (
          <p className={styles.formNotice} role="status">
            {defaultsNotice}
          </p>
        ) : null}
        {defaultsError ? (
          <p className={styles.formError} role="alert">
            {defaultsError}
          </p>
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
                (executionMode === 'discuss'
                  ? '讨论态由运行时权限约束为只读；发送方案后点“按此方案开始执行”才转执行态。'
                  : '创建后进入待接单，发送第一条消息后由执行器接收。创建请求使用稳定幂等键重试。')}
            </span>
          </div>
          <div className={styles.formActionsButtons}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void saveDefaults()}
              disabled={!canCreate || savingDefaults || modelsStatus !== 'ready' || modelMissing}
              title="保存为当前仓库的新任务默认配置"
            >
              {savingDefaults ? '正在保存…' : '保存为默认'}
            </button>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={!canCreate}
              title={blockedReason ?? undefined}
            >
              {creating ? '正在创建…' : '创建任务'}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
