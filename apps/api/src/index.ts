/**
 * @vime/api: the HTTP composition root. `buildApp` is used by server.ts and by tests.
 */
export { buildApp } from './app';
export type { BuildAppOptions } from './app';
export { loadEnv } from './env';
export type { ApiEnv } from './env';
