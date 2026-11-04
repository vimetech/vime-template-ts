import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui';
import {
  ChangePasswordForm,
  passwordChangeErrorOf,
  validatePasswordChange,
} from './ChangePasswordForm';

const GOOD = 'una frase larga y segura';

describe('change password validation', () => {
  it('requires the current password, 12+ characters and a matching confirmation', () => {
    expect(
      validatePasswordChange({ currentPassword: '', newPassword: 'corta', confirmPassword: 'x' }),
    ).toEqual({
      currentPassword: 'currentRequired',
      newPassword: 'tooShort',
      confirmPassword: 'mismatch',
    });
    expect(
      validatePasswordChange({
        currentPassword: 'actual-1234',
        newPassword: GOOD,
        confirmPassword: GOOD,
      }),
    ).toEqual({});
    // Exactly 12 characters is enough; characters are counted as people see them.
    expect(
      validatePasswordChange({
        currentPassword: 'a',
        newPassword: 'abcdefghijkl',
        confirmPassword: 'abcdefghijkl',
      }),
    ).toEqual({});
    expect(
      validatePasswordChange({
        currentPassword: 'a',
        newPassword: '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑',
        confirmPassword: '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑',
      }).newPassword,
    ).toBe('tooShort');
    expect(
      validatePasswordChange({
        currentPassword: 'a',
        newPassword: 'x'.repeat(129),
        confirmPassword: 'x'.repeat(129),
      }).newPassword,
    ).toBe('tooLong');
    expect(
      validatePasswordChange({ currentPassword: GOOD, newPassword: GOOD, confirmPassword: GOOD })
        .newPassword,
    ).toBe('sameAsCurrent');
  });

  it('maps the Better Auth errors the API relays', () => {
    expect(passwordChangeErrorOf({ status: 400, authCode: 'INVALID_PASSWORD' })).toBe(
      'currentWrong',
    );
    expect(passwordChangeErrorOf({ status: 400, authCode: 'PASSWORD_TOO_SHORT' })).toBe('tooShort');
    expect(passwordChangeErrorOf({ status: 400, authCode: 'CREDENTIAL_ACCOUNT_NOT_FOUND' })).toBe(
      'noPassword',
    );
    expect(passwordChangeErrorOf({ status: 401 })).toBe('sessionExpired');
    expect(passwordChangeErrorOf({ status: 429 })).toBe('rate_limited');
    expect(passwordChangeErrorOf({ status: 500 })).toBe('unknown');
    expect(passwordChangeErrorOf({})).toBe('network');
    expect(passwordChangeErrorOf(null)).toBe('network');
  });
});

function renderForm(changePassword: Parameters<typeof ChangePasswordForm>[0]['changePassword']) {
  const onDone = vi.fn();
  render(
    <ToastProvider>
      <ChangePasswordForm changePassword={changePassword} onDone={onDone} />
    </ToastProvider>,
  );
  const fill = (current: string, next: string, confirm: string) => {
    fireEvent.change(screen.getByLabelText(/Contraseña actual/), { target: { value: current } });
    fireEvent.change(screen.getByLabelText(/^Nueva contraseña/), { target: { value: next } });
    fireEvent.change(screen.getByLabelText(/Repite la nueva contraseña/), {
      target: { value: confirm },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
  };
  return { onDone, fill };
}

describe('change password form', () => {
  it('shows Spanish field errors and sends nothing while the form is invalid', () => {
    const change = vi.fn();
    const { fill } = renderForm(change);
    fill('', 'corta', 'otra');
    expect(screen.getByText('Ingresa tu contraseña actual.')).toBeTruthy();
    expect(screen.getByText('Debe tener al menos 12 caracteres.')).toBeTruthy();
    expect(screen.getByText('Las contraseñas no coinciden.')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
  });

  it('changes the password and closes the other sessions', async () => {
    const change = vi.fn().mockResolvedValue({ data: { token: 't' }, error: null });
    const { fill, onDone } = renderForm(change);
    fill('actual-1234', GOOD, GOOD);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(change).toHaveBeenCalledWith({
      currentPassword: 'actual-1234',
      newPassword: GOOD,
      revokeOtherSessions: true,
    });
    expect(
      await screen.findByText('Contraseña actualizada. Se cerraron tus otras sesiones.'),
    ).toBeTruthy();
    expect((screen.getByLabelText(/Contraseña actual/) as HTMLInputElement).value).toBe('');
  });

  it('says when the current password is wrong', async () => {
    const change = vi
      .fn()
      .mockResolvedValue({ data: null, error: { status: 400, authCode: 'INVALID_PASSWORD' } });
    const { fill, onDone } = renderForm(change);
    fill('equivocada', GOOD, GOOD);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'La contraseña actual no es correcta.',
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports a network failure', async () => {
    const change = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { fill } = renderForm(change);
    fill('actual-1234', GOOD, GOOD);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No hay conexión con el servidor.',
    );
  });
});
