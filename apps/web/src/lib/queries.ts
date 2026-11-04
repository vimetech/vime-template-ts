import { MeResponseSchema, OrganizationSchema, type MeResponse } from '@vime/contracts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiProblem } from './api';
import { api } from './client';

/** `{ items: [...] }` list response of the API. */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/**
 * Query keys. Everything of an organization lives under `['org', orgId]`, so signing out drops it
 * all at once; a feature adds its keys here (see `notes`).
 */
export const keys = {
  me: ['me'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  organization: (orgId: string) => ['org', orgId, 'organization'] as const,
  members: (orgId: string) => ['org', orgId, 'members'] as const,
  invitations: (orgId: string) => ['org', orgId, 'invitations'] as const,
  activity: (orgId: string) => ['org', orgId, 'activity'] as const,
  notes: (orgId: string) => ['org', orgId, 'notes'] as const,
};

/** `/v1/orgs/:orgId` + `path`. */
export function orgPath(orgId: string, path = ''): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}${path}`;
}

/** The signed-in user and memberships; `null` when there is no session (401). */
export function meQuery() {
  return queryOptions({
    queryKey: keys.me,
    queryFn: async ({ signal }): Promise<MeResponse | null> => {
      try {
        return await api.get('/v1/me', MeResponseSchema, { signal });
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function organizationQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.organization(orgId),
    queryFn: ({ signal }) => api.get(orgPath(orgId), OrganizationSchema, { signal }),
    staleTime: 5 * 60_000,
  });
}

/** Retry GETs on network/5xx errors only: a 4xx will not change by retrying. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiProblem && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function invalidateOrg(queryClient: QueryClient, orgId: string, ...groups: string[]) {
  return Promise.all(
    groups.map((group) => queryClient.invalidateQueries({ queryKey: ['org', orgId, group] })),
  );
}
