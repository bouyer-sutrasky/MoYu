import { useCallback, useEffect, useState } from 'react';

import type { AuthMeData, AuthStateData } from '@moyu/contracts';

import { LoginPage } from './auth/LoginPage';
import { SetupPage } from './auth/SetupPage';
import { api, ApiClientError } from './lib/api';
import { describeAuthError } from './lib/errors';
import { WorkspaceShell } from './shell/WorkspaceShell';
import { ThemeProvider } from './theme/ThemeProvider';
import styles from './App.module.css';

type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; authState: AuthStateData }
  | { status: 'authenticated'; authState: AuthStateData; me: AuthMeData }
  | { status: 'error'; message: string };

function AppInner() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: string, replace = false) => {
    if (window.location.pathname === next) {
      return;
    }
    if (replace) {
      window.history.replaceState({}, '', next);
    } else {
      window.history.pushState({}, '', next);
    }
    setPath(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const authState = await api.authState();
      try {
        const me = await api.me();
        setSession({ status: 'authenticated', authState, me });
      } catch (caught) {
        if (caught instanceof ApiClientError && caught.status === 401) {
          setSession({ status: 'anonymous', authState });
        } else {
          setSession({ status: 'error', message: describeAuthError(caught) });
        }
      }
    } catch (caught) {
      setSession({ status: 'error', message: describeAuthError(caught) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (session.status === 'authenticated' && path === '/setup') {
      navigate('/', true);
    }
  }, [session.status, path, navigate]);

  const sessionLost = useCallback(() => {
    navigate('/', true);
    void refresh();
  }, [navigate, refresh]);

  if (session.status === 'loading') {
    return (
      <main className={styles.splash} aria-busy="true">
        <span className={styles.splashMark}>Mo</span>
        <p>正在读取登录状态…</p>
      </main>
    );
  }

  if (session.status === 'error') {
    return (
      <main className={styles.splash}>
        <span className={styles.splashMark}>Mo</span>
        <h1>无法打开工作台</h1>
        <p className={styles.errorText}>{session.message}</p>
        <button type="button" className={styles.retry} onClick={() => void refresh()}>
          重试
        </button>
      </main>
    );
  }

  if (session.status === 'authenticated') {
    return (
      <WorkspaceShell
        me={session.me}
        authState={session.authState}
        onSessionLost={sessionLost}
        onRefreshMe={refresh}
        onLoggedOut={sessionLost}
      />
    );
  }

  const { authState } = session;
  const needsSetup = authState.setupOpen || authState.recoveryOpen || path === '/setup';

  if (needsSetup) {
    return (
      <SetupPage
        authState={authState}
        onRegistered={refresh}
        onGoLogin={() => {
          navigate('/', true);
          void refresh();
        }}
      />
    );
  }

  return <LoginPage authState={authState} onAuthenticated={refresh} />;
}

export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
