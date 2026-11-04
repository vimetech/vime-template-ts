import type { NavKey } from '../lib/nav';

/** Route path of each navigation entry (typed `to` for links). */
export const NAV_PATHS = {
  notes: '/o/$orgId/notas',
  settings: '/o/$orgId/configuracion',
} as const satisfies Record<NavKey, string>;
