import { createAuthClient } from 'better-auth/react';
import { API_BASE_URL } from './client';

/**
 * Better Auth client for the manager sign-in (email + password, session cookie). The API mounts
 * Better Auth under `/auth`; behind the `/api` proxy that is `<origin>/api/auth` (a base URL with a
 * path is used as-is by the client, so no extra basePath is appended).
 */
export const authClient = createAuthClient({
  baseURL: new URL(`${API_BASE_URL.replace(/\/+$/, '')}/auth`, window.location.origin).toString(),
});
