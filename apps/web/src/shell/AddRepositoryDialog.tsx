import { useCallback, useEffect, useRef, useState } from 'react';

import type { GithubRepositorySummary } from '@moyu/contracts';

import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import styles from './AddRepositoryDialog.module.css';

interface AddRepositoryDialogProps {
  onClose: () => void;
  onAdded: (repositoryId: string) => Promise<void> | void;
}

export function AddRepositoryDialog({ onClose, onAdded }: AddRepositoryDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GithubRepositorySummary[]>([]);
  const [manual, setManual] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (search: string) => {
    const token = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.githubRepositories(search || undefined);
      if (requestRef.current !== token) return;
      setResults(result.repositories);
    } catch (caught) {
      if (requestRef.current !== token) return;
      setError(describeApiError(caught));
    } finally {
      if (requestRef.current === token) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        void load(query.trim());
      },
      query.trim() ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const add = async (fullName: string) => {
    const name = fullName.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
      setError('请输入 owner/repo 格式的完整仓库名');
      return;
    }
    setAdding(name);
    setError(null);
    try {
      const result = await api.addRepository(name);
      await onAdded(result.repositoryId);
      onClose();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setAdding(null);
    }
  };

  return (
    <Modal
      title="添加仓库"
      description="使用专用 GitHub 账号查询并校验写权限；添加后由主机 supervisor 准备独立实例。"
      onClose={onClose}
      wide
    >
      <div className={styles.content}>
        <label className={styles.field}>
          <span>搜索专用账号可见的仓库</span>
          <input
            type="search"
            value={query}
            placeholder="owner/repo 或关键字"
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </label>

        <div className={styles.results} aria-live="polite">
          {loading ? <p className={styles.hint}>正在查询 GitHub…</p> : null}
          {!loading && results.length === 0 && !error ? (
            <p className={styles.hint}>没有匹配的仓库。可直接输入 owner/repo 校验并添加。</p>
          ) : null}
          {results.map((repository) => (
            <div key={repository.fullName} className={styles.result}>
              <div>
                <strong>{repository.fullName}</strong>
                <span>
                  {repository.private ? '私有' : '公开'} · 默认分支 {repository.defaultBranch}
                  {repository.permissions.admin ? ' · Admin' : ''}
                </span>
              </div>
              <button
                type="button"
                className={styles.addButton}
                disabled={adding !== null || !repository.permissions.push}
                onClick={() => void add(repository.fullName)}
                title={repository.permissions.push ? undefined : '缺少写权限'}
              >
                {adding === repository.fullName ? '添加中…' : '添加'}
              </button>
            </div>
          ))}
        </div>

        <div className={styles.manual}>
          <label className={styles.field}>
            <span>直接输入 owner/repo</span>
            <input
              type="text"
              value={manual}
              placeholder="Bouyer12/example"
              onChange={(event) => setManual(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.primary}
            disabled={adding !== null}
            onClick={() => void add(manual)}
          >
            {adding && adding === manual.trim() ? '校验并添加中…' : '校验并添加'}
          </button>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <p className={styles.hint}>
          添加过程会校验专用账号的 push 权限；重复添加返回冲突，不会创建第二行或第二实例。
        </p>
      </div>
    </Modal>
  );
}
