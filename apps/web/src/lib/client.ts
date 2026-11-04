import { createApiClient } from './api';

/** Base URL of the API as the browser sees it (`/api` behind the Vite proxy). */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

/**
 * `X-App-Version` of the web app. The `web/` prefix keeps it out of the API's mobile version format
 * (`1.4.2`): the API attributes requests with a well-formed mobile version to the `mobile` audit
 * source, and web actions must stay `web` in the activity trail.
 */
export const WEB_APP_VERSION = `web/${__APP_VERSION__}`;

/** The app's API client. Contract mismatches throw in development and are logged in production. */
export const api = createApiClient({
  baseUrl: API_BASE_URL,
  appVersion: WEB_APP_VERSION,
  strict: import.meta.env.DEV,
  onContractMismatch: (error) => console.error(error),
});

/** Absolute URL of an API path (links opened in a new tab: printable day plan). */
export function apiHref(path: string, query?: Record<string, string | undefined>): string {
  return new URL(api.url(path, query), window.location.origin).toString();
}
