import { useCallback, useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

import type {
  AuthMeData,
  AuthStateData,
  PasskeyCredentialSummary,
  SessionSummary,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeAuthError, isWebAuthnSupported } from '../lib/errors';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { CleanupPanel } from './CleanupPanel';
import { NotificationSettingsSection } from './NotificationSettingsSection';
import styles from './SettingsDialog.module.css';

interface SettingsDialogProps {
  me: AuthMeData;
  authState: AuthStateData;
  onClose: () => void;
  onRefreshMe: () => Promise<void>;
  onLoggedOut: () => void;
  onSessionLost: () => void;
}

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: 'monitor' | 'sun' | 'moon' }> = [
  { mode: 'system', label: '跟随系统', icon: 'monitor' },
  { mode: 'light', label: '浅色', icon: 'sun' },
  { mode: 'dark', label: '深色', icon: 'moon' },
];

function formatDate(value: string | null): string {
  if (!value) {
    return '从未使用';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function deviceLabel(credential: PasskeyCredentialSummary): string {
  if (credential.deviceType === 'multiDevice') {
    return credential.backedUp ? '多设备 · 已同步' : '多设备';
  }
  if (credential.deviceType === 'singleDevice') {
    return '单设备';
  }
  return '设备类型未知';
}

export function SettingsDialog({
  me,
  authState,
  onClose,
  onRefreshMe,
  onLoggedOut,
  onSessionLost,
}: SettingsDialogProps) {
  const { mode, setMode } = useTheme();
  const [credentials, setCredentials] = useState<PasskeyCredentialSummary[]>(me.credentials);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const supported = isWebAuthnSupported();

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setError(describeAuthError(caught));
    },
    [onSessionLost],
  );

  const reload = useCallback(async () => {
    try {
      const [credentialResult, sessionResult] = await Promise.all([
        api.credentials(),
        api.sessions(),
      ]);
      setCredentials(credentialResult.credentials);
      setSessions(sessionResult.sessions);
    } catch (caught) {
      handleError(caught);
    }
  }, [handleError]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await reload();
      setLoading(false);
    })();
  }, [reload]);

  async function addPasskey() {
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const options = await api.registrationOptions(label.trim() || undefined);
      const response = await startRegistration({ optionsJSON: options.optionsJSON as never });
      await api.verifyRegistration(
        options.ceremonyId,
        response as unknown as Record<string, unknown>,
      );
      setLabel('');
      setNotice('新的 Passkey 已登记。');
      await onRefreshMe();
      await reload();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function revokeCredential(credential: PasskeyCredentialSummary) {
    if (confirmKey !== `credential:${credential.id}`) {
      setConfirmKey(`credential:${credential.id}`);
      return;
    }
    setBusy(`credential:${credential.id}`);
    setError(null);
    try {
      await api.revokeCredential(credential.id);
      setNotice('Passkey 已撤销，相关浏览器会话已同时撤销。');
      setConfirmKey(null);
      await onRefreshMe();
      await reload();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function revokeSession(session: SessionSummary) {
    if (confirmKey !== `session:${session.id}`) {
      setConfirmKey(`session:${session.id}`);
      return;
    }
    setBusy(`session:${session.id}`);
    setError(null);
    try {
      await api.revokeSession(session.id);
      setNotice('浏览器会话已撤销；对应的 SSE 连接会立即关闭。');
      setConfirmKey(null);
      await reload();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    setBusy('logout');
    setError(null);
    try {
      await api.logout();
      onLoggedOut();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="设置"
      description="登录凭据、浏览器会话与主题。所有操作直接调用当前 API。"
      onClose={onClose}
      wide
    >
      <div className={styles.content}>
        <section className={styles.section} aria-labelledby="theme-heading">
          <div className={styles.sectionHeading}>
            <h3 id="theme-heading">外观</h3>
            <p>沿用固定版本的 Harness design tokens；支持跟随系统、浅色与深色。</p>
          </div>
          <div className={styles.themeRow} role="group" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={option.mode === mode ? styles.themeActive : styles.themeButton}
                aria-pressed={option.mode === mode}
                onClick={() => setMode(option.mode)}
              >
                <Icon name={option.icon} />
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <NotificationSettingsSection ownerId={me.owner.id} />

        <CleanupPanel onSessionLost={onSessionLost} />

        <section className={styles.section} aria-labelledby="passkeys-heading">
          <div className={styles.sectionHeading}>
            <h3 id="passkeys-heading">Passkey 凭据</h3>
            <p>
              当前 RP ID <code>{authState.rpId}</code>，共 {credentials.length}{' '}
              个可用凭据。至少保留一个。
            </p>
          </div>

          <ul className={styles.list}>
            {credentials.map((credential) => {
              const isConfirming = confirmKey === `credential:${credential.id}`;
              const isLast = credentials.length <= 1;
              return (
                <li key={credential.id} className={styles.listItem}>
                  <span className={styles.listIcon}>
                    <Icon name="key" />
                  </span>
                  <div className={styles.listText}>
                    <strong>{credential.label || '未命名 Passkey'}</strong>
                    <span>
                      {deviceLabel(credential)} · 创建于 {formatDate(credential.createdAt)}
                    </span>
                    <span>最近使用：{formatDate(credential.lastUsedAt)}</span>
                  </div>
                  <button
                    type="button"
                    className={isConfirming ? styles.dangerConfirm : styles.dangerButton}
                    disabled={isLast || busy === `credential:${credential.id}`}
                    title={isLast ? '不能撤销最后一个可用凭据' : '撤销此 Passkey'}
                    onClick={() => void revokeCredential(credential)}
                  >
                    {isConfirming ? '确认撤销' : '撤销'}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className={styles.addRow}>
            <input
              className={styles.input}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="新 Passkey 标签（可选）"
              maxLength={80}
              aria-label="新 Passkey 标签"
            />
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!supported || busy === 'add'}
              title={supported ? '登记新的 Passkey' : '当前浏览器不支持 WebAuthn'}
              onClick={() => void addPasskey()}
            >
              <Icon name="plus" />
              {busy === 'add' ? '等待认证器…' : '添加 Passkey'}
            </button>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="sessions-heading">
          <div className={styles.sectionHeading}>
            <h3 id="sessions-heading">浏览器会话</h3>
            <p>登录长期保持；撤销会立即断开该会话的 SSE 并阻止受保护资源访问。</p>
          </div>
          {loading ? (
            <p className={styles.muted}>正在读取会话…</p>
          ) : (
            <ul className={styles.list}>
              {sessions.map((session) => {
                const isConfirming = confirmKey === `session:${session.id}`;
                return (
                  <li key={session.id} className={styles.listItem}>
                    <span className={styles.listIcon}>
                      <Icon name="session" />
                    </span>
                    <div className={styles.listText}>
                      <strong>
                        {session.current ? '当前浏览器' : '其他浏览器'}
                        {session.current ? <span className={styles.badge}>当前</span> : null}
                      </strong>
                      <span className={styles.ellipsis}>
                        {session.userAgent || '未知 User-Agent'}
                      </span>
                      <span>
                        最近活动 {formatDate(session.lastUsedAt)} · 有效至{' '}
                        {formatDate(session.expiresAt)}
                      </span>
                    </div>
                    {session.current ? (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy === 'logout'}
                        onClick={() => void logout()}
                      >
                        退出
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={isConfirming ? styles.dangerConfirm : styles.dangerButton}
                        disabled={busy === `session:${session.id}`}
                        onClick={() => void revokeSession(session)}
                      >
                        {isConfirming ? '确认撤销' : '撤销'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="security-heading">
          <div className={styles.sectionHeading}>
            <h3 id="security-heading">安全边界</h3>
            <p>
              所有 Passkey 仅登记在 <code>{authState.origin}</code>。会话 Cookie 为
              HttpOnly、SameSite=Lax， 服务端只保存令牌摘要。
            </p>
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>所有者</dt>
              <dd>{me.owner.displayName}</dd>
            </div>
            <div>
              <dt>当前会话</dt>
              <dd title={me.session.id}>{me.session.id}</dd>
            </div>
            <div>
              <dt>会话有效期</dt>
              <dd>{formatDate(me.session.expiresAt)}</dd>
            </div>
          </dl>
        </section>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={busy === 'logout'}
            onClick={() => void logout()}
          >
            <Icon name="logout" size={15} />
            退出登录
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
