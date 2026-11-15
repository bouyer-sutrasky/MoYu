import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { startRegistration } from '@simplewebauthn/browser';

import type {
  AuthMeData,
  AuthStateData,
  PasskeyCredentialSummary,
  RepositorySummary,
  SessionSummary,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeAuthError, isWebAuthnSupported } from '../lib/errors';
import { Icon, type IconName } from '../components/Icon';
import { ResponsiveSelect } from '../components/ResponsiveSelect';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { CleanupPanel } from './CleanupPanel';
import { NotificationSettingsSection } from './NotificationSettingsSection';
import { SuperagentSettings } from '../superagent/SuperagentSettings';
import styles from './SettingsDialog.module.css';

interface SettingsDialogProps {
  me: AuthMeData;
  authState: AuthStateData;
  /** Every added repository, so Superagent settings can be scoped to one. */
  repositories: RepositorySummary[];
  /** The repository the workbench is showing; the settings open on it. */
  selectedRepositoryId: string | null;
  onClose: () => void;
  onRefreshMe: () => Promise<void>;
  onLoggedOut: () => void;
  onSessionLost: () => void;
}

/**
 * The settings sections, in nav order. This mirrors the DSH settings shell
 * (`packages/client/ui-settings-general`): a left rail of section rows and one
 * active section rendered in the content column.
 */
type SettingsSectionId =
  | 'appearance'
  | 'notifications'
  | 'cleanup'
  | 'superagent'
  | 'passkeys'
  | 'sessions'
  | 'security';

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; icon: IconName }> = [
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'notifications', label: '通知', icon: 'bell' },
  { id: 'cleanup', label: '资源清理', icon: 'trash' },
  { id: 'superagent', label: 'Superagent', icon: 'work' },
  { id: 'passkeys', label: 'Passkey 凭据', icon: 'key' },
  { id: 'sessions', label: '浏览器会话', icon: 'session' },
  { id: 'security', label: '安全边界', icon: 'panel' },
];

/** One line under the section title, as the DSH shell does per section. */
const SECTION_HINTS: Record<SettingsSectionId, string> = {
  appearance: '沿用固定版本的 Harness design tokens；支持跟随系统、浅色与深色。',
  notifications: '什么情况下通知你、通知到哪里。',
  cleanup: '工单目录与运行痕迹的清理预览、回收与恢复。',
  superagent: '每个仓库有独立的运行时与配置；这里保存会转发到该仓库自己的实例。',
  passkeys: '登录凭据决定谁能进入这台工作台。所有删除操作都不可撤销。',
  sessions: '浏览器会话与 SSE 连接一一对应；撤销后该标签页立即失去访问权。',
  security: '这台机器上平台做了什么、没做什么，写在这里。',
};

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
  repositories,
  selectedRepositoryId,
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
  const [superagentRepositoryId, setSuperagentRepositoryId] = useState<string | null>(
    selectedRepositoryId ?? repositories[0]?.id ?? null,
  );
  const [section, setSection] = useState<SettingsSectionId>('appearance');
  const panelRef = useRef<HTMLDivElement>(null);

  // The DSH shell keeps Escape and an entering focus on the panel; the mask click
  // closes too. Modal's own shell is not used here because this panel is a rail
  // plus a content column, not a header-plus-body dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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

  const activeSection =
    SETTINGS_SECTIONS.find((row) => row.id === section) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={onClose}>
      <div className={styles.mask} aria-hidden="true" />
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-nav-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className={styles.nav} aria-label="设置分区">
          <div className={styles.navTitle} id="settings-nav-title">
            设置
          </div>
          <div className={styles.navList}>
            {SETTINGS_SECTIONS.map((row) => (
              <button
                key={row.id}
                type="button"
                className={clsx(
                  styles.navCell,
                  row.id === activeSection.id && styles.navCellActive,
                )}
                aria-current={row.id === activeSection.id ? 'true' : undefined}
                onClick={() => setSection(row.id)}
              >
                <Icon name={row.icon} size={16} />
                <span className={styles.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={styles.content}>
          <header className={styles.header}>
            <div>
              <h2 className={styles.title}>{activeSection.label}</h2>
              <p className={styles.description}>{SECTION_HINTS[activeSection.id]}</p>
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="关闭设置">
              <Icon name="x" />
            </button>
          </header>
          <div className={styles.options}>
            {section === 'appearance' ? (
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
            ) : null}
            {section === 'notifications' ? (
              <NotificationSettingsSection ownerId={me.owner.id} />
            ) : null}
            {section === 'cleanup' ? <CleanupPanel onSessionLost={onSessionLost} /> : null}
            {section === 'superagent' ? (
              <section className={styles.section} aria-labelledby="superagent-heading">
                <div className={styles.sectionHeading}>
                  <h3 id="superagent-heading">Superagent 设置（按仓库）</h3>
                  <p>
                    每个仓库有独立的 Superagent 实例与配置。这里的分组来自上游设置页，保存走 MoYu
                    鉴权接口并由 supervisor 转发到该仓库自己的运行时；A 与 B 互不影响。
                  </p>
                </div>
                <div className={styles.addRow}>
                  <label className={styles.muted} htmlFor="superagent-repository">
                    目标仓库
                  </label>
                  <ResponsiveSelect
                    id="superagent-repository"
                    label="目标仓库"
                    className={styles.input}
                    value={superagentRepositoryId ?? ''}
                    options={
                      repositories.length > 0
                        ? repositories.map(({ id, fullName }) => ({ value: id, label: fullName }))
                        : [{ value: '', label: '尚未添加仓库' }]
                    }
                    disabled={repositories.length === 0}
                    onChange={(value) => setSuperagentRepositoryId(value || null)}
                  />
                </div>
                <SuperagentSettings
                  repositoryId={superagentRepositoryId}
                  repositoryName={
                    repositories.find((repository) => repository.id === superagentRepositoryId)
                      ?.fullName ?? null
                  }
                />
              </section>
            ) : null}
            {section === 'passkeys' ? (
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
            ) : null}
            {section === 'sessions' ? (
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
            ) : null}
            {section === 'security' ? (
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
            ) : null}

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
        </div>
      </div>
    </div>
  );
}
