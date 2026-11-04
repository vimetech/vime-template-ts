import { useCallback, useEffect, useState } from 'react';

/*
 * Color theme: light, dark, or the system's ("Sistema", the default). A preference of this browser
 * (like the language), remembered in localStorage and followed by every open tab. An explicit
 * choice sets `data-theme` on <html>; "system" removes it and index.css follows
 * `prefers-color-scheme` on its own, so the system's theme applies before any script runs.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = 'vime.theme';

/** Browser bar color per theme (as in index.html; dark: the dark page background). */
const THEME_COLORS = { light: '#ffffff', dark: '#0b0f19' } as const;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isPreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage disabled (private mode): the choice lasts until the page is reloaded.
  }
}

function systemIsDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** The theme a preference shows now. */
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean = systemIsDark(),
): 'light' | 'dark' {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/** Applies a preference to the document (call before the first render, and on every change). */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
) {
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', THEME_COLORS[resolveTheme(preference)]);
}

/**
 * Applies the stored preference and keeps it applied: another tab changed it, or the system
 * switched while on "system" (the CSS follows by itself; the browser bar color does not).
 */
export function startTheme(): void {
  applyTheme(readThemePreference());
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) applyTheme(readThemePreference());
  });
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (readThemePreference() === 'system') applyTheme('system');
    });
  }
}

/** The stored preference and its setter (the selector in "Mi cuenta"). */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setState] = useState<ThemePreference>(readThemePreference);
  const setPreference = useCallback((next: ThemePreference) => {
    storeThemePreference(next);
    applyTheme(next);
    setState(next);
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setState(readThemePreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [preference, setPreference];
}
