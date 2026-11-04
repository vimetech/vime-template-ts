import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { closeDb } from '@vime/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createUser, testEnv } from '../testing/helpers';
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  cacheControlFor,
  contentSecurityPolicyDirectives,
  spaFallbackTarget,
  staticSitesFromEnv,
  stripApiPrefix,
} from './static';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const WEB_INDEX = '<!doctype html><title>VIME App</title><div id="root">web-index</div>';
const WEB_SCRIPT = `console.log(${JSON.stringify('x'.repeat(4000))});`;

function write(root: string, path: string, content: string | Buffer): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A fake web build output in a temporary directory. */
function fakeBuilds(): { dir: string; web: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vime-static-'));
  const web = join(dir, 'web');
  write(web, 'index.html', WEB_INDEX);
  write(web, 'assets/index-AbC123xy.js', WEB_SCRIPT);
  write(web, 'assets/index-AbC123xy.js.gz', gzipSync(WEB_SCRIPT));
  // Both variants, as the Docker build writes them.
  write(web, 'assets/vendor-Ghi789ww.js', WEB_SCRIPT);
  write(web, 'assets/vendor-Ghi789ww.js.gz', gzipSync(WEB_SCRIPT));
  write(web, 'assets/vendor-Ghi789ww.js.br', brotliCompressSync(WEB_SCRIPT));
  write(web, 'assets/index-Def456zz.css', 'body{margin:0}');
  write(web, 'favicon.ico', Buffer.from([0, 0, 1, 0]));
  return { dir, web };
}

describe('stripApiPrefix', () => {
  it.each([
    ['/api/v1/me', '/v1/me'],
    ['/api/auth/sign-in/email', '/auth/sign-in/email'],
    ['/api/health/ready?x=1', '/health/ready?x=1'],
    ['/api', '/'],
    ['/api?x=1', '/?x=1'],
    ['/v1/me', '/v1/me'],
    ['/apix', '/apix'],
    ['/api-docs', '/api-docs'],
    ['/', '/'],
  ])('%s → %s', (url, expected) => {
    expect(stripApiPrefix(url)).toBe(expected);
  });
});

describe('spaFallbackTarget', () => {
  const nav = (url: string, originalUrl = url) => ({
    method: 'GET',
    url,
    originalUrl,
    accept: HTML,
  });

  it('sends browser navigations of the web app to its index.html', () => {
    expect(spaFallbackTarget(nav('/o/abc/settings'))).toBe('web');
    expect(spaFallbackTarget(nav('/login?next=%2F'))).toBe('web');
    expect(spaFallbackTarget({ ...nav('/o/abc'), method: 'HEAD' })).toBe('web');
  });

  it('never answers API paths, assets, other methods or non-HTML requests with a page', () => {
    for (const url of [
      '/v1/orgs/x/notes',
      '/v1',
      '/auth/get-session',
      '/health/ready',
      '/openapi.json',
      '/assets/missing-abc.js',
    ]) {
      expect(spaFallbackTarget(nav(url)), url).toBeNull();
    }
    // Anything sent under /api is the API, whatever the rewrite left.
    expect(spaFallbackTarget(nav('/o/abc', '/api/o/abc'))).toBeNull();
    expect(spaFallbackTarget(nav('/', '/api'))).toBeNull();
    expect(spaFallbackTarget({ ...nav('/o/abc'), method: 'POST' })).toBeNull();
    expect(spaFallbackTarget({ ...nav('/o/abc'), accept: 'application/json' })).toBeNull();
    expect(spaFallbackTarget({ ...nav('/o/abc'), accept: '*/*' })).toBeNull();
    expect(spaFallbackTarget({ ...nav('/o/abc'), accept: undefined })).toBeNull();
    // Prefix matching is by path segment.
    expect(spaFallbackTarget(nav('/v1beta'))).toBe('web');
    expect(spaFallbackTarget(nav('/healthy'))).toBe('web');
  });
});

describe('cacheControlFor', () => {
  it('caches hashed build assets for a year and revalidates everything else', () => {
    const { dir, web } = fakeBuilds();
    try {
      const { sites } = staticSitesFromEnv({ WEB_DIST_DIR: web });
      expect(cacheControlFor(sites, join(web, 'assets/index-AbC123xy.js'))).toBe(
        IMMUTABLE_CACHE_CONTROL,
      );
      for (const file of [
        join(web, 'index.html'),
        join(web, 'favicon.ico'),
        join(dir, 'assets/elsewhere.js'),
      ]) {
        expect(cacheControlFor(sites, file), file).toBe(REVALIDATE_CACHE_CONTROL);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a configured directory without index.html, and serves nothing when unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vime-static-'));
    try {
      const result = staticSitesFromEnv({ WEB_DIST_DIR: dir });
      expect(result.sites).toEqual({ web: null });
      expect(result.skipped).toEqual([expect.objectContaining({ name: 'web', dir })]);
      expect(staticSitesFromEnv({ WEB_DIST_DIR: undefined })).toEqual({
        sites: { web: null },
        skipped: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Content-Security-Policy', () => {
  it('keeps scripts and fetches on this origin', () => {
    const directives = contentSecurityPolicyDirectives(testEnv());
    expect(directives['scriptSrc']).toEqual(["'self'"]);
    expect(directives['defaultSrc']).toEqual(["'self'"]);
    expect(directives['connectSrc']).not.toContain('https:');
  });

  it('upgrades insecure requests only on an HTTPS origin', () => {
    expect(contentSecurityPolicyDirectives(testEnv())['upgradeInsecureRequests']).toBeUndefined();
    expect(
      contentSecurityPolicyDirectives(testEnv({ API_PUBLIC_URL: 'https://app.example.com' }))[
        'upgradeInsecureRequests'
      ],
    ).toEqual([]);
  });
});

describe('single-origin serving', () => {
  let builds: ReturnType<typeof fakeBuilds>;
  let app: FastifyInstance;

  beforeAll(async () => {
    builds = fakeBuilds();
    app = await buildTestApp({ env: testEnv({ WEB_DIST_DIR: builds.web }) });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    rmSync(builds.dir, { recursive: true, force: true });
  });

  it('serves the web app at / with a revalidated index and the security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toBe(WEB_INDEX);
    expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
    expect(response.headers['etag']).toEqual(expect.any(String));
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    const revalidated = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'if-none-match': String(response.headers['etag']) },
    });
    expect(revalidated.statusCode).toBe(304);
  });

  it('serves hashed assets as immutable, gzipped when the client accepts it', async () => {
    const plain = await app.inject({ method: 'GET', url: '/assets/index-AbC123xy.js' });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toMatch(/javascript/);
    expect(plain.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(plain.body).toBe(WEB_SCRIPT);

    const gzipped = await app.inject({
      method: 'GET',
      url: '/assets/index-AbC123xy.js',
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(gzipped.statusCode).toBe(200);
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gzipped.headers['content-type']).toMatch(/javascript/);
    expect(gzipped.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(String(gzipped.headers['vary'])).toMatch(/accept-encoding/i);
    expect(gunzipSync(gzipped.rawPayload).toString()).toBe(WEB_SCRIPT);

    // The .gz variants are not routes of their own.
    const variant = await app.inject({ method: 'GET', url: '/assets/index-AbC123xy.js.gz' });
    expect(variant.statusCode).toBe(404);
  });

  it('prefers the Brotli variant when there is one and the client accepts it', async () => {
    const asset = '/assets/vendor-Ghi789ww.js';
    const brotli = await app.inject({
      method: 'GET',
      url: asset,
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    expect(brotli.statusCode).toBe(200);
    expect(brotli.headers['content-encoding']).toBe('br');
    expect(brotli.headers['content-type']).toMatch(/javascript/);
    expect(brotli.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(String(brotli.headers['vary'])).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(WEB_SCRIPT);

    // Without br: the gzip variant; without any encoding: the file itself.
    const gzipped = await app.inject({
      method: 'GET',
      url: asset,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzipped.rawPayload).toString()).toBe(WEB_SCRIPT);
    const plain = await app.inject({ method: 'GET', url: asset });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(WEB_SCRIPT);

    // The .br variants are not routes of their own either.
    for (const headers of [{}, { 'accept-encoding': 'br' }]) {
      const variant = await app.inject({ method: 'GET', url: `${asset}.br`, headers });
      expect(variant.statusCode).toBe(404);
    }
  });

  it('answers deep links of the web app with its index.html, and only browser navigations', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({
        method,
        url: '/o/abc/settings?tab=members',
        headers: { accept: HTML },
      });
      expect(response.statusCode, method).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
      expect(response.body).toBe(method === 'GET' ? WEB_INDEX : '');
    }

    const api = await app.inject({ method: 'GET', url: '/o/abc/settings' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/^application\/problem\+json/);

    const post = await app.inject({ method: 'POST', url: '/o/abc', headers: { accept: HTML } });
    expect(post.statusCode).toBe(404);
    expect(post.headers['content-type']).toMatch(/^application\/problem\+json/);

    for (const url of ['/v1/nope', '/api/nope', '/api/v1/nope', '/assets/missing-1.js']) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: HTML } });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['content-type'], url).toMatch(/^application\/problem\+json/);
    }
  });

  it('answers the API under /api exactly as at the root', async () => {
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);

    const user = await createUser(app, 'Same Origin');
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: user.email, password: user.password },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = [signIn.headers['set-cookie']]
      .flat()
      .map((value) => String(value).split(';')[0])
      .join('; ');
    for (const url of ['/api/v1/me', '/v1/me']) {
      const me = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(me.statusCode, url).toBe(200);
      expect(me.json<{ user: { id: string } }>().user.id).toBe(user.id);
    }
    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
  });

  it('keeps the static routes out of the OpenAPI document', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    const paths = Object.keys(response.json<{ paths: Record<string, unknown> }>().paths);
    expect(paths).toContain('/v1/me');
    expect(paths.filter((path) => path === '/' || path.startsWith('/assets'))).toEqual([]);
  });

  it('exposes the ETag to cross-origin clients and accepts If-None-Match', async () => {
    const web = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(String(web.headers['access-control-expose-headers'])).toMatch(/etag/);
    expect(String(web.headers['access-control-expose-headers'])).toMatch(/content-disposition/);

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('if-none-match');
  });
});

describe('without builds', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('serves no page: every unknown URL is a problem+json 404', async () => {
    for (const url of ['/', '/o/abc']) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: HTML } });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['content-type'], url).toMatch(/^application\/problem\+json/);
    }
  });
});
