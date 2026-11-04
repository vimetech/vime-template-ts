import { RedeemInvitationRequestSchema } from '@vime/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../lib/i18n-hook';
import { Badge, BrandWordmark, Button, Field, Icon, Input, cx, focusRing } from '../components/ui';
import { ApiProblem, NETWORK_PROBLEM } from '../lib/api';
import { api } from '../lib/client';
import { validateWith, type FieldErrors } from '../lib/forms';
import { importOrReload, preload } from '../lib/lazy';
import { keys } from '../lib/queries';

type LoginError = 'invalid' | 'rate_limited' | 'network' | 'unknown';

/** Maps a Better Auth client error (problem+json from the API) to what we tell the user. */
function loginErrorOf(status: number | undefined): LoginError {
  if (status === 401 || status === 400 || status === 403) return 'invalid';
  if (status === 429) return 'rate_limited';
  if (!status) return 'network';
  return 'unknown';
}

export type RedeemError =
  'code' | 'email' | 'password' | 'conflict' | 'rate_limited' | 'network' | 'unknown';

/** What to tell the person about a failed redemption (POST /auth/invite/redeem). */
export function redeemErrorOf(error: unknown): RedeemError {
  if (!(error instanceof ApiProblem)) return 'unknown';
  if (error.code === NETWORK_PROBLEM) return 'network';
  if (error.status === 429) return 'rate_limited';
  // An existing account whose password does not match.
  if (error.status === 401) return 'password';
  if (error.status === 409) return 'conflict';
  if (error.status === 400) {
    const paths = error.errors.map((issue) => issue.path);
    if (paths.includes('email')) return 'email';
    if (paths.includes('password')) return 'password';
    return 'code';
  }
  return 'unknown';
}

export function LoginPage() {
  const { t } = useT();
  const [mode, setMode] = useState<'signIn' | 'invitation'>('signIn');
  return (
    <main id="main" className="flex min-h-dvh bg-slate-50">
      <BrandPanel />
      <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
        {/* A soft indigo glow behind the card (phones and tablets, where the brand panel hides). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(60%_60%_at_50%_0%,var(--color-indigo-100),transparent)] lg:hidden"
        />
        <div className="relative w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <BrandWordmark name={t('common:appName')} className="text-[34px]" />
            <p className="mt-3 max-w-xs text-sm text-slate-500">{t('login.tagline')}</p>
          </div>
          {mode === 'signIn' ? <SignInForm /> : <RedeemForm />}
          <div className="mt-6 flex flex-col items-center gap-3 text-center">
            <button
              type="button"
              className={cx(
                'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-50 hover:text-indigo-800',
                focusRing,
              )}
              onClick={() => setMode(mode === 'signIn' ? 'invitation' : 'signIn')}
            >
              <Icon name={mode === 'signIn' ? 'mail' : 'arrow-left'} className="size-4" />
              {mode === 'signIn' ? t('login.haveInvitation') : t('login.backToSignIn')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Desktop: the product's promise next to the form, with a small list drawn in CSS. */
function BrandPanel() {
  const { t } = useT();
  const features = [
    { icon: 'building', text: t('login.features.tenancy') },
    { icon: 'users', text: t('login.features.team') },
    { icon: 'settings', text: t('login.features.platform') },
  ] as const;
  return (
    <aside className="relative hidden w-[46%] max-w-3xl shrink-0 flex-col justify-between overflow-hidden bg-indigo-950 p-12 text-white lg:flex xl:p-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_50%_at_20%_0%,rgb(37_189_167/0.32),transparent),radial-gradient(60%_50%_at_100%_100%,rgb(168_230_215/0.16),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)] bg-[linear-gradient(rgb(255_255_255/0.06)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.06)_1px,transparent_1px)] bg-[size:32px_32px]"
      />
      <div className="relative flex items-center gap-3">
        <BrandWordmark name={t('common:appName')} tone="light" className="text-[30px]" />
      </div>
      <div className="relative max-w-md">
        <h2 className="text-[34px] leading-[1.15] font-semibold tracking-tight text-balance">
          {t('login.headline')}
        </h2>
        <p className="mt-4 text-base text-indigo-200 dark:text-indigo-800">{t('login.tagline')}</p>
        <ul className="mt-10 flex flex-col gap-4">
          {features.map((feature) => (
            <li
              key={feature.icon}
              className="flex items-center gap-3.5 text-[15px] text-indigo-50 dark:text-indigo-900"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                <Icon
                  name={feature.icon}
                  className="size-[18px] text-indigo-200 dark:text-indigo-800"
                />
              </span>
              {feature.text}
            </li>
          ))}
        </ul>
      </div>
      <ListSketch />
    </aside>
  );
}

/** Decorative: three rows of a list with real role labels and blurred names. */
function ListSketch() {
  const { t } = useT();
  const rows = [
    {
      width: 'w-28',
      badge: (
        <Badge tone="indigo" icon="check">
          {t('common:roleKey.owner')}
        </Badge>
      ),
    },
    {
      width: 'w-36',
      badge: (
        <Badge tone="sky" dot>
          {t('common:roleKey.manager')}
        </Badge>
      ),
    },
    {
      width: 'w-24',
      badge: (
        <Badge tone="green" dot>
          {t('common:membershipStatus.active')}
        </Badge>
      ),
    },
  ];
  return (
    <div
      aria-hidden="true"
      className="relative mt-12 max-w-md rounded-2xl bg-surface/95 p-2 shadow-2xl shadow-indigo-950/50 ring-1 ring-white/20"
    >
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-3 rounded-xl px-3 py-2.5 odd:bg-slate-50">
          <span className="flex size-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <Icon name="user" className="size-4" />
          </span>
          <span className="flex flex-1 flex-col gap-1.5">
            <span className={cx('h-2.5 rounded-full bg-slate-300', row.width)} />
            <span className="h-2 w-16 rounded-full bg-slate-200" />
          </span>
          {row.badge}
        </div>
      ))}
    </div>
  );
}

function ErrorBox({ children }: { children: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-900"
    >
      <Icon name="alert-circle" className="mt-px size-4 text-rose-600" strokeWidth={2} />
      <span>{children}</span>
    </div>
  );
}

const cardClass =
  'flex flex-col gap-5 rounded-2xl border border-slate-200/80 bg-surface p-6 shadow-xl shadow-slate-900/5 sm:p-8';

function SignInForm() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/login' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<LoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The Better Auth client is its own chunk, so the form shows without waiting for it; it loads
  // while the person types.
  useEffect(() => {
    preload(() => import('../lib/auth'));
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { authClient } = await importOrReload(() => import('../lib/auth'));
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(loginErrorOf(result.error.status));
        return;
      }
      await queryClient.resetQueries({ queryKey: keys.me });
      await navigate({ to: search.redirect ?? '/' });
    } catch {
      setError('network');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className={cardClass} noValidate>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('login.title')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('login.subtitle')}</p>
      </div>
      {error ? <ErrorBox>{t(`login.errors.${error}`)}</ErrorBox> : null}
      <Field label={t('login.email')} required>
        {(props) => (
          <Input
            {...props}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field label={t('login.password')} required>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="mt-1 w-full"
        loading={submitting}
        disabled={email.trim() === '' || password === ''}
      >
        {t('login.submit')}
      </Button>
    </form>
  );
}

/**
 * Accepting an invitation sent by email (Settings → "Invitar por correo"): code + the invited
 * email + a password (new account) or the account's current password (existing account), then
 * the session cookie of the redemption signs the person in. One Idempotency-Key per (code, email,
 * name) attempt, so pressing the button again after a lost response replays instead of failing.
 */
function RedeemForm() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/login' });
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const attempt = useRef<{ identity: string; key: string } | null>(null);

  const keyFor = (identity: string): string => {
    if (attempt.current?.identity !== identity) {
      attempt.current = { identity, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };

  const redeem = useMutation({
    mutationFn: (body: { code: string; email: string; password: string; name?: string }) =>
      api.mutate('POST', '/auth/invite/redeem', {
        body,
        schema: null,
        // The server compares the normalized code, email and name of a replay (not the password).
        idempotencyKey: keyFor(
          [
            body.code.toUpperCase().replace(/[^0-9A-Z]/g, ''),
            body.email.toLowerCase(),
            body.name ?? '',
          ].join('|'),
        ),
      }),
    onSuccess: async () => {
      attempt.current = null;
      await queryClient.resetQueries({ queryKey: keys.me });
      await navigate({ to: search.redirect ?? '/' });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const input = {
      code: code.trim(),
      email: email.trim(),
      password,
      ...(trimmedName ? { name: trimmedName } : {}),
    };
    const checked = validateWith(t, RedeemInvitationRequestSchema, input);
    if (!checked.ok) {
      setFieldErrors(checked.errors);
      return;
    }
    setFieldErrors({});
    redeem.mutate(input);
  }

  const error = redeem.isError ? redeemErrorOf(redeem.error) : null;
  return (
    <form onSubmit={onSubmit} className={cardClass} noValidate>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          {t('login.inviteTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-500">{t('login.inviteSubtitle')}</p>
      </div>
      {error ? <ErrorBox>{t(`login.inviteErrors.${error}`)}</ErrorBox> : null}
      <Field label={t('login.code')} required error={fieldErrors['code']}>
        {(props) => (
          <Input
            {...props}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field
        label={t('login.email')}
        hint={t('login.inviteEmailHint')}
        required
        error={fieldErrors['email']}
      >
        {(props) => (
          <Input
            {...props}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field
        label={t('login.password')}
        hint={t('login.invitePasswordHint')}
        required
        error={fieldErrors['password']}
      >
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('login.name')} hint={t('login.nameHint')} error={fieldErrors['name']}>
        {(props) => (
          <Input
            {...props}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="mt-1 w-full"
        loading={redeem.isPending}
        disabled={code.trim() === '' || email.trim() === '' || password === ''}
      >
        {t('login.inviteSubmit')}
      </Button>
    </form>
  );
}
