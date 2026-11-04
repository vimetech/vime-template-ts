import type { MeResponse } from '@vime/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { testQueryClient } from '../test/org';
import { useOrgOrNull } from './org';
import { meQuery } from './queries';

const params = vi.hoisted(() => ({ orgId: '' }));
// The /me of each test is seeded in the cache; a refetch never resolves.
vi.mock('./client', () => ({ api: { get: () => new Promise(() => {}) } }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => params,
}));

const ORG_OFF = '01928f3e-7c3a-7b2e-9a6f-0000000000a1';
const ORG_ON = '01928f3e-7c3a-7b2e-9a6f-0000000000a2';

const membership = (id: string, disabledFunctions?: string[]) => ({
  organization: {
    id,
    name: id === ORG_OFF ? 'David' : 'Acme',
    slug: id === ORG_OFF ? 'david' : 'acme',
    timezone: 'America/Lima',
    locale: 'es-PE' as const,
    ...(disabledFunctions ? { disabledFunctions } : {}),
  },
  roleKeys: ['owner' as const],
  permissions: ['note.read' as const],
});

function orgFor(orgId: string) {
  const queryClient = testQueryClient();
  const me: MeResponse = {
    user: { id: 'user_1', name: 'Javier', email: 'owner@example.com' },
    memberships: [membership(ORG_OFF, ['example_notes', 'future_thing']), membership(ORG_ON)],
  } as MeResponse;
  queryClient.setQueryData(meQuery().queryKey, me);
  params.orgId = orgId;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOrgOrNull(), { wrapper }).result.current;
}

describe('useOrgOrNull functions', () => {
  it("reads each organization's own choice from /me", () => {
    expect(orgFor(ORG_OFF)?.functionOn('example_notes')).toBe(false);
    // No list (an older cached /me) or another organization: everything on.
    expect(orgFor(ORG_ON)?.functionOn('example_notes')).toBe(true);
  });
});
