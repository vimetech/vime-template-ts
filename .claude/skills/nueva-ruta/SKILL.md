---
name: nueva-ruta
description: Agrega un endpoint a apps/api siguiendo el patrón de routes/notes.ts (schema Zod completo, permiso, idempotencia, problem+json, test). Úsalo cuando la spec pide exponer o cambiar una operación HTTP sobre un módulo que ya existe.
---

# Nueva ruta en la API

## Checklist por ruta

1. **Contrato primero**: el body, query y response existen en `packages/contracts`. Si no, agrégalos ahí (nunca
   inline en la ruta).
2. **Schema completo** en el registro: `tags`, `summary`, `security: AUTHENTICATED`, `params` (`OrgParamsSchema` o
   extendido con `UuidSchema`), `headers` (`V1HeadersSchema` para lecturas, `MutationHeadersSchema` para escrituras),
   `body`/`querystring`, `response: { 200|201: X, ...problemResponses }`. Swagger se genera de esto.
3. **Permiso**: `preHandler: requirePermission('<entidad>.<accion>')`, envuelto en el guard de feature si el módulo
   lo tiene. Nunca comprobar rol por nombre.
4. **Handler**: lectura → `request.tenant((tx) => servicio(tx, request.auth.orgId, ...))`.
   Escritura → `mutate(request, reply, 201, (tx) => servicio(tx, request.actor, request.body))`, que abre la
   transacción y maneja `Idempotency-Key`.
5. **Sin lógica de negocio en la ruta**: si necesitas un `if` de dominio, va al servicio del módulo.
6. **Nada externo** dentro del handler que corra en transacción: encola un job con `enqueue` de `@vime/db/jobs`.
7. **Test** en `apps/api/src/routes/<modulo>.test.ts`: caso feliz, 403 sin permiso, 404 cruzando tenant, 409 o 422
   según el contrato. Usa `apps/api/src/routes/isolation.test.ts` como referencia de setup.
8. **Lista de rutas** en la spec: método, path, permiso.

`pnpm --filter @vime/api typecheck && pnpm --filter @vime/api test` antes de dar la ruta por lista.
