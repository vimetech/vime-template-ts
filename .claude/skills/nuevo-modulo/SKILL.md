---
name: nuevo-modulo
description: Crea un módulo de dominio nuevo en modules/<nombre> copiando la forma de modules/example (schema, servicio, contratos, permisos, ruta, rls.test.ts, fronteras ESLint). Úsalo cuando una spec introduce una entidad de negocio nueva.
---

# Nuevo módulo de dominio

Requiere una spec aprobada en `specs/` que nombre la entidad y sus permisos. Sin spec, detente y pídela.

## Pasos

1. **Carpeta**: copia `modules/example` a `modules/<nombre>`. En `package.json` cambia `name` a `@vime/<nombre>`.
   Renombra `notes.ts` y `schema/notes.ts` por el agregado real; borra lo que no aplique.
2. **Schema**: una tabla por agregado con `tenantTable('<plural>', {...}, (t) => [índices])`. Índices con
   `organizationId` primero. Solo definiciones de tablas en `schema/`.
3. **Contratos**: `packages/contracts/src/<nombre>.ts` con `Create<X>Schema`, `Update<X>Schema`, `<X>Schema`,
   `List<X>QuerySchema`. Exporta desde `packages/contracts/src/index.ts`.
4. **Permisos**: en `packages/contracts/src/permissions.ts` agrega `<entidad>.read` y `<entidad>.write` a la lista
   y a la tabla de roles. Actualiza `permissions.test.ts`.
5. **Servicio**: `create/get/list/update/delete` con firma `(tx: Tx, ctx: ActorContext, ...)`. Valida con el contrato,
   filtra por `ctx.orgId` además de RLS, `recordActivity` en cada cambio, errores de `@vime/kernel`.
6. **Fronteras**: en `eslint.config.js` agrega `'<nombre>'` a `ALL`, una fila en `LAYERS`
   (`{ files: ['modules/<nombre>/**'], allow: ['platform', 'db', 'kernel', 'contracts', ...módulos previos] }`), y
   súmalo al `allow` de `apps/api` y `apps/worker`.
7. **Workspace**: `apps/api/package.json` → `"@vime/<nombre>": "workspace:*"`. `pnpm install`.
8. **Ruta**: `apps/api/src/routes/<nombre>.ts` siguiendo `notes.ts`; regístrala en `routes/index.ts` dentro del
   bloque de `ORG_PREFIX`. Si el módulo va detrás de un feature flag, agrégalo a `FEATURES` en contracts y crea su
   guard en `routes/common.ts`.
9. **Migración**: `pnpm db:generate`, lee el SQL generado (RLS, política, FK compuesta, índices), `pnpm db:migrate`.
10. **Tests**: `modules/<nombre>/src/rls.test.ts` con dos tenants (copia el patrón de example: `seedTenant`,
    `sqlState`); `apps/api/src/routes/<nombre>.test.ts` con al menos un caso de aislamiento.
11. `pnpm check` verde. Anota en la spec los archivos tocados.

## Qué no hacer

- No definir schemas Zod dentro del módulo.
- No importar otro módulo que no esté a la izquierda en `LAYERS`.
- No tocar `packages/db/migrations/0000-0002`.
