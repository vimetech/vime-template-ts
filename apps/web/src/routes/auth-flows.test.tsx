import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ApiProblem } from '../lib/api';
import { useIntentKey } from '../lib/use-intent-key';
import { signOutOnServer } from '../lib/use-sign-out';
import { redeemErrorOf } from './LoginPage';

const problem = (status: number, code: string, paths: string[] = []) =>
  new ApiProblem({
    status,
    code,
    title: code,
    errors: paths.map((path) => ({ path, message: 'x' })),
  });

describe('sign-out fails closed', () => {
  it('counts as signed out only when the server confirms it', async () => {
    expect(await signOutOnServer(async () => ({ data: { success: true }, error: null }))).toBe(
      true,
    );
    // Better Auth resolves HTTP errors (502, 429) with { error } instead of throwing.
    expect(await signOutOnServer(async () => ({ data: null, error: { status: 502 } }))).toBe(false);
    expect(
      await signOutOnServer(async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBe(false);
  });
});

describe('invitation redeem errors', () => {
  it('tells the person what to fix', () => {
    expect(redeemErrorOf(problem(400, 'validation_failed', ['code']))).toBe('code');
    expect(redeemErrorOf(problem(400, 'validation_failed', ['email']))).toBe('email');
    expect(redeemErrorOf(problem(401, 'unauthenticated'))).toBe('password');
    expect(redeemErrorOf(problem(409, 'conflict'))).toBe('conflict');
    expect(redeemErrorOf(problem(429, 'rate_limited'))).toBe('rate_limited');
    expect(redeemErrorOf(problem(0, 'network'))).toBe('network');
    expect(redeemErrorOf(new Error('boom'))).toBe('unknown');
  });
});

describe('ConfirmDialog', () => {
  it('runs its action as a mutation, so the app-wide handler sees a 401', async () => {
    const onError = vi.fn();
    const queryClient = new QueryClient({ mutationCache: new MutationCache({ onError }) });
    const expired = problem(401, 'unauthenticated');
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ConfirmDialog
          open
          onClose={onClose}
          title="Revocar invitación"
          confirmLabel="Revocar"
          onConfirm={() => Promise.reject(expired)}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revocar' }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toBe(expired);
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('useIntentKey', () => {
  it('keeps one key per body until it changes or succeeds', () => {
    let n = 0;
    const { result } = renderHook(() => useIntentKey(() => `k${++n}`));
    const first = result.current.keyFor({ noteId: 'n', title: 'a' });
    expect(result.current.keyFor({ noteId: 'n', title: 'a' })).toBe(first);
    const changed = result.current.keyFor({ noteId: 'n', title: 'b' });
    expect(changed).not.toBe(first);
    result.current.reset();
    expect(result.current.keyFor({ noteId: 'n', title: 'b' })).not.toBe(changed);
  });
});
