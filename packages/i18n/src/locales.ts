export const SUPPORTED_LOCALES = ['es-PE', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'es-PE';
