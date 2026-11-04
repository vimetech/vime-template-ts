import type { Permission } from '@vime/contracts';
import type { ReactNode } from 'react';
import { useT } from '../lib/i18n-hook';
import { useOrg } from '../lib/org';
import { EmptyState } from './ui';

/** Renders `children` only when the membership holds any of `anyOf` (the API enforces it too). */
export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: readonly Permission[];
  children: ReactNode;
}) {
  const { t } = useT();
  const { canAny } = useOrg();
  if (!canAny(...anyOf)) {
    return (
      <EmptyState icon="lock" title={t('states.forbiddenTitle')}>
        {t('states.forbiddenBody')}
      </EmptyState>
    );
  }
  return <>{children}</>;
}
