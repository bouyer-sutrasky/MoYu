import { useState } from 'react';

import type { RepositorySummary } from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import styles from './RepositorySettingsDialog.module.css';

interface RepositoryCheckCommandsProps {
  repository: RepositorySummary;
  onSessionLost: () => void;
  onSaved: (repository: RepositorySummary) => void;
}

const MAX_COMMANDS = 8;

/**
 * Owner-only editor for the check commands executed under the supervisor's
 * check identity.
 */
export function RepositoryCheckCommands({
  repository,
  onSessionLost,
  onSaved,
}: RepositoryCheckCommandsProps) {
  const [custom, setCustom] = useState(repository.checkCommands !== null);
  const [text, setText] = useState((repository.checkCommands ?? []).join('\n'));
  const [notice, setNotice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setNotice(false);
    const commands = custom
      ? text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : null;
    if (commands) {
      if (commands.length === 0) {
        setError('至少填写一条命令，或选择继承全局默认');
        return;
      }
      if (commands.length > MAX_COMMANDS) {
        setError(`最多只能配置 ${MAX_COMMANDS} 条命令`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateRepositoryCheckCommands(repository.id, commands);
      onSaved(result.repository);
      setCustom(result.repository.checkCommands !== null);
      setText((result.repository.checkCommands ?? []).join('\n'));
      setNotice(true);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) onSessionLost();
      else setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="check-commands-heading">
      <h3 id="check-commands-heading">仓库检查命令</h3>
      <div className={styles.content}>
        <div className={styles.options}>
          <label className={styles.option}>
            <input
              type="radio"
              name="check-command-source"
              checked={!custom}
              disabled={saving}
              onChange={() => setCustom(false)}
            />
            <span>
              继承全局默认
              <small>使用宿主 supervisor 的 REVIEW_CHECK_COMMANDS。</small>
            </span>
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="check-command-source"
              checked={custom}
              disabled={saving}
              onChange={() => setCustom(true)}
            />
            <span>
              此仓库自定义
              <small>一个仓库一套命令；另一个仓库仍可继承默认。</small>
            </span>
          </label>
        </div>

        {custom ? (
          <label className={styles.field}>
            <span>命令（一行一条，最多 {MAX_COMMANDS} 条）</span>
            <textarea
              rows={7}
              disabled={saving}
              value={text}
              placeholder={'npm ci --no-audit --no-fund\nnpm run build\nnpm test'}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        ) : (
          <p className={styles.hint}>
            当前仓库没有覆盖；检查时使用 supervisor 进程的全局默认命令。
          </p>
        )}

        <p className={styles.warning}>
          检查命令会在宿主机的检查身份下通过 shell 执行，能力等价于在 worker 上执行任意命令。
          只有所有者可以修改；每次修改都会写入审计记录。
        </p>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setCustom(repository.checkCommands !== null);
              setText((repository.checkCommands ?? []).join('\n'));
              setNotice(false);
              setError(null);
            }}
            disabled={saving}
          >
            还原修改
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void save()}
            disabled={saving || repository.deletion.state === 'deleting'}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        {notice ? <p role="status">检查命令已保存。</p> : null}
      </div>
    </section>
  );
}
