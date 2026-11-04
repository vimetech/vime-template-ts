---
name: nueva-migracion
description: Genera y revisa una migración Drizzle para PostgreSQL respetando tenancy, RLS y la disciplina de packages/db/migrations. Úsalo ante cualquier cambio de schema: tabla, columna, índice o constraint.
---

# Nueva migración

Las migraciones son generadas, no escritas a mano, y siempre revisadas antes de aplicarse.

## Pasos

1. Cambia el schema en `modules/<modulo>/src/schema/*.ts` (tablas de tenant con `tenantTable`).
2. `pnpm db:generate` desde la raíz. Lee el archivo nuevo en `packages/db/migrations/NNNN_<nombre>.sql` completo.
3. Verifica en el SQL, para cada tabla de tenant nueva:
   - `organization_id uuid NOT NULL`
   - `UNIQUE("organization_id","id")`
   - `ENABLE ROW LEVEL SECURITY`
   - `CREATE POLICY "tenant_isolation" ... USING (organization_id = app.current_org_id()) WITH CHECK (...)`
   - FK a `organizations(id) ON DELETE cascade` (o compuesta hacia otra tabla de tenant)
   - índices que empiezan por `organization_id`
4. Si falta algo de la lista, el schema está mal, no el SQL: corrige el `.ts` y regenera. Nunca edites el SQL
   generado salvo para añadir statements que Drizzle no sabe expresar (triggers, `GRANT`, datos), y en ese caso
   déjalos al final con un comentario.
5. Cambios destructivos (`DROP COLUMN`, cambio de tipo con pérdida): requieren una nota en la spec y, en producción,
   dos deploys (primero dejar de leer, luego borrar).
6. `pnpm db:migrate` local. Corre `packages/db/src/testing/rls-audit.test.ts` (`pnpm --filter @vime/db test`): falla
   si una tabla de tenant quedó sin política.
7. Nunca `drizzle-kit push`. Nunca aplicar un `.sql` con `psql -f` a mano: el runner registra lo aplicado y un
   archivo aplicado por fuera se reaplica después.
8. Commit del schema y la migración juntos, con el `meta/_journal.json` actualizado.
