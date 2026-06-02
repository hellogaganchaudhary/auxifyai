'use client';

/**
 * Theme provider for the application shell (Requirement 40.4).
 *
 * Holds the user's {@link ThemePreference}, persists it to `localStorage`, and
 * applies the corresponding `data-theme` attribute to `<html>` (and `<body>`)
 * so the CSS custom properties in `globals.css` switch the palette. The
 * provider defaults to `system`, which follows the OS `prefers-color-scheme`,
 * and reacts live to OS changes while the `system` preference is active.
 *
 * The pure theme logic lives in `@/lib/theme`; this component owns only the
 * React state and the browser side effects.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

/** The value exposed by the theme context. */
interface ThemeContextValue {
  /** The currently selected preference. */
  preference: ThemePreference;
  /** The concrete theme currently applied to the document. */
  resolved: ResolvedTheme;
  /** Update the preference (persists it and re-applies the theme). */
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the OS dark-mode preference, guarding against non-browser environments. */
function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Provider that wires theme preference state to the document. Render it high in
 * the tree (the root layout) so every screen can read and change the theme.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(false);

  // Hydrate the persisted preference and current OS preference once mounted.
  useEffect(() => {
    setSystemPrefersDark(getSystemPrefersDark());
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemePreference(stored)) {
        setPreferenceState(stored);
      }
    } catch {
      // localStorage may be unavailable (privacy mode); fall back to default.
    }
  }, []);

  // Track live OS scheme changes so `system` stays in sync.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved = useMemo(
    () => resolveTheme(preference, systemPrefersDark),
    [preference, systemPrefersDark],
  );

  // Apply the preference to the document so CSS variables update. We set the
  // raw preference (including `system`) so the `prefers-color-scheme` rules in
  // globals.css can take over for `system`.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', preference);
    root.style.colorScheme = resolved;
    if (document.body) {
      document.body.setAttribute('data-theme', preference);
    }
  }, [preference, resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the in-memory preference still applies.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Access the theme context. Throws if used outside a {@link ThemeProvider} so
 * misuse fails fast during development.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
