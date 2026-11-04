# <PROJECT_NAME>

Proyecto de VIME TECH LABS sobre el Stack VIME v1 (TypeScript · Fastify · Drizzle · PostgreSQL con RLS · React/Vite ·
Railway). Nacido de [`vimetech/vime-template-ts`](https://github.com/vimetech/vime-template-ts).

## Primer arranque

```bash
node scripts/init-project.mjs --name "<PROJECT_NAME>"   # solo la primera vez, luego se borra solo
cp .env.example .env
pnpm install
docker compose up -d          # Postgres 16 + MinIO locales
pnpm db:bootstrap && pnpm db:migrate
pnpm check                    # format, lint, typecheck, tests
pnpm dev                      # API :4000, web :5173
```

## Cómo se trabaja aquí

1. Todo feature empieza en `specs/<feature>.md` (plantilla en `specs/_TEMPLATE.md`). Sin spec no hay código.
2. Rama `feat/<slug>`, PR a `main`. CI bloquea el merge si `pnpm check` falla.
3. Antes del merge, el subagente `reviewer` revisa el diff contra la spec y `docs/CONVENTIONS.md`.
4. Decisiones de arquitectura en `docs/adr/`.

Guía completa para el agente y para humanos: [`CLAUDE.md`](CLAUDE.md). Arquitectura:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Convenciones: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## Estructura

```
apps/api        Fastify, auth, rutas /v1
apps/worker     jobs pg-boss
apps/web        React + Vite + Tailwind
modules/        dominio: platform (orgs, miembros, auditoría) + example (modelo a copiar)
packages/       kernel, contracts (Zod + permisos), db (RLS, migraciones), i18n, config
specs/          una spec por feature
docs/           arquitectura, convenciones, ADRs
.claude/        agentes (reviewer), skills (nuevo-modulo, nueva-ruta, nueva-migracion), settings
```
