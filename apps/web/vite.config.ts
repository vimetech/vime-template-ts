import { Agent } from 'node:http';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import pkg from './package.json' with { type: 'json' };

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

/**
 * Dev/preview proxy: `/api/*` → the API without the `/api` prefix (`/api/v1/me` → `/v1/me`,
 * `/api/auth/sign-in/email` → `/auth/sign-in/email`). Same origin for the browser, so the Better
 * Auth session cookie works without CORS. `changeOrigin: false` keeps the browser's Host/Origin,
 * which the API checks against WEB_ORIGIN for cookie-authenticated mutations. One connection per
 * request (no keep-alive pool): with the pooled agent, a request the browser aborts (React's
 * StrictMode does it to the first fetch of every page in development) could leave an identical
 * request in flight without an answer, and the page stuck on its skeleton.
 */
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: apiTarget,
    changeOrigin: false,
    agent: new Agent({ keepAlive: false }),
    rewrite: (path) => path.replace(/^\/api(?=\/|$)/, '') || '/',
  },
};

/**
 * `<link rel="preload" as="fetch">` of `GET /v1/me` in index.html: the browser asks for the session
 * while it downloads the JS, instead of after the JS has run. The app's own request (`meQuery`:
 * same URL, `credentials: 'include'`, which is what `crossorigin="use-credentials"` matches) takes
 * the preloaded response. Same base URL as `src/lib/client.ts`; on another origin the preload just
 * goes unused. The CSP's `connect-src 'self'` covers it.
 */
function preloadMe(): Plugin {
  let href = '/api/v1/me';
  return {
    name: 'vime:preload-me',
    configResolved(config) {
      const base = (config.env['VITE_API_BASE_URL'] as string | undefined) ?? '/api';
      href = `${base.replace(/\/+$/, '')}/v1/me`;
    },
    transformIndexHtml: () => [
      {
        tag: 'link',
        attrs: { rel: 'preload', href, as: 'fetch', crossorigin: 'use-credentials' },
        injectTo: 'head',
      },
    ],
  };
}

/** Build warning when a vendor chunk imports an app chunk (its name would change every deploy). */
function checkVendorChunks(): Plugin {
  return {
    name: 'vime:check-vendor-chunks',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.name.startsWith('vendor-')) continue;
        const app = chunk.imports.filter((file) => !/(^|\/)(vendor-|rolldown-runtime)/.test(file));
        if (app.length > 0) this.warn(`${chunk.fileName} imports app chunks: ${app.join(', ')}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadMe(), checkVendorChunks()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rolldownOptions: {
      output: {
        /*
         * Libraries in chunks of their own (all of them load at startup): a deploy that only
         * changes the app keeps their file names, so browsers reuse the cached copies and download
         * just the app's chunks again. `app-core` (contracts, kernel, API client; only what the
         * first page already loads) is grouped too, so that the bundler's runtime helpers
         * (CommonJS interop, which React needs) stay in a chunk of their own instead of landing in
         * an app chunk that React's would then import. `checkVendorChunks` warns if that changes.
         */
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-lib',
              test: /node_modules[\\/](@tanstack|i18next|react-i18next|use-sync-external-store)[\\/]/,
              priority: 20,
            },
            { name: 'vendor-zod', test: /node_modules[\\/]zod[\\/]/, priority: 20 },
            {
              name: 'app-core',
              test: /packages[\\/](contracts|kernel)[\\/]|apps[\\/]web[\\/]src[\\/]lib[\\/](api|client)\.ts$/,
              tags: ['$initial'],
              priority: 10,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
});
