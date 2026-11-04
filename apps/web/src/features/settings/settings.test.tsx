import type { Organization } from '@vime/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, renderWithOrg, testQueryClient } from '../../test/org';
import { SettingsPage } from './SettingsPage';

const api = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }));
vi.mock('../../lib/client', () => ({ api, apiHref: (path: string) => path }));
vi.mock('../../lib/auth', () => ({ authClient: { changePassword: vi.fn() } }));

const organization = (disabledFunctions: string[]): Organization => ({
  id: ORG_ID,
  name: 'Acme',
  slug: 'acme',
  timezone: 'America/Lima',
  locale: 'es-PE',
  settings: {
    coordinationPhoneE164: null,
    disabledFunctions,
  },
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: null,
});

/** GET of the organization; empty lists for members and invitations. */
function mockOrganization(org: Organization) {
  api.get.mockImplementation((path: string) =>
    Promise.resolve(path === `/v1/orgs/${ORG_ID}` ? org : { items: [], nextCursor: null }),
  );
}

const notesSwitch = () =>
  screen.findByRole('checkbox', { name: /^Notas/ }) as Promise<HTMLInputElement>;

const phoneInput = () => screen.getByRole('textbox', { name: /Teléfono de coordinación/ });

const savedSettings = () =>
  (api.mutate.mock.calls[0]?.[2] as { body: { settings: Record<string, unknown> } }).body.settings;

beforeEach(() => {
  api.get.mockReset();
  api.mutate.mockReset();
});

describe('SettingsPage functions', () => {
  it('turns the notes off and sends the whole list', async () => {
    mockOrganization(organization([]));
    api.mutate.mockResolvedValue(organization(['example_notes']));
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    const notes = await notesSwitch();
    expect(notes.checked).toBe(true);
    fireEvent.click(notes);
    expect(notes.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledOnce());
    expect(api.mutate.mock.calls[0]?.[0]).toBe('PATCH');
    expect(savedSettings()).toMatchObject({ disabledFunctions: ['example_notes'] });
  });

  it('turns it back on, sending back as it was a function this build does not know', async () => {
    mockOrganization(organization(['example_notes', 'future_thing']));
    api.mutate.mockResolvedValue(organization(['future_thing']));
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    const notes = await notesSwitch();
    expect(notes.checked).toBe(false);
    fireEvent.click(notes);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledOnce());
    expect(savedSettings()).toMatchObject({ disabledFunctions: ['future_thing'] });
  });

  it('leaves the list out when only another setting changed (a newer function stays off)', async () => {
    mockOrganization(organization(['example_notes', 'future_thing']));
    api.mutate.mockResolvedValue(organization(['example_notes', 'future_thing']));
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    await notesSwitch();
    fireEvent.change(phoneInput(), { target: { value: '+51987654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledOnce());
    expect(savedSettings()).toMatchObject({ coordinationPhoneE164: '+51987654321' });
    expect(savedSettings()).not.toHaveProperty('disabledFunctions');
  });

  it('sends only what changed, so a setting saved elsewhere meanwhile is never reverted', async () => {
    mockOrganization(organization([]));
    api.mutate.mockResolvedValue(organization([]));
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    await notesSwitch();
    fireEvent.change(screen.getByRole('textbox', { name: /^Nombre/ }), {
      target: { value: 'Acme S.A.C.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledOnce());
    expect((api.mutate.mock.calls[0]?.[2] as { body: unknown }).body).toEqual({
      name: 'Acme S.A.C.',
    });
  });

  it('a change that is the same once normalized sends nothing and ends saved', async () => {
    const stored = organization([]);
    const withPhone = {
      ...stored,
      settings: { ...stored.settings, coordinationPhoneE164: '+51987654321' },
    };
    mockOrganization(withPhone);
    api.mutate.mockResolvedValue(withPhone);
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    const phone = await screen.findByRole('textbox', { name: /Teléfono de coordinación/ });
    fireEvent.change(phone, { target: { value: '+51 987 654 321' } });
    expect(screen.getByText('Tienes cambios sin guardar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledOnce());
    expect((api.mutate.mock.calls[0]?.[2] as { body: unknown }).body).toEqual({});
    await waitFor(() => expect(screen.getByText('Todo está guardado')).toBeTruthy());
    expect(phone).toHaveProperty('value', '+51987654321');
  });

  it('asks for the organization again on opening instead of editing a cached copy', async () => {
    // Cached a few minutes ago (fresh for its 5-minute staleTime); another admin then set the
    // coordination phone.
    const queryClient = testQueryClient();
    queryClient.setQueryData(['org', ORG_ID, 'organization'], organization([]));
    const newer = organization([]);
    mockOrganization({
      ...newer,
      settings: { ...newer.settings, coordinationPhoneE164: '+51987654321' },
      updatedAt: '2026-10-27T12:00:00.000Z',
    });
    renderWithOrg(<SettingsPage />, { permissions: ['org.manage'], queryClient });
    await waitFor(() => expect(phoneInput()).toHaveProperty('value', '+51987654321'));
    expect(api.get).toHaveBeenCalledWith(`/v1/orgs/${ORG_ID}`, expect.anything(), {
      signal: expect.anything(),
    });
  });

  it('refreshes /me after saving (the navigation reads the functions from it)', async () => {
    mockOrganization(organization([]));
    api.mutate.mockResolvedValue(organization(['example_notes']));
    const { queryClient } = renderWithOrg(<SettingsPage />, { permissions: ['org.manage'] });
    queryClient.setQueryData(['me'], { user: { id: 'u', name: 'U' }, memberships: [] });
    fireEvent.click(await notesSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(queryClient.getQueryState(['me'])?.isInvalidated).toBe(true));
  });

  it('shows the switches read-only to someone who cannot manage the organization', async () => {
    mockOrganization(organization(['example_notes']));
    renderWithOrg(<SettingsPage />, { permissions: ['member.manage'] });
    const notes = await notesSwitch();
    expect(notes.checked).toBe(false);
    // Disabled through its fieldset, like the other settings.
    expect(notes.closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar cambios' })).toBeNull();
  });
});
