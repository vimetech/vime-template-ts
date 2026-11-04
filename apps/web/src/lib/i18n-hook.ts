import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

/** Namespaces every component can use: `web` (default) and `common:` (shared enum labels). */
export const NAMESPACES = ['web', 'common'] as const;

/** `useTranslation` with both namespaces loaded, so `t('common:taskStatus.open')` is typed. */
export function useT() {
  return useTranslation(NAMESPACES);
}

/** The `t` of `useT()` (for helpers that receive it). */
export type AppT = TFunction<typeof NAMESPACES>;
