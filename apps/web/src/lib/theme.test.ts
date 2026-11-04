import { afterEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, applyTheme, readThemePreference, resolveTheme } from './theme';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '';
});

describe('theme preference', () => {
  it('defaults to the system theme, also for an unknown stored value', () => {
    expect(readThemePreference()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readThemePreference()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readThemePreference()).toBe('dark');
  });

  it('resolves "system" from the system and keeps an explicit choice', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('marks an explicit choice on <html> and leaves "system" to the CSS', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#ffffff" />';
    const meta = document.querySelector('meta[name="theme-color"]');

    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(meta?.getAttribute('content')).toBe('#0b0f19');

    applyTheme('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(meta?.getAttribute('content')).toBe('#ffffff');

    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
