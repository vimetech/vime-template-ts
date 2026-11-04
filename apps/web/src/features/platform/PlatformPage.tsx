import {
  CreateOwnerInvitationSchema,
  CreatePlatformOrganizationResponseSchema,
  CreatePlatformOrganizationSchema,
  FEATURES,
  OwnerInvitationSchema,
  PlatformOrganizationSchema,
  type FeatureKey,
  type OwnerInvitation,
  type PlatformOrganization,
} from '@vime/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  Badge,
  BrandWordmark,
  Button,
  Card,
  Checkbox,
  CopyButton,
  Dialog,
  DialogActions,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  LoadingState,
  PageHeader,
  ProblemAlert,
  Select,
  buttonClass,
  useToast,
} from '../../components/ui';
import { api } from '../../lib/client';
import { problemFieldErrors, validateWith, type FieldErrors } from '../../lib/forms';
import { useT } from '../../lib/i18n-hook';
import { listOf, meQuery } from '../../lib/queries';
import { formatShortDate, timeZoneOptions } from '../../lib/time';
import { useFormatLocale } from '../../lib/use-format';
import { useSignOut } from '../../lib/use-sign-out';

/*
 * Platform console (ADR 0015): the organizations of every client, for platform administrators
 * (`PLATFORM_ADMIN_USER_IDS`). Modules on and off, a new client and its owner's invitation, and
 * suspension. It never shows an organization's operational data: "Entrar" appears only for one
 * the administrator is a member of.
 */

const QUERY_KEY = ['platform', 'organizations'] as const;
const BASE = '/v1/platform/organizations';

/** Modules the app gates today; the rest can be turned on ahead of time but change nothing yet. */
const WIRED_FEATURES: ReadonlySet<FeatureKey> = new Set(['example']);

/** Dates of the console in the administrator's own time zone (it spans organizations). */
const VIEWER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `Acme Perú S.A.C.` → `acme-peru-s-a-c`, cut to the slug's 64 characters. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function useReplaceOrganization() {
  const queryClient = useQueryClient();
  return (organization: PlatformOrganization) =>
    queryClient.setQueryData<{ items: PlatformOrganization[] }>(QUERY_KEY, (data) =>
      data ? { items: data.items.map((o) => (o.id === organization.id ? organization : o)) } : data,
    );
}

export function PlatformPage() {
  const { t } = useT();
  const logout = useSignOut();
  const { data: me } = useQuery(meQuery());
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [invitation, setInvitation] = useState<{ org: string; value: OwnerInvitation } | null>(
    null,
  );
  const organizations = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => api.get(BASE, listOf(PlatformOrganizationSchema), { signal }),
  });
  const queryClient = useQueryClient();
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const items = organizations.data?.items ?? [];
    return needle
      ? items.filter((o) => o.name.toLowerCase().includes(needle) || o.slug.includes(needle))
      : items;
  }, [organizations.data, search]);
  const enterable = new Set(me?.memberships.map((m) => m.organization.id));

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandWordmark name={t('common:appName')} className="text-xl" />
            <Badge tone="violet">{t('platform.title')}</Badge>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {me?.memberships.length ? (
              <Link to="/" className={buttonClass('ghost')}>
                <Icon name="home" className="size-4" />
                <span className="sr-only sm:not-sr-only">{t('actions.goHome')}</span>
              </Link>
            ) : null}
            <Button
              variant="ghost"
              icon="log-out"
              loading={logout.pending}
              onClick={() => void logout.signOut()}
            >
              <span className="sr-only sm:not-sr-only">{t('shell.logout')}</span>
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 md:px-6">
        <PageHeader
          title={t('platform.title')}
          description={t('platform.subtitle')}
          actions={
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t('platform.newOrganization')}
            </Button>
          }
        />
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
          />
          <Input
            type="search"
            value={search}
            placeholder={t('platform.search')}
            aria-label={t('platform.search')}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full pl-8 pointer-coarse:h-11"
          />
        </div>
        {organizations.isPending ? (
          <LoadingState />
        ) : organizations.isError ? (
          <ErrorState error={organizations.error} onRetry={() => void organizations.refetch()} />
        ) : organizations.data.items.length === 0 ? (
          <EmptyState icon="building" title={t('platform.empty')} />
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title={t('platform.noResults')} />
        ) : (
          <ul className="flex flex-col gap-4">
            {visible.map((organization) => (
              <li key={organization.id}>
                <OrganizationCard
                  organization={organization}
                  canEnter={enterable.has(organization.id)}
                  onInvited={(value) => setInvitation({ org: organization.name, value })}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('platform.create.title')}
        size="md"
      >
        {creating ? (
          <CreateOrganizationForm
            onCancel={() => setCreating(false)}
            onCreated={(result) => {
              setCreating(false);
              queryClient.setQueryData<{ items: PlatformOrganization[] }>(QUERY_KEY, (data) =>
                data
                  ? {
                      items: [...data.items, result.organization].sort((a, b) =>
                        a.name.localeCompare(b.name),
                      ),
                    }
                  : data,
              );
              setInvitation({ org: result.organization.name, value: result.ownerInvitation });
            }}
          />
        ) : null}
      </Dialog>
      <InvitationDialog invitation={invitation} onClose={() => setInvitation(null)} />
    </div>
  );
}

function OrganizationCard({
  organization,
  canEnter,
  onInvited,
}: {
  organization: PlatformOrganization;
  canEnter: boolean;
  onInvited: (invitation: OwnerInvitation) => void;
}) {
  const { t } = useT();
  const locale = useFormatLocale();
  const toast = useToast();
  const replace = useReplaceOrganization();
  const [suspending, setSuspending] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const date = (iso: string) => formatShortDate(iso, VIEWER_TIME_ZONE, locale);
  const suspended = organization.suspendedAt !== null;
  const entitlements = new Map(organization.entitlements.map((e) => [e.featureKey, e]));

  const toggle = useMutation({
    mutationFn: ({ feature, enabled }: { feature: FeatureKey; enabled: boolean }) =>
      api.mutate('PUT', `${BASE}/${organization.id}/entitlements/${feature}`, {
        body: { enabled, validUntil: null },
        schema: PlatformOrganizationSchema,
      }),
    onSuccess: (data, { feature, enabled }) => {
      replace(data);
      const name = t(`common:feature.${feature}`);
      toast.success(enabled ? t('platform.moduleOn', { name }) : t('platform.moduleOff', { name }));
    },
  });

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {organization.name}
          {suspended ? (
            <Badge tone="red">
              {t('platform.suspendedSince', { date: date(organization.suspendedAt!) })}
            </Badge>
          ) : (
            <Badge tone="green">{t('platform.active')}</Badge>
          )}
        </span>
      }
      description={[
        organization.slug,
        organization.timezone,
        t('platform.createdAt', { date: date(organization.createdAt) }),
      ].join(' · ')}
      actions={
        <div className="flex flex-wrap gap-2">
          {canEnter && !suspended ? (
            <Link
              to="/o/$orgId"
              params={{ orgId: organization.id }}
              className={buttonClass('secondary')}
            >
              <Icon name="arrow-right" className="size-4" />
              {t('platform.enter')}
            </Link>
          ) : null}
          {suspended ? (
            <Button icon="refresh" onClick={() => setReactivating(true)}>
              {t('platform.reactivate')}
            </Button>
          ) : (
            <Button variant="danger" icon="lock" onClick={() => setSuspending(true)}>
              {t('platform.suspend')}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5 text-sm text-slate-700">
          {organization.owners.length ? (
            <p className="flex items-center gap-2">
              <Icon name="user" className="size-4 text-slate-500" />
              {t('platform.owners', {
                names: organization.owners
                  .map((o) => (o.email ? `${o.name} (${o.email})` : o.name))
                  .join(', '),
              })}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-amber-800">
              <Icon name="alert-triangle" className="size-4 text-amber-600" />
              {t('platform.noOwner')}
              <Button size="sm" icon="send" onClick={() => setInviting(true)}>
                {t('platform.inviteOwner')}
              </Button>
            </p>
          )}
        </div>
        <fieldset className="flex flex-col gap-3" disabled={toggle.isPending}>
          <legend className="mb-2 text-sm font-semibold text-slate-900">
            {t('platform.modules')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => {
              const entitlement = entitlements.get(feature);
              const validUntil = entitlement?.validUntil ?? null;
              const expired = validUntil !== null && Date.parse(validUntil) <= Date.now();
              const notes = [
                WIRED_FEATURES.has(feature) ? null : t('platform.notWiredYet'),
                validUntil
                  ? t(expired ? 'platform.expired' : 'platform.validUntil', {
                      date: date(validUntil),
                    })
                  : null,
              ].filter(Boolean);
              return (
                <Checkbox
                  key={feature}
                  label={t(`common:feature.${feature}`)}
                  description={notes.length ? notes.join(' · ') : undefined}
                  checked={entitlement?.enabled ?? false}
                  onChange={(e) => toggle.mutate({ feature, enabled: e.target.checked })}
                />
              );
            })}
          </div>
        </fieldset>
        {toggle.isError ? <ProblemAlert error={toggle.error} /> : null}
      </div>
      <ConfirmDialog
        open={suspending}
        onClose={() => setSuspending(false)}
        title={t('platform.suspendTitle', { name: organization.name })}
        confirmLabel={t('platform.suspend')}
        tone="danger"
        reasonLabel={t('platform.reason')}
        reasonRequired
        onConfirm={async (reason) => {
          replace(
            await api.mutate('PUT', `${BASE}/${organization.id}/suspension`, {
              body: { reason },
              schema: PlatformOrganizationSchema,
            }),
          );
          toast.success(t('platform.suspended'));
        }}
      >
        {t('platform.suspendBody')}
      </ConfirmDialog>
      <ConfirmDialog
        open={reactivating}
        onClose={() => setReactivating(false)}
        title={t('platform.reactivateTitle', { name: organization.name })}
        confirmLabel={t('platform.reactivate')}
        onConfirm={async () => {
          replace(
            await api.mutate('DELETE', `${BASE}/${organization.id}/suspension`, {
              schema: PlatformOrganizationSchema,
            }),
          );
          toast.success(t('platform.reactivated'));
        }}
      >
        {t('platform.reactivateBody')}
      </ConfirmDialog>
      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title={t('platform.inviteOwnerTitle', { name: organization.name })}
        size="sm"
      >
        {inviting ? (
          <InviteOwnerForm
            orgId={organization.id}
            onCancel={() => setInviting(false)}
            onCreated={(value) => {
              setInviting(false);
              onInvited(value);
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}

function CreateOrganizationForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (result: ReturnType<typeof CreatePlatformOrganizationResponseSchema.parse>) => void;
}) {
  const { t } = useT();
  const [form, setForm] = useState({
    name: '',
    slug: '',
    slugEdited: false,
    timezone: 'America/Lima',
    ownerEmail: '',
    features: ['example'] as FeatureKey[],
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.mutate('POST', BASE, { body, schema: CreatePlatformOrganizationResponseSchema }),
    onSuccess: onCreated,
    onError: (error) => setErrors(problemFieldErrors(error)),
  });
  const slug = form.slugEdited ? form.slug : slugify(form.name);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const body = {
          name: form.name.trim(),
          slug,
          timezone: form.timezone,
          ownerEmail: form.ownerEmail.trim(),
          features: form.features,
        };
        const checked = validateWith(t, CreatePlatformOrganizationSchema, body);
        if (!checked.ok) return setErrors(checked.errors);
        setErrors({});
        create.mutate(body);
      }}
    >
      <Field label={t('platform.create.name')} required error={errors['name']}>
        {(props) => (
          <Input
            {...props}
            value={form.name}
            maxLength={200}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
      </Field>
      <Field
        label={t('platform.create.slug')}
        hint={t('platform.create.slugHint')}
        required
        error={errors['slug']}
      >
        {(props) => (
          <Input
            {...props}
            value={slug}
            maxLength={64}
            onChange={(e) => setForm({ ...form, slug: e.target.value, slugEdited: true })}
          />
        )}
      </Field>
      <Field
        label={t('platform.create.timezone')}
        hint={t('platform.create.timezoneHint')}
        required
        error={errors['timezone']}
      >
        {(props) => (
          <Select
            {...props}
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {timeZoneOptions(form.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label={t('platform.create.ownerEmail')}
        hint={t('platform.create.ownerEmailHint')}
        required
        error={errors['ownerEmail']}
      >
        {(props) => (
          <Input
            {...props}
            type="email"
            value={form.ownerEmail}
            onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-sm font-medium text-slate-700">
          {t('platform.create.features')}
        </legend>
        {FEATURES.map((feature) => (
          <Checkbox
            key={feature}
            label={t(`common:feature.${feature}`)}
            description={WIRED_FEATURES.has(feature) ? undefined : t('platform.notWiredYet')}
            checked={form.features.includes(feature)}
            onChange={(e) =>
              setForm({
                ...form,
                features: e.target.checked
                  ? FEATURES.filter((f) => f === feature || form.features.includes(f))
                  : form.features.filter((f) => f !== feature),
              })
            }
          />
        ))}
      </fieldset>
      {create.isError ? <ProblemAlert error={create.error} /> : null}
      <DialogActions>
        <Button onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t('platform.create.submit')}
        </Button>
      </DialogActions>
    </form>
  );
}

function InviteOwnerForm({
  orgId,
  onCancel,
  onCreated,
}: {
  orgId: string;
  onCancel: () => void;
  onCreated: (invitation: OwnerInvitation) => void;
}) {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (body: { email: string }) =>
      api.mutate('POST', `${BASE}/${orgId}/owner-invitations`, {
        body,
        schema: OwnerInvitationSchema,
      }),
    onSuccess: onCreated,
    onError: (error) => setErrors(problemFieldErrors(error)),
  });
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const body = { email: email.trim() };
        const checked = validateWith(t, CreateOwnerInvitationSchema, body);
        if (!checked.ok) return setErrors(checked.errors);
        setErrors({});
        create.mutate(body);
      }}
    >
      <p className="text-sm text-slate-600">{t('platform.inviteOwnerBody')}</p>
      <Field label={t('platform.create.ownerEmail')} required error={errors['email']}>
        {(props) => (
          <Input {...props} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      {create.isError ? <ProblemAlert error={create.error} /> : null}
      <DialogActions>
        <Button onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t('platform.inviteOwner')}
        </Button>
      </DialogActions>
    </form>
  );
}

/** The owner's code, shown once, with a ready message to send. */
function InvitationDialog({
  invitation,
  onClose,
}: {
  invitation: { org: string; value: OwnerInvitation } | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const locale = useFormatLocale();
  const value = invitation?.value;
  const expires = value ? formatShortDate(value.expiresAt, VIEWER_TIME_ZONE, locale) : '';
  const message =
    invitation && value
      ? t('platform.invitation.message', {
          app: t('common:appName'),
          org: invitation.org,
          url: `${window.location.origin}/login`,
          email: value.email,
          code: value.code,
          date: expires,
        })
      : '';
  return (
    <Dialog
      open={invitation !== null}
      onClose={onClose}
      title={t('platform.invitation.title')}
      size="sm"
    >
      {value ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            {t('platform.invitation.body', { email: value.email, date: expires })}
          </p>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              {t('platform.invitation.code')}
            </span>
            <span className="font-mono text-xl font-semibold tracking-widest text-slate-900">
              {value.code}
            </span>
          </div>
          <p className="rounded-xl border border-slate-200 bg-surface px-3.5 py-3 text-sm whitespace-pre-line text-slate-700">
            {message}
          </p>
          <DialogActions>
            <CopyButton text={message} label={t('platform.invitation.copyMessage')} />
            <Button variant="primary" onClick={onClose}>
              {t('platform.invitation.done')}
            </Button>
          </DialogActions>
        </div>
      ) : null}
    </Dialog>
  );
}
