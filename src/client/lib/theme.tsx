import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';
const Ctx = createContext<{ pref: ThemePref; resolved: 'dark' | 'light'; setPref: (p: ThemePref) => void }>({ pref: 'dark', resolved: 'dark', setPref: () => {} });

function resolve(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem('alypne-theme') as ThemePref) || 'dark';
    } catch {
      return 'dark';
    }
  });
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolve(pref));
  useEffect(() => {
    const apply = () => {
      const r = resolve(pref);
      setResolved(r);
      document.documentElement.setAttribute('data-theme', r);
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', r === 'dark' ? '#0b0b0e' : '#f6f6f8');
    };
    apply();
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem('alypne-theme', p);
    } catch {
      /* ignore */
    }
  }, []);
  return <Ctx.Provider value={{ pref, resolved, setPref }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
