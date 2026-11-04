# One image for the API and the worker (Railway runs it as two services: railway.api.json and
# railway.worker.json; see docs/ARCHITECTURE.md).
#
# - API (default command): `node apps/api/dist/server.js`. It also serves the web app at `/`,
#   which calls the API under `/api`.
# - Release (pre-deploy): `node apps/api/dist/release.js` (bootstrap, migrations, bucket CORS,
#   first organization).
# - Worker: `node apps/worker/dist/main.js`.
#
# No BuildKit cache mounts: Railway's builder requires service-specific cache ids.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------------------------
# base: Node 22 + pnpm 10 (corepack, pinned like package.json's packageManager)
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------------------------
# build: every dependency, then the bundles and the web app
# ---------------------------------------------------------------------------------------------
FROM base AS build
# Packages are fetched from the lockfile alone, so this layer survives source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

# API (server.js + release.js) and worker bundles (tsup), and the web app (Vite; same-origin API).
RUN NODE_ENV=production VITE_API_BASE_URL=/api \
    pnpm --filter @vime/api --filter @vime/worker --filter @vime/web run build

# Gzip and Brotli variants of the text assets (served by @fastify/static's preCompressed when
# accepted, Brotli first: ~14% smaller). The slim image has no brotli CLI: Node's zlib writes them
# (quality 11, the default).
RUN find apps/web/dist -type f -size +1k \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \
         -o -name '*.ttf' -o -name '*.ico' -o -name '*.webmanifest' \) \
      -exec gzip -9 -k -n {} + \
      -exec node -e 'const fs = require("node:fs"), zlib = require("node:zlib"); for (const file of process.argv.slice(1)) fs.writeFileSync(file + ".br", zlib.brotliCompressSync(fs.readFileSync(file)));' {} +

# Workspace manifests only, for the production install below.
RUN mkdir /manifests \
    && cp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc /manifests/ \
    && find apps packages modules -name package.json -not -path '*/node_modules/*' \
       -exec cp --parents {} /manifests/ \;

# ---------------------------------------------------------------------------------------------
# prod-deps: production node_modules of the API and the worker (the bundles inline @vime/*;
# their npm dependencies stay external). Same layout as the repository.
# ---------------------------------------------------------------------------------------------
FROM base AS prod-deps
COPY --from=build /manifests/ ./
RUN pnpm install --frozen-lockfile --prod --filter "@vime/api..." --filter "@vime/worker..."

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
