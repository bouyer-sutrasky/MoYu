import { useEffect, useState } from 'react';

import { Icon } from '../components/Icon';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  DEFAULT_NOTIFICATION_SETTINGS,
  loadNotificationSettings,
  saveNotificationSettings,
  type NotificationSettings,
} from '../lib/activity';
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '../lib/notifications';
import styles from './NotificationSettingsSection.module.css';

interface NotificationSettingsSectionProps {
  ownerId: string;
}

const MODE_OPTIONS: Array<{
  mode: NotificationSettings['mode'];
  label: string;
  hint: string;
}> = [
  { mode: 'off', label: '从不', hint: '不弹系统通知，活动中心仍记录未读。' },
  { mode: 'background', label: '仅后台', hint: '页面在后台时提醒；正在看页面时只记未读。' },
  { mode: 'always', label: '总是', hint: '页面在前台时也弹系统通知。' },
];

const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  unsupported: '当前浏览器不支持 Web Notification。',
  default: '尚未授权；点击右侧按钮授权，授权前不会弹窗。',
  granted: '浏览器已允许 MoYu 显示通知。',
  denied: '浏览器已拒绝通知。请在地址栏的站点设置中重新允许，然后刷新本页。',
};

export function NotificationSettingsSection({ ownerId }: NotificationSettingsSectionProps) {
  const [settings, setSettings] = useState<NotificationSettings>(() =>
    loadNotificationSettings(ownerId),
  );
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    notificationPermission(),
  );
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    setSettings(loadNotificationSettings(ownerId));
  }, [ownerId]);

  function update(next: NotificationSettings) {
    setSettings(next);
    saveNotificationSettings(ownerId, next);
  }

  async function request() {
    if (permission !== 'default') return;
    setRequesting(true);
    try {
      setPermission(await requestNotificationPermission());
    } finally {
      setRequesting(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="notifications-heading">
      <div className={styles.sectionHeading}>
        <h3 id="notifications-heading">通知</h3>
        <p>
          仅网页打开时提供系统通知，不实现关闭网页后的 Web Push；重新打开后可在活动中心补看。
          同一事件使用持久事件 id 去重，重连、刷新和多标签页都只提醒一次。
        </p>
      </div>

      <div className={styles.modeRow} role="group" aria-label="系统通知时机">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={settings.mode === option.mode ? styles.modeActive : styles.modeButton}
            aria-pressed={settings.mode === option.mode}
            onClick={() => update({ ...settings, mode: option.mode })}
          >
            <span>{option.label}</span>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>

      <fieldset className={styles.categories} disabled={settings.mode === 'off'}>
        <legend>提醒类别</legend>
        {ACTIVITY_CATEGORIES.map((category) => (
          <label key={category} className={styles.category}>
            <input
              type="checkbox"
              checked={settings.categories[category]}
              onChange={(event) =>
                update({
                  ...settings,
                  categories: { ...settings.categories, [category]: event.target.checked },
                })
              }
            />
            <span>{ACTIVITY_CATEGORY_LABELS[category]}</span>
          </label>
        ))}
        <p className={styles.categoryHint}>普通进度不弹通知；类别开关只影响系统通知。</p>
      </fieldset>

      <div className={styles.permissionRow}>
        <span className={styles.permissionIcon} data-state={permission}>
          <Icon name="bell" size={16} />
        </span>
        <div className={styles.permissionText}>
          <strong>浏览器通知权限</strong>
          <span>{PERMISSION_TEXT[permission]}</span>
        </div>
        {permission === 'default' ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void request()}
            disabled={requesting}
          >
            {requesting ? '等待浏览器…' : '允许通知'}
          </button>
        ) : (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setPermission(notificationPermission())}
          >
            重新检查
          </button>
        )}
      </div>

      <button
        type="button"
        className={styles.textButton}
        onClick={() => update(DEFAULT_NOTIFICATION_SETTINGS)}
      >
        恢复默认（仅后台，全部类别）
      </button>
    </section>
  );
}
