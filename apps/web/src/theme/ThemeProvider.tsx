import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'moyu.theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function readStoredTheme(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') {
      return value;
    }
  } catch {
    /* Private-mode storage can throw; fall back to system. */
  }
  return 'system';
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(mode: ThemeMode, resolved: ResolvedTheme): void {
  if (resolved === 'dark') {
    document.body.setAttribute('data-ds-dark-theme', '');
  } else {
    document.body.removeAttribute('data-ds-dark-theme');
  }
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.dataset.theme = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    applyTheme(mode, resolved);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* Persisting the preference is best effort. */
    }
  }, [mode, resolved]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }
  return value;
}
