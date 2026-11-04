import { defineConfig } from 'tsup';

/**
 * Production bundles (`pnpm build`): `node dist/server.js` (the API) and `node dist/release.js`
 * (the release steps of a deploy: bootstrap, migrations, bucket CORS, first organization; see
 * src/scripts/release.ts). Workspace packages export raw TypeScript with extensionless imports,
 * which Node cannot load: bundle them. Their npm dependencies stay external, so each one must also
 * be a dependency of this package (pg, uuid, date-fns...): Node resolves them from apps/api, and pg
 * stays the same instance drizzle-orm uses. One self-contained file per entry (no shared chunks):
 * both resolve paths relative to their own location (web builds, migrations).
 */
export default defineConfig({
  entry: { server: 'src/server.ts', release: 'src/scripts/release.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@vime\//],
});
