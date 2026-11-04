import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useToast } from '../components/ui';
import { API_BASE_URL } from './client';
import { useT } from './i18n-hook';
import { keys } from './queries';

/**
 * Signs out on the server, and only then here. The session cookie is httpOnly: only a successful
 * `POST /auth/sign-out` clears it, so on a failure (network, 5xx, 429) the person stays signed in
 * and is told so, never shown a login page over a session that still works (shared computers).
 * Better Auth answers 200 even without a valid session, so an expired session never blocks it.
 * A plain request, not the Better Auth client: that client is loaded on demand, and a tab left open
 * across a deploy could no longer load it, leaving the person unable to sign out.
 */
export async function signOutOnServer(
  signOut: () => Promise<{ error?: unknown } | null | undefined> = postSignOut,
): Promise<boolean> {
  try {
    const result = await signOut();
    return result !== null && result !== undefined && !result.error;
  } catch {
    return false;
  }
}

/** `POST /auth/sign-out` with the session cookie, as the Better Auth client sends it. */
async function postSignOut(): Promise<{ error?: unknown }> {
  const url = new URL(`${API_BASE_URL.replace(/\/+$/, '')}/auth/sign-out`, window.location.origin);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return response.ok ? {} : { error: response.status };
}

export function useSignOut() {
  const { t } = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      if (!(await signOutOnServer())) {
        toast.error(t('shell.logoutFailed'));
        return;
      }
      // Signed out first (the layout stops rendering pages), then leave, then drop org data.
      queryClient.setQueryData(keys.me, null);
      await navigate({ to: '/login' });
      queryClient.removeQueries({ queryKey: ['org'] });
    } finally {
      setPending(false);
    }
  }

  return { signOut, pending };
}
