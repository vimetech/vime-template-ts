# Convenciones de código

Cada regla tiene un ejemplo tomado del repo. Si una regla no tiene ejemplo real, no es regla todavía.
Cambiar una convención requiere un ADR en `docs/adr/`.

## 1. Un módulo de dominio = una carpeta en `modules/`

`modules/example` es el modelo. Un módulo tiene `src/schema/` (solo tablas Drizzle), un archivo de servicio por
agregado (`notes.ts`), `index.ts` que exporta solo lo público, y `rls.test.ts`. Nada de HTTP dentro de un módulo:
los servicios reciben un `Tx` y un `ActorContext`, nunca un `request`.

```ts
// modules/example/src/notes.ts
export async function createNote(tx: Tx, ctx: ActorContext, input: unknown): Promise<Note>;
```

## 2. Tablas de tenant con `tenantTable()`

Nunca `pgTable` directo para datos de una organización. `tenantTable` añade `id`, `organization_id`, timestamps,
`UNIQUE(organization_id, id)` y la política RLS.

```ts
// modules/example/src/schema/notes.ts
export const notes = tenantTable('notes', { title: text('title').notNull() }, (t) => [
  index('notes_organization_id_created_at_idx').on(t.organizationId, t.createdAt),
]);
```

Columnas en `snake_case` explícito; índice siempre con `organization_id` primero.

## 3. Contratos en `packages/contracts`, no en el módulo

Los schemas Zod de entrada y salida (`CreateNoteSchema`, `NoteSchema`) viven en `packages/contracts/src/<modulo>.ts`
y los comparten API y web. El módulo los importa; nunca los define. Los permisos del módulo se declaran en
`permissions.ts` (`note.read`, `note.write`) y se asignan por rol ahí mismo.

## 4. Rutas en `apps/api/src/routes/<modulo>.ts`

Una ruta: `schema` completo (params, body, headers, response con `problemResponses`), `preHandler` con permiso, y el
handler llama a un servicio del módulo dentro de `request.tenant(tx => …)`. Mutaciones con `mutate` (Idempotency-Key).

```ts
app.post('/notes', { schema: {...}, preHandler: write }, async (request, reply) =>
  mutate(request, reply, 201, (tx) => createNote(tx, request.actor, request.body)),
);
```

Prefijo `/v1/orgs/:orgId/`. Un módulo con feature flag usa un guard como `exampleGuard`.

## 5. Errores

En módulos: `NotFoundError`, `ValidationError`, `ConflictError` de `@vime/kernel`. Nunca `throw new Error('...')` en
código de dominio. La API los traduce a problem+json (RFC 9457) en `apps/api/src/http/problem.ts`; no captures y
reformatees en la ruta.

## 6. Auditoría

Todo cambio de estado llama `recordActivity(tx, ctx, { kind: 'note.created', ... })` en la misma transacción.
El `kind` es `<entidad>.<verbo_pasado>` en inglés.

## 7. Tiempo

Instantes: `timestamptz`, siempre UTC, expuestos como ISO con `iso()` / `isoOrNull()` de platform. Fechas operativas
(una fecha de servicio, un vencimiento): `date` + zona IANA de la organización. Nunca `new Date()` sin pasar por el
reloj de kernel en código testeable.

## 8. Tests

- Unit: junto al archivo, `x.test.ts`, Vitest.
- Integración de módulo: `rls.test.ts` con dos tenants (`seedTenant()` × 2) y el patrón `sqlState()` para verificar
  que la política bloquea, no solo que el filtro filtra.
- API: `apps/api/src/routes/<modulo>.test.ts` con `isolation.test.ts` como referencia.
- Un test crea sus propias organizaciones con slug único; nunca trunca.

## 9. Nombres

- Archivos: `kebab-case.ts`; componentes React `PascalCase.tsx`.
- Tablas y columnas: `snake_case`, plural para tablas (`notes`).
- Permisos: `<entidad>.<accion>` (`note.write`).
- Ramas: `feat/<slug-de-la-spec>`, `fix/<slug>`.

## 10. Tamaño

Un archivo de más de 400 líneas es hallazgo de review. Un servicio que crece se parte por agregado, no por "utils".
Un helper que se repite en dos módulos sube a `modules/platform` o a `kernel`; no se copia una tercera vez.

## 11. Web

`apps/web/src/features/<feature>/` por feature; componentes compartidos en `components/ui`. Estilos Tailwind; para
superficies usa `bg-surface`, nunca `bg-white` (tema oscuro por remapeo). Textos por `packages/i18n`, nunca
hardcodeados. Solo importa `@vime/contracts`, `@vime/kernel`, `@vime/i18n`.

## 12. Logs

`pino` por el logger del request o del worker. Nunca `console.*` fuera de scripts.
