import { useState, type FormEvent } from 'react';
import { Button, Field, Icon, Input, useToast } from '../../components/ui';
import { useT } from '../../lib/i18n-hook';
import { importOrReload } from '../../lib/lazy';

/** Password policy of the web form (Better Auth itself accepts 8..128; we ask for more). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordFieldError =
  'currentRequired' | 'tooShort' | 'tooLong' | 'mismatch' | 'sameAsCurrent';

/** Field → what is wrong with it, before anything is sent. Empty when the form can be sent. */
export function validatePasswordChange(
  input: PasswordChangeInput,
): Partial<Record<keyof PasswordChangeInput, PasswordFieldError>> {
  const errors: Partial<Record<keyof PasswordChangeInput, PasswordFieldError>> = {};
  if (input.currentPassword === '') errors.currentPassword = 'currentRequired';
  // Length in characters as people count them (an emoji is one), like Better Auth.
  const length = Array.from(input.newPassword).length;
  if (length < PASSWORD_MIN_LENGTH) errors.newPassword = 'tooShort';
  else if (length > PASSWORD_MAX_LENGTH) errors.newPassword = 'tooLong';
  else if (input.newPassword === input.currentPassword) errors.newPassword = 'sameAsCurrent';
  if (input.confirmPassword !== input.newPassword) errors.confirmPassword = 'mismatch';
  return errors;
}

export type PasswordChangeError =
  | 'currentWrong'
  | 'tooShort'
  | 'tooLong'
  | 'noPassword'
  | 'sessionExpired'
  | 'rate_limited'
  | 'network'
  | 'unknown';

/**
 * A Better Auth client error of POST /auth/change-password → what to tell the person. The API
 * turns Better Auth errors into problem+json and keeps Better Auth's own code as `authCode`
 * (e.g. `INVALID_PASSWORD` for a wrong current password).
 */
export function passwordChangeErrorOf(
  error: { status?: number; authCode?: unknown; code?: unknown } | null | undefined,
): PasswordChangeError {
  if (!error || !error.status) return 'network';
  const authCode = typeof error.authCode === 'string' ? error.authCode : undefined;
  if (error.status === 401) return 'sessionExpired';
  if (error.status === 429) return 'rate_limited';
  if (authCode === 'INVALID_PASSWORD') return 'currentWrong';
  if (authCode === 'PASSWORD_TOO_SHORT') return 'tooShort';
  if (authCode === 'PASSWORD_TOO_LONG') return 'tooLong';
  if (authCode === 'CREDENTIAL_ACCOUNT_NOT_FOUND') return 'noPassword';
  return 'unknown';
}

type ChangePassword = (input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}) => Promise<{ error?: { status?: number; authCode?: unknown; code?: unknown } | null }>;

/**
 * Better Auth's `changePassword`, with the client loaded on demand (not in the first download); a
 * client gone after a deploy reloads the page once (`importOrReload`).
 */
const changePasswordWithBetterAuth: ChangePassword = async (input) =>
  (await importOrReload(() => import('../../lib/auth'))).authClient.changePassword(input);

/**
 * "Cambiar contraseña" (Better Auth `changePassword`). The other sessions of the user (other
 * browsers, a forgotten computer) are closed; this one continues with a new session cookie.
 */
export function ChangePasswordForm({
  onDone,
  changePassword = changePasswordWithBetterAuth,
}: {
  /** Called after a successful change (e.g. to close a dialog). */
  onDone?: () => void;
  /** Injected in tests; defaults to the Better Auth client. */
  changePassword?: ChangePassword;
}) {
  const { t } = useT();
  const toast = useToast();
  const [form, setForm] = useState<PasswordChangeInput>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof validatePasswordChange>>({});
  const [error, setError] = useState<PasswordChangeError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fieldMessage = (field: keyof PasswordChangeInput): string | undefined => {
    const code = fieldErrors[field];
    if (!code) return undefined;
    return t(`account.errors.${code}`, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const errors = validatePasswordChange(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    try {
      const result = await changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(passwordChangeErrorOf(result.error));
        return;
      }
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success(t('account.changed'));
      onDone?.();
    } catch {
      setError('network');
    } finally {
      setSubmitting(false);
    }
  }

  const set = (field: keyof PasswordChangeInput, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4" noValidate>
      <p className="text-sm leading-relaxed text-slate-500">
        {t('account.changePasswordHint', { min: PASSWORD_MIN_LENGTH })}
      </p>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-900"
        >
          <Icon name="alert-circle" className="mt-px size-4 text-rose-600" strokeWidth={2} />
          {t(`account.errors.${error}`, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })}
        </div>
      ) : null}
      <Field label={t('account.current')} required error={fieldMessage('currentPassword')}>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="current-password"
            value={form.currentPassword}
            {...(error === 'currentWrong' ? { 'aria-invalid': true } : {})}
            onChange={(event) => set('currentPassword', event.target.value)}
          />
        )}
      </Field>
      <Field
        label={t('account.next')}
        required
        hint={t('account.nextHint', { min: PASSWORD_MIN_LENGTH })}
        error={fieldMessage('newPassword')}
      >
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={form.newPassword}
            onChange={(event) => set('newPassword', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('account.confirm')} required error={fieldMessage('confirmPassword')}>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={form.confirmPassword}
            onChange={(event) => set('confirmPassword', event.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end max-sm:*:flex-1">
        <Button type="submit" variant="primary" loading={submitting}>
          {t('account.submit')}
        </Button>
      </div>
    </form>
  );
}
