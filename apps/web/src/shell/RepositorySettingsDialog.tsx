import { useState } from 'react';

import type { RepositorySummary } from '@moyu/contracts';

import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import styles from './RepositorySettingsDialog.module.css';

interface RepositorySettingsDialogProps {
  repository: RepositorySummary;
  onClose: () => void;
  onSaved: (repository: RepositorySummary) => void;
}

const MAX_COMMANDS = 8;

/**
 * Owner-only editor for the repository's check-command override. The field is a
 * shell that the host supervisor runs as its check identity, so the dialog says
 * that plainly and does not offer it anywhere a non-owner can reach.
 */
export function RepositorySettingsDialog({
  repository,
  onClose,
  onSaved,
}: RepositorySettingsDialogProps) {
  const [custom, setCustom] = useState(repository.checkCommands !== null);
  const [text, setText] = useState((repository.checkCommands ?? []).join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
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
      onClose();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="仓库检查命令"
      description={`${repository.fullName} · 仅所有者可见`}
      onClose={onClose}
      wide
    >
      <div className={styles.content}>
        <div className={styles.options}>
          <label className={styles.option}>
            <input
              type="radio"
              name="check-command-source"
              checked={!custom}
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
          <button type="button" className={styles.secondary} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
