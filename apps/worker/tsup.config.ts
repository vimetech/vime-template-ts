import { defineConfig } from 'tsup';

/**
 * Production bundle (`pnpm build` → `node dist/main.js`). Workspace packages export raw
 * TypeScript with extensionless imports, which Node cannot load: bundle them. Their npm
 * dependencies stay external, so each one must also be a dependency of this package (pg, pg-boss,
 * drizzle-orm, uuid, date-fns...): Node resolves them from apps/worker.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@vime\//],
});
