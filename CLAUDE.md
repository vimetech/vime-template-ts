# <PROJECT_NAME> — guía para Claude Code

Proyecto de VIME TECH LABS nacido de `vime-template-ts` v0.1 (Stack VIME v1). Lee `docs/ARCHITECTURE.md` antes de
tocar la estructura y `docs/CONVENTIONS.md` antes de escribir código. Las decisiones viven en `docs/adr/`.

## Regla cero: no se codea sin spec

Un feature empieza en `specs/<feature>.md` (copia `specs/_TEMPLATE.md`). Si no existe, tu primer paso es escribirla
con el humano y esperar su OK antes de tocar `src/`. La spec fija alcance y criterios de aceptación; lo que no está
en ella no se implementa, se anota en `## Follow-ups`. Al cerrar, pega la evidencia (comando de tests y resultado).

## Comandos

```bash
pnpm install                      # Node >= 22.12, pnpm 10
pnpm db:bootstrap                 # roles vime_owner/vime_app/vime_system + base (DATABASE_URL_ADMIN)
pnpm db:migrate                   # aplica migraciones como owner
pnpm db:generate                  # drizzle-kit generate — revisa SIEMPRE el SQL generado
pnpm check                        # format:check + lint + typecheck + test: lo que corre CI, córrelo antes de cerrar
pnpm --filter @vime/api dev       # API en :4000
pnpm --filter @vime/web dev       # web en :5173 (proxy /api → :4000)
```

## Estructura y fronteras (impuestas por ESLint; violarlas no compila)

- `packages/kernel` (ids, errores, tiempo) → nada de `@vime/*`
- `packages/contracts` (DTOs Zod compartidos, permisos, enums) → kernel
- `packages/db` (pool, `withTenant`/`withUser`/`withSystem`, migraciones) → kernel
- `modules/platform` (organizaciones, miembros, invitaciones, activity, flags) → db, kernel, contracts
- `modules/<dominio>` → platform y los módulos a su izquierda. `modules/example` (notas) es el modelo a copiar.
- `apps/api`, `apps/worker` → todo (raíces de composición). `apps/web` → contracts, kernel, i18n.

Un módulo nuevo: skill `/nuevo-modulo`. Una ruta nueva: `/nueva-ruta`. Una migración: `/nueva-migracion`.

## Reglas no negociables

1. **Tenancy**: toda tabla de tenant lleva `organization_id NOT NULL`, `UNIQUE(organization_id, id)`, FKs compuestas y
   RLS. Nunca importes `pg` ni drizzle crudo fuera de `packages/db`; usa `withTenant(orgId, tx => …)`.
2. **Nada externo dentro de una transacción de tenant** (HTTP, S3, email). Encola un job.
3. **Reglas de negocio en los módulos**, nunca en web ni en rutas.
4. **Autorización por permiso** (`requirePermission('note.write')`), nunca por nombre de rol.
5. **Auditoría**: cada cambio de estado escribe `activity_events` en la misma transacción.
6. **Tiempo**: `timestamptz` UTC para instantes; `date` + zona IANA para fechas operativas. Nunca asumas Lima.
7. **Idempotencia**: toda mutación acepta `Idempotency-Key`.
8. **Errores**: `DomainError` de kernel en módulos; RFC 9457 en la API. Zod en el borde.
9. **Migraciones**: `drizzle-kit generate` + SQL revisado. Nunca `push` contra entornos compartidos.
10. **Tests**: cada módulo tiene `rls.test.ts` con dos tenants. Los tests crean sus propias organizaciones.
11. **Dependencias**: ninguna nueva sin justificarla en la spec.

## Qué no tocar sin aprobación explícita

`packages/db/src/client.ts`, `packages/db/migrations/0000-0002`, `apps/api/src/auth/`, `eslint.config.js` (fronteras),
`.github/workflows/ci.yml`. Si un feature lo necesita, la spec lo dice y el humano aprueba el plan.

## Idioma

Docs, specs y ADRs en español. Código, identificadores, tablas y comentarios en inglés. UI en es-PE (`packages/i18n`).

## Git

Ramas `feat/<spec>`, commits pequeños. `pnpm check` verde antes de abrir PR; CI bloquea el merge si falla. No subir
`.env`. Un PR por spec.
