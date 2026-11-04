import { useT } from './i18n-hook';
import { DEFAULT_FORMAT_LOCALE } from './time';

/** Locale for Intl formatting: the UI language (es-PE by default). */
export function useFormatLocale(): string {
  const { i18n } = useT();
  return i18n.language === 'en' ? 'en' : DEFAULT_FORMAT_LOCALE;
}
