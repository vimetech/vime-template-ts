# Arquitectura

Monolito modular en TypeScript sobre PostgreSQL. Un proceso API, un proceso worker, una web SPA, una base de datos.
Multi-tenant por organización con Row Level Security: el aislamiento lo garantiza Postgres, no el código.

```
apps/web (React + Vite)  ──HTTP /v1──▶  apps/api (Fastify)  ──pg-boss──▶  apps/worker
                                             │                                │
                                             ▼                                ▼
                                  modules/<dominio> ──▶ modules/platform ──▶ packages/db ──▶ PostgreSQL (RLS)
                                             │
                                  packages/contracts (Zod, permisos)  ◀── compartido con web
                                  packages/kernel (ids, errores, tiempo)
```

## Capas, de abajo hacia arriba

| Capa                 | Qué contiene                                                                     | Puede importar                 |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `packages/kernel`    | ids, `DomainError` y subclases, utilidades de tiempo por zona                    | nada de `@vime/*`              |
| `packages/contracts` | schemas Zod de API, permisos y roles, enums, features                            | kernel                         |
| `packages/db`        | pool, roles de conexión, `withTenant`/`withUser`/`withSystem`, migraciones, jobs | kernel                         |
| `packages/i18n`      | textos es-PE / en para web                                                       | nada                           |
| `modules/platform`   | organizaciones, miembros, invitaciones, `activity_events`, flags, `tenantTable`  | db, kernel, contracts          |
| `modules/<dominio>`  | el negocio; `example` es el modelo                                               | platform y los módulos previos |
| `apps/api`           | rutas, auth (better-auth), contexto de request, idempotencia, problem+json       | todo                           |
| `apps/worker`        | handlers de jobs pg-boss                                                         | todo                           |
| `apps/web`           | SPA React, TanStack Router/Query, Tailwind                                       | contracts, kernel, i18n        |

ESLint impone la tabla (`eslint.config.js`, `LAYERS`): un import prohibido no compila. Agregar un módulo = agregar su
fila en `LAYERS`.

## Tres roles de base de datos

- `vime_owner`: dueño de tablas, corre migraciones. Nunca lo usa la app.
- `vime_app`: sin `BYPASSRLS`. Todo trabajo de tenant pasa por `withTenant(orgId, tx => …)`, que fija
  `app.current_org_id()` en la transacción; las políticas RLS filtran con eso.
- `vime_system`: `BYPASSRLS`, solo vía `withSystem()` para auth, enrutamiento de webhooks y fan-out de jobs.

`packages/db/src/testing/rls-audit.test.ts` falla si una tabla de tenant no tiene política.

## Flujo de una mutación

```
POST /v1/orgs/:orgId/notes
  → resolveMembership (¿el usuario pertenece a la org?)
  → requirePermission('note.write') (¿su rol lo permite?)
  → mutate(): abre withTenant, verifica Idempotency-Key
    → createNote(tx, actor, body)   ← módulo: valida con Zod, escribe, recordActivity()
  → 201 con NoteSchema | problem+json
```

Nada externo (HTTP, S3, email) dentro de esa transacción: se encola un job y el worker lo hace después.

## Deploy

Un `Dockerfile` produce una imagen; Railway la corre como dos servicios (`railway.api.json`, `railway.worker.json`).
El API sirve la web compilada en `/`. `release.ts` corre migraciones antes de cada deploy del API. Postgres gestionado
por Railway; S3-compatible (R2) para archivos.

## Qué no está aquí a propósito

- Sin GraphQL, sin microservicios, sin event bus externo: a esta escala son costo sin retorno.
- Sin ORM "mágico": Drizzle genera SQL que se lee y se revisa.
- Sin librería de componentes UI: `components/ui` propio sobre Tailwind.
- Mobile (Expo) existe en vime-platform; se agrega a un proyecto solo si la spec lo pide (ADR).
