import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

import type { AuthStateData } from '@moyu/contracts';

import { api } from '../lib/api';
import { describeAuthError, isWebAuthnSupported } from '../lib/errors';
import { Icon } from '../components/Icon';
import styles from './AuthPage.module.css';

interface LoginPageProps {
  authState: AuthStateData;
  onAuthenticated: () => Promise<void>;
}

export function LoginPage({ authState, onAuthenticated }: LoginPageProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isWebAuthnSupported();

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.loginOptions();
      const response = await startAuthentication({
        optionsJSON: options.optionsJSON as never,
      });
      await api.verifyLogin(options.ceremonyId, response as unknown as Record<string, unknown>);
      await onAuthenticated();
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.brandRow}>
          <span className={styles.mark} aria-hidden="true">
            Mo
          </span>
          <div>
            <p className={styles.eyebrow}>MoYu · 个人智能体工作台</p>
            <p className={styles.phase}>M2 · Passkey 与页面外壳</p>
          </div>
        </div>

        <h1 id="login-title" className={styles.title}>
          使用 Passkey 登录
        </h1>
        <p className={styles.lead}>
          单所有者入口，不设用户名密码。登录会长期保持，直到你主动退出或撤销浏览器会话。
        </p>

        {supported ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => void signIn()}
            disabled={busy}
          >
            <Icon name="key" />
            {busy ? '等待认证器…' : '使用 Passkey 登录'}
          </button>
        ) : (
          <p className={styles.warning}>当前浏览器不支持 WebAuthn，无法使用 Passkey。</p>
        )}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <dl className={styles.meta}>
          <div>
            <dt>RP ID</dt>
            <dd>{authState.rpId}</dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>{authState.origin}</dd>
          </div>
          <div>
            <dt>已登记凭据</dt>
            <dd>{authState.activeCredentialCount}</dd>
          </div>
        </dl>

        {authState.recoveryOpen ? (
          <p className={styles.hint}>
            当前没有可用的 Passkey。请让服务器生成一次性恢复码，再打开 <a href="/setup">绑定页面</a>
            。
          </p>
        ) : (
          <p className={styles.hint}>新增或撤销 Passkey、管理浏览器会话请登录后进入设置。</p>
        )}
      </section>
      <p className={styles.footer}>
        Passkey 凭据只绑定 {authState.rpId}；不会在 localhost、IP 或其它域名下登记。
      </p>
    </main>
  );
}
