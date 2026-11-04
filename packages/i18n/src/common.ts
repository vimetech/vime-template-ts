/**
 * A translation catalog with exactly the keys of the source (es-PE) catalog `T`, nested the same
 * way, holding any strings. Excess-property checks on the object literal reject extra keys.
 */
export type CatalogOf<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : CatalogOf<T[K]>;
};

/**
 * Strings shared by every client: labels of the enums of `@vime/contracts` (keyed by the enum
 * value, so `common:roleKey.${member.roleKeys[0]}` works) and of the API problem codes. es-PE is
 * the source language; `en` must have exactly the same keys (the compiler checks it through
 * `CatalogOf`, and the web tests check that every contracts enum value has a label). A domain
 * module adds the labels of its own enums here.
 */
export const commonEsPE = {
  appName: 'VIME',

  /** RoleKey. */
  roleKey: {
    owner: 'Dueño',
    admin: 'Administrador',
    manager: 'Gestor',
    member: 'Miembro',
  },
  /** MembershipStatus. */
  membershipStatus: {
    active: 'Activa',
    suspended: 'Suspendida',
  },
  /** FeatureKey (the modules the platform turns on per organization). */
  feature: {
    example: 'Notas (ejemplo)',
    advanced_insights: 'Reportes avanzados',
  },
  /** FlagKind: exception queue entries. */
  flagKind: {
    example_needs_review: 'Nota por revisar',
  },
  /** FlagSeverity. */
  flagSeverity: {
    info: 'Informativa',
    warning: 'Advertencia',
    critical: 'Crítica',
  },
  /** FlagStatus. */
  flagStatus: {
    open: 'Abierta',
    resolved: 'Resuelta',
    dismissed: 'Descartada',
  },
  /** ActivitySource. */
  activitySource: {
    web: 'Web',
    mobile: 'App',
    webhook: 'Webhook',
    system: 'Sistema',
    import: 'Importación',
    platform: 'Plataforma',
  },
  /** Weekday (0 = Sunday … 6 = Saturday, as `Date#getDay`). */
  weekday: {
    '0': 'Domingo',
    '1': 'Lunes',
    '2': 'Martes',
    '3': 'Miércoles',
    '4': 'Jueves',
    '5': 'Viernes',
    '6': 'Sábado',
  },
  weekdayShort: {
    '0': 'Dom',
    '1': 'Lun',
    '2': 'Mar',
    '3': 'Mié',
    '4': 'Jue',
    '5': 'Vie',
    '6': 'Sáb',
  },
  /** API problem codes (`ProblemDetails.code`), plus `network` for requests that never arrived. */
  problem: {
    validation_failed: 'Revisa los datos ingresados.',
    unauthenticated: 'Tu sesión terminó. Vuelve a ingresar.',
    forbidden: 'No tienes permiso para hacer esto.',
    not_found: 'No se encontró lo que buscas.',
    conflict:
      'Hay un conflicto con los datos actuales (ya existe o cambió hace un momento). Revisa y vuelve a intentar.',
    feature_not_enabled: 'Esta función no está habilitada para tu organización.',
    organization_suspended:
      'El acceso a tu organización está suspendido. Pide a quien la administra que hable con VIME.',
    idempotency_conflict: 'Esta acción ya se envió con otros datos.',
    idempotency_in_progress: 'Esta acción todavía se está procesando.',
    precondition_failed: 'No se cumplen los requisitos para esta acción.',
    rate_limited: 'Demasiados intentos. Espera un momento y vuelve a intentar.',
    app_version_unsupported: 'Esta versión ya no es compatible. Actualiza la aplicación.',
    internal: 'Ocurrió un error en el servidor. Vuelve a intentar.',
    network: 'No hay conexión con el servidor.',
    unknown: 'Ocurrió un error inesperado.',
  },
} as const;

export const commonEn: CatalogOf<typeof commonEsPE> = {
  appName: 'VIME',
  roleKey: {
    owner: 'Owner',
    admin: 'Admin',
    manager: 'Manager',
    member: 'Member',
  },
  membershipStatus: {
    active: 'Active',
    suspended: 'Suspended',
  },
  feature: {
    example: 'Notes (example)',
    advanced_insights: 'Advanced insights',
  },
  flagKind: {
    example_needs_review: 'Note to review',
  },
  flagSeverity: {
    info: 'Info',
    warning: 'Warning',
    critical: 'Critical',
  },
  flagStatus: {
    open: 'Open',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
  },
  activitySource: {
    web: 'Web',
    mobile: 'App',
    webhook: 'Webhook',
    system: 'System',
    import: 'Import',
    platform: 'Platform',
  },
  weekday: {
    '0': 'Sunday',
    '1': 'Monday',
    '2': 'Tuesday',
    '3': 'Wednesday',
    '4': 'Thursday',
    '5': 'Friday',
    '6': 'Saturday',
  },
  weekdayShort: {
    '0': 'Sun',
    '1': 'Mon',
    '2': 'Tue',
    '3': 'Wed',
    '4': 'Thu',
    '5': 'Fri',
    '6': 'Sat',
  },
  problem: {
    validation_failed: 'Check the data you entered.',
    unauthenticated: 'Your session ended. Sign in again.',
    forbidden: 'You are not allowed to do this.',
    not_found: 'Not found.',
    conflict:
      'This conflicts with the current data (it already exists or just changed). Check and try again.',
    feature_not_enabled: 'This feature is not enabled for your organization.',
    organization_suspended:
      'Access to your organization is suspended. Ask its administrator to contact VIME.',
    idempotency_conflict: 'This action was already sent with different data.',
    idempotency_in_progress: 'This action is still being processed.',
    precondition_failed: 'The requirements for this action are not met.',
    rate_limited: 'Too many attempts. Wait a moment and try again.',
    app_version_unsupported: 'This version is no longer supported. Update the app.',
    internal: 'Something went wrong on the server. Try again.',
    network: 'Cannot reach the server.',
    unknown: 'Something unexpected went wrong.',
  },
};
