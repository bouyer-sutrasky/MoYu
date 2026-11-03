import { healthResponseSchema, type HealthData } from '@moyu/contracts';
import { useEffect, useState } from 'react';

import styles from './App.module.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthData }
  | { status: 'error'; message: string };

function statusClassName(state: HealthState): string {
  if (state.status === 'ok') {
    return `${styles.status} ${styles.statusOk}`;
  }
  if (state.status === 'error') {
    return `${styles.status} ${styles.statusError}`;
  }
  return `${styles.status} ${styles.statusLoading}`;
}

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      try {
        const response = await fetch(`${API_BASE_URL}/healthz`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = healthResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error('健康检查响应不符合共享契约');
        }
        setHealth({ status: 'ok', data: parsed.data.data });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setHealth({
          status: 'error',
          message: error instanceof Error ? error.message : '未知错误',
        });
      }
    }

    void checkHealth();

    return () => controller.abort();
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>MoYu · M1 工程与存储</p>
          <h1 className={styles.title}>个人智能体工作台</h1>
          <p className={styles.lead}>
            Monorepo、共享契约、API 健康检查与 PostgreSQL 初始 schema
            已就位。Passkey、消息闭环与多仓库调度按阶段实现。
          </p>
        </div>
        <span className={styles.badge}>M1</span>
      </header>

      <main className={styles.grid}>
        <section className={styles.card} aria-labelledby="status-heading">
          <h2 id="status-heading">系统状态</h2>
          <p className={styles.label}>API 健康检查</p>
          <div className={statusClassName(health)} role="status" aria-live="polite">
            {health.status === 'loading' && '检查中…'}
            {health.status === 'ok' &&
              `正常 · v${health.data.version} · 已运行 ${health.data.uptimeSeconds}s`}
            {health.status === 'error' && `不可达：${health.message}`}
          </div>
          <p className={styles.hint}>
            开发时 Vite 将 /healthz 代理到 API。数据迁移与唯一性验证需要真实 PostgreSQL，步骤见
            README。
          </p>
        </section>

        <section className={styles.card} aria-labelledby="done-heading">
          <h2 id="done-heading">已建立</h2>
          <ul>
            <li>Web / API / dispatcher 三进程骨架</li>
            <li>Zod 请求、响应与事件契约</li>
            <li>Drizzle schema 与首个迁移</li>
            <li>消息与待投递记录的同事务写入原语</li>
            <li>结构化日志与 CI 工作流</li>
          </ul>
        </section>

        <section className={styles.card} aria-labelledby="next-heading">
          <h2 id="next-heading">后续阶段</h2>
          <ul className={styles.mutedList}>
            <li>M2：Passkey 登录与主题外壳</li>
            <li>M3：消息 → 任务 → PR 闭环</li>
            <li>Chat：预留接口，当前不可发送</li>
          </ul>
        </section>
      </main>

      <footer className={styles.footer}>
        当前版本只交付 M1，未实现的功能不在此页面伪装为可用。
      </footer>
    </div>
  );
}
