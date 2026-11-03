import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

import type { AuthStateData, BootstrapExchangeData } from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeAuthError, isWebAuthnSupported } from '../lib/errors';
import { Icon } from '../components/Icon';
import styles from './AuthPage.module.css';

interface SetupPageProps {
  authState: AuthStateData;
  onRegistered: () => Promise<void>;
  onGoLogin: () => void;
}

type Step = 'code' | 'passkey';

export function SetupPage({ authState, onRegistered, onGoLogin }: SetupPageProps) {
  const closed = authState.initialized && authState.activeCredentialCount > 0;
  const mode = authState.recoveryOpen ? 'recovery' : 'initial';
  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [exchanged, setExchanged] = useState<BootstrapExchangeData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isWebAuthnSupported();

  async function exchange() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.exchangeBootstrapCode(code);
      setExchanged(result);
      setStep('passkey');
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.registrationOptions(label.trim() || undefined);
      const response = await startRegistration({
        optionsJSON: options.optionsJSON as never,
      });
      await api.verifyRegistration(
        options.ceremonyId,
        response as unknown as Record<string, unknown>,
      );
      await onRegistered();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'conflict') {
        setError(`${caught.message}；如果初始化已完成，请直接登录。`);
      } else {
        setError(describeAuthError(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="setup-closed-title">
          <div className={styles.brandRow}>
            <span className={styles.mark} aria-hidden="true">
              Mo
            </span>
            <div>
              <p className={styles.eyebrow}>MoYu · 初始化入口</p>
              <p className={styles.phase}>已关闭</p>
            </div>
          </div>
          <h1 id="setup-closed-title" className={styles.title}>
            初始化已完成
          </h1>
          <p className={styles.lead}>
            首个 Passkey 登记后，公开的首次绑定入口已关闭。请使用已登记的 Passkey
            登录；如需新增凭据，请登录后在设置中添加。
          </p>
          <button type="button" className={styles.primary} onClick={onGoLogin}>
            <Icon name="key" />
            前往登录
          </button>
          <p className={styles.hint}>
            全部 Passkey 丢失时，由服务器命令生成一次性恢复码；普通用户无法从网页重新打开初始化。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="setup-title">
        <div className={styles.brandRow}>
          <span className={styles.mark} aria-hidden="true">
            Mo
          </span>
          <div>
            <p className={styles.eyebrow}>
              MoYu · {mode === 'initial' ? '首次绑定' : '服务器恢复'}
            </p>
            <p className={styles.phase}>一次性绑定码 → Passkey</p>
          </div>
        </div>

        <h1 id="setup-title" className={styles.title}>
          {mode === 'initial' ? '完成首次登记' : '使用恢复码重新绑定'}
        </h1>
        <p className={styles.lead}>
          {mode === 'initial'
            ? '绑定码由服务器命令生成，短期有效且只能使用一次。首次 Passkey 登记完成后，此入口自动关闭。'
            : '所有可用 Passkey 都已丢失。请输入服务器侧生成的一次性恢复码，登记新的 Passkey。'}
        </p>

        <ol className={styles.steps} aria-label="绑定步骤">
          <li className={step === 'code' ? styles.stepActive : styles.stepDone}>
            <span>1</span> 输入绑定码
          </li>
          <li className={step === 'passkey' ? styles.stepActive : undefined}>
            <span>2</span> 创建 Passkey
          </li>
        </ol>

        {step === 'code' ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void exchange();
            }}
          >
            <label className={styles.fieldLabel} htmlFor="bootstrap-code">
              绑定码
            </label>
            <input
              id="bootstrap-code"
              className={styles.codeInput}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              spellCheck={false}
              autoFocus
              required
            />
            <p className={styles.hint}>
              绑定码只在本页内使用，不会写入浏览器存储；服务端只保存摘要。
            </p>
            <button
              type="submit"
              className={styles.primary}
              disabled={busy || code.trim().length < 8}
            >
              <Icon name="key" />
              {busy ? '验证中…' : '验证绑定码'}
            </button>
          </form>
        ) : (
          <div className={styles.form}>
            <p className={styles.success} role="status">
              绑定码已消费。请在{' '}
              {exchanged ? formatTime(exchanged.registrationExpiresAt) : '限定时间'}
              前完成 Passkey 登记。
            </p>
            <label className={styles.fieldLabel} htmlFor="passkey-label">
              Passkey 标签（可选）
            </label>
            <input
              id="passkey-label"
              className={styles.input}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：MacBook 触控 ID"
              maxLength={80}
              autoComplete="off"
            />
            {supported ? (
              <button
                type="button"
                className={styles.primary}
                onClick={() => void register()}
                disabled={busy}
              >
                <Icon name="plus" />
                {busy ? '等待认证器…' : '创建 Passkey'}
              </button>
            ) : (
              <p className={styles.warning}>当前浏览器不支持 WebAuthn，无法创建 Passkey。</p>
            )}
            <p className={styles.hint}>
              认证器必须完成用户验证（PIN、指纹或系统解锁），否则服务端会拒绝登记。
            </p>
          </div>
        )}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <p className={styles.hint}>
          {mode === 'recovery'
            ? '恢复完成后，旧的 Passkey 记录仍保留为已撤销状态；可在设置中查看。'
            : '请勿把绑定码粘贴到 Issue、聊天或日志中。'}
        </p>
      </section>
    </main>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '限定时间'
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
