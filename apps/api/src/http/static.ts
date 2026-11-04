import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiEnv } from '../env';

/*
 * Single-origin serving (ADR 0014): besides the API, this process serves the web app (Vite build,
 * apps/web/dist) at `/`. The app calls the API on the same origin under `/api` (the prefix is
 * stripped by `stripApiPrefix`, the server's rewriteUrl), so the session cookie and CORS need
 * nothing special.
 *
 * - Files are found once at startup (`wildcard: false`): the build output is immutable in the image.
 * - Hashed assets (`/assets/*`) are cached for a year (`immutable`); everything else, index.html
 *   first, is `no-cache` (revalidated with its ETag on every load, so a deploy is picked up at once).
 * - Brotli and gzip variants (`*.br`, `*.gz`, written by the Docker build) are served when the
 *   client accepts them (Brotli first); they are never served by their own name.
 * - Deep links of the SPA (`/o/<org>/settings`) get its index.html through the not-found handler
 *   (`spaFallbackTarget`): only browser navigations (GET/HEAD accepting text/html) outside the
 *   API's own paths. Everything else keeps the API's problem+json 404.
 */

/** Public prefix of the API when it shares the origin with the web app (`/api/v1/me` → `/v1/me`). */
export const API_PATH_PREFIX = '/api';

/** Paths served by the API itself: never answered with the SPA's index.html. */
const API_PATH_ROOTS = ['/v1', '/auth', '/health', '/openapi.json', API_PATH_PREFIX] as const;

/** Directories of hashed build assets (relative to the site root). */
const WEB_IMMUTABLE_DIRS = ['assets/'] as const;

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/**
 * Fastify `rewriteUrl`: strips a leading `/api` segment so the web app can call the API on its
 * own origin (`/api/v1/me` → `/v1/me`, `/api/auth/sign-in/email` → `/auth/sign-in/email`, `/api` →
 * `/`). The same rewrite as the Vite dev proxy. Any other URL is returned unchanged, so the
 * routes keep working at the root.
 */
export function stripApiPrefix(url: string): string {
  if (!url.startsWith(API_PATH_PREFIX)) {
    return url;
  }
  const rest = url.slice(API_PATH_PREFIX.length);
  if (rest === '') return '/';
  if (rest.startsWith('/')) return rest;
  if (rest.startsWith('?')) return `/${rest}`;
  // `/apix`, `/api-docs`...: not the API prefix.
  return url;
}

/** One built single-page app served by the API. */
export interface StaticSite {
  name: 'web';
  /** URL prefix, with trailing slash. */
  prefix: string;
  /** Absolute directory of the build output (contains index.html). */
  root: string;
  /** Directories (relative to `root`, POSIX, trailing slash) of content-hashed files. */
  immutableDirs: readonly string[];
}

export interface StaticSites {
  web: StaticSite | null;
}

/** Why a configured directory is not served (logged at startup). */
export interface SkippedSite {
  name: StaticSite['name'];
  dir: string;
  reason: string;
}

function siteAt(
  name: StaticSite['name'],
  dir: string | undefined,
  prefix: string,
  immutableDirs: readonly string[],
  skipped: SkippedSite[],
): StaticSite | null {
  if (dir === undefined) {
    return null;
  }
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index) || !statSync(index).isFile()) {
    skipped.push({ name, dir: root, reason: 'no index.html (not built?)' });
    return null;
  }
  return { name, prefix, root, immutableDirs };
}

/**
 * The sites to serve from the environment (`WEB_DIST_DIR`; in production it defaults to the build
 * output next to the API bundle, see env.ts). A directory without an index.html is skipped (and
 * reported), so an API-only deployment still boots.
 */
export function staticSitesFromEnv(env: Pick<ApiEnv, 'WEB_DIST_DIR'>): {
  sites: StaticSites;
  skipped: SkippedSite[];
} {
  const skipped: SkippedSite[] = [];
  const sites: StaticSites = {
    web: siteAt('web', env.WEB_DIST_DIR, '/', WEB_IMMUTABLE_DIRS, skipped),
  };
  return { sites, skipped };
}

/** POSIX path of `file` relative to `root`, or null when it is outside. */
function relativeInside(root: string, file: string): string | null {
  const rel = relative(root, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join('/');
}

/** Cache-Control of a served file: immutable for hashed build assets, revalidate otherwise. */
export function cacheControlFor(sites: StaticSites, file: string): string {
  for (const site of [sites.web]) {
    if (!site) continue;
    const rel = relativeInside(site.root, file);
    if (rel !== null && site.immutableDirs.some((dir) => rel.startsWith(dir))) {
      return IMMUTABLE_CACHE_CONTROL;
    }
  }
  return REVALIDATE_CACHE_CONTROL;
}

/** Pathname of a request URL (no query string). */
function pathnameOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export type SpaFallbackTarget = 'web' | null;

export interface SpaFallbackRequest {
  method: string;
  /** URL after the rewrite (`request.url`). */
  url: string;
  /** URL as the client sent it (`request.originalUrl`). */
  originalUrl: string;
  accept: string | undefined;
}

/**
 * Whether the SPA answers an unmatched request with its index.html: only browser navigations
 * (GET or HEAD accepting text/html) outside the API's paths (`/v1`, `/auth`, `/health`,
 * `/openapi.json`, anything sent under `/api`) and outside the asset directory (a missing
 * `/assets/x.js` must stay a 404).
 */
export function spaFallbackTarget(request: SpaFallbackRequest): SpaFallbackTarget {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  if (!request.accept?.toLowerCase().includes('text/html')) {
    return null;
  }
  const original = pathnameOf(request.originalUrl);
  const path = pathnameOf(request.url);
  if (API_PATH_ROOTS.some((root) => isUnder(original, root) || isUnder(path, root))) {
    return null;
  }
  return isUnder(path, '/assets') ? null : 'web';
}

/**
 * Registers the site (one @fastify/static instance) and returns the SPA fallback for the
 * not-found handler: it answers the request with index.html and returns true, or returns false
 * when the request is not a navigation of the served SPA.
 */
export async function registerStaticSites(
  app: FastifyInstance,
  sites: StaticSites,
): Promise<(request: FastifyRequest, reply: FastifyReply) => boolean> {
  const served = [sites.web].filter((site): site is StaticSite => site !== null);
  const setHeaders = (reply: FastifyReply, file: string) => {
    reply.header('cache-control', cacheControlFor(sites, file));
  };
  for (const [index, site] of served.entries()) {
    await app.register(fastifyStatic, {
      root: site.root,
      prefix: site.prefix,
      wildcard: false,
      globIgnore: ['**/*.gz', '**/*.br'],
      preCompressed: true,
      cacheControl: false,
      setHeaders,
      // Only the first instance decorates the reply with sendFile (used by the fallback).
      decorateReply: index === 0,
      logLevel: 'warn',
    });
  }
  return (request, reply) => {
    const target = spaFallbackTarget({
      method: request.method,
      url: request.url,
      originalUrl: request.originalUrl,
      accept: request.headers.accept,
    });
    const site = target === 'web' ? sites.web : null;
    if (!site) {
      return false;
    }
    void reply.sendFile('index.html', site.root);
    return true;
  };
}

/**
 * Content-Security-Policy of every response (the API's JSON and the SPA). Scripts only from this
 * origin (the build has no inline scripts); inline styles allowed; images and fetches also from
 * `data:`/`blob:` (previews and uploads). A project that loads images or calls another origin
 * from the browser adds it here.
 */
export function contentSecurityPolicyDirectives(env: ApiEnv): Record<string, string[]> {
  const directives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'self'"],
    formAction: ["'self'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'data:', 'blob:'],
    mediaSrc: ["'self'", 'data:', 'blob:'],
    workerSrc: ["'self'", 'blob:'],
    manifestSrc: ["'self'"],
  };
  if (env.API_PUBLIC_URL.startsWith('https:')) {
    // Only over HTTPS: on a plain-HTTP origin (local production runs) it would break every asset.
    directives['upgradeInsecureRequests'] = [];
  }
  return directives;
}
