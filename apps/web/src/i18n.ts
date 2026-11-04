import { commonEn, commonEsPE } from '@vime/i18n/common';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '@vime/i18n/locales';
import { webEsPE } from '@vime/i18n/web/es-PE';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { importOrReload } from './lib/lazy';

/*
 * i18next with two namespaces: `web` (this app's strings, default) and `common` (enum labels
 * shared with mobile). es-PE is the primary language and ships with the app; the `en` web catalog
 * (same keys) is its own chunk, loaded only when someone uses English (`loadLocale`). The barrel
 * `@vime/i18n` is not imported here: it would pull both catalogs into the first download.
 */

export const resources = {
  'es-PE': { web: webEsPE, common: commonEsPE },
} as const;

const STORAGE_KEY = 'vime.locale';

function isSupported(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function storedLocale(): SupportedLocale {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isSupported(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Adds the catalogs of `locale` to i18next when they are not there yet (es-PE always is). */
export async function loadLocale(locale: SupportedLocale): Promise<void> {
  if (locale !== 'en' || i18n.hasResourceBundle('en', 'web')) return;
  const { webEn } = await importOrReload(() => import('@vime/i18n/web/en'));
  i18n.addResourceBundle('en', 'web', webEn, true, true);
  i18n.addResourceBundle('en', 'common', commonEn, true, true);
}

/** Switches the language; it is remembered only once its catalogs are in (a failed load changes nothing). */
export async function changeLocale(locale: SupportedLocale): Promise<void> {
  await loadLocale(locale);
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // not remembered
  }
  document.documentElement.lang = locale;
  await i18n.changeLanguage(locale);
}

/**
 * Starts i18next synchronously in es-PE, or in `locale` when its catalogs are already loaded
 * (`main.tsx` awaits `loadLocale` first for English).
 */
export function initI18n(locale: SupportedLocale = storedLocale()): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      ns: ['web', 'common'],
      defaultNS: 'web',
      fallbackNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
      // `en` arrives later through addResourceBundle.
      partialBundledLanguages: true,
    });
  }
  return i18n;
}

export { i18n };
