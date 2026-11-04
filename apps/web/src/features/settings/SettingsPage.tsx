import {
  CreateInvitationResponseSchema,
  CreateInvitationSchema,
  InvitationListItemSchema,
  MemberSchema,
  OPTIONAL_FUNCTIONS,
  OrganizationSchema,
  ROLE_KEYS,
  UpdateOrganizationSchema,
  isFunctionOn,
  type CreateInvitationResponse,
  type Locale,
  type Member,
  type OptionalFunction,
  type Organization,
  type RoleKey,
} from '@vime/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RequirePermission } from '../../components/RequirePermission';
import { ChangePasswordForm } from '../account/ChangePasswordForm';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  Dialog,
  DialogActions,
  EmptyState,
  ErrorState,
  Field,
  FormErrors,
  Icon,
  Input,
  LoadingState,
  PageHeader,
  ProblemAlert,
  Select,
  cx,
  useToast,
} from '../../components/ui';
import { api } from '../../lib/client';
import { useIntentKey } from '../../lib/use-intent-key';
import { problemFieldErrors, validateWith, type FieldErrors } from '../../lib/forms';
import { useT } from '../../lib/i18n-hook';
import { useOrg } from '../../lib/org';
import { PresentationLock, usePresentation } from '../../lib/presentation';
import { invalidateOrg, keys, listOf, orgPath, organizationQuery } from '../../lib/queries';
import { formatDateTime, timeZoneOptions } from '../../lib/time';
import { useFormatLocale } from '../../lib/use-format';

export function SettingsPage() {
  return (
    <RequirePermission anyOf={['org.manage', 'member.manage']}>
      <Settings />
    </RequirePermission>
  );
}

function Settings() {
  const { t } = useT();
  const { orgId, can } = useOrg();
  // Always asked again on opening: the form starts from the stored settings, not from a copy
  // cached minutes ago (other readers keep the 5-minute cache).
  const organization = useQuery({ ...organizationQuery(orgId), refetchOnMount: 'always' });
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      {organization.isPending ? (
        <LoadingState />
      ) : organization.isError ? (
        <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />
      ) : (
        <OrganizationCard
          key={organization.data.updatedAt ?? ''}
          organization={organization.data}
          readOnly={!can('org.manage')}
        />
      )}
      {can('member.manage') ? (
        <>
          <MembersCard />
          <InvitationsCard />
        </>
      ) : null}
      <Card title={t('account.changePassword')}>
        <div className="max-w-md">
          <ChangePasswordForm />
        </div>
      </Card>
    </div>
  );
}

/** The organization's values as the settings form edits them. */
function organizationForm(organization: Organization) {
  return {
    name: organization.name,
    timezone: organization.timezone,
    locale: organization.locale as Locale,
    coordinationPhoneE164: organization.settings.coordinationPhoneE164 ?? '',
    // The known functions that are off, in OPTIONAL_FUNCTIONS order (unknown ones are dropped).
    disabledFunctions: OPTIONAL_FUNCTIONS.filter(
      (fn) => !isFunctionOn(organization.settings.disabledFunctions, fn),
    ),
  };
}

type OrganizationForm = ReturnType<typeof organizationForm>;

/** The form's values as the API takes them (the functions list apart, see `organizationPatch`). */
function organizationValues(form: OrganizationForm) {
  return {
    name: form.name.trim(),
    timezone: form.timezone,
    locale: form.locale,
    settings: {
      coordinationPhoneE164: form.coordinationPhoneE164.replace(/[\s-]/g, '') || null,
    },
  };
}

/**
 * The PATCH of the settings form: only what the person changed against `initial` (the values the
 * form started from), so a setting someone else saved in the meantime is never sent back as this
 * page last saw it. The functions list goes only when a switch changed, with the stored values
 * this build does not know sent back as they were (a newer function stays off).
 */
function organizationPatch(
  form: OrganizationForm,
  initial: OrganizationForm,
  storedDisabledFunctions: readonly string[],
): Record<string, unknown> {
  const next = organizationValues(form);
  const saved = organizationValues(initial);
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next.settings)) {
    // An empty optional field (undefined) keeps the stored value, as before.
    if (value !== undefined && changed(value, saved.settings[key as keyof typeof saved.settings])) {
      settings[key] = value;
    }
  }
  if (changed(form.disabledFunctions, initial.disabledFunctions)) {
    const unknownFunctions = storedDisabledFunctions.filter(
      (value) => !(OPTIONAL_FUNCTIONS as readonly string[]).includes(value),
    );
    settings['disabledFunctions'] = [...form.disabledFunctions, ...unknownFunctions];
  }
  return {
    ...(next.name !== saved.name ? { name: next.name } : {}),
    ...(next.timezone !== saved.timezone ? { timezone: next.timezone } : {}),
    ...(next.locale !== saved.locale ? { locale: next.locale } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

function OrganizationCard({
  organization,
  readOnly,
}: {
  organization: Organization;
  readOnly: boolean;
}) {
  const { t } = useT();
  const { orgId } = useOrg();
  const toast = useToast();
  const queryClient = useQueryClient();
  // The saved values: the form is "dirty" when it differs (the page remounts after a save).
  const initial = useMemo(() => organizationForm(organization), [organization]);
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.mutate('PATCH', orgPath(orgId), { body, schema: OrganizationSchema }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(keys.organization(orgId), saved);
      // A save that changed nothing stored (e.g. only the phone's spacing) keeps `updatedAt`, so
      // the card does not remount: show the stored values (and "saved") anyway.
      setForm(organizationForm(saved));
      toast.success(t('states.saved'));
      // The org name, time zone and functions also come with /me (switcher, navigation).
      await queryClient.invalidateQueries({ queryKey: keys.me });
    },
    onError: (error) => setErrors(problemFieldErrors(error)),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = organizationPatch(form, initial, organization.settings.disabledFunctions);
    const checked = validateWith(t, UpdateOrganizationSchema, body);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    save.mutate(checked.data as Record<string, unknown>);
  }

  const known = ['name', 'timezone', 'locale', 'settings.coordinationPhoneE164'];
  const setFunctionOn = (fn: OptionalFunction, on: boolean) =>
    setForm({
      ...form,
      disabledFunctions: OPTIONAL_FUNCTIONS.filter((other) =>
        other === fn ? !on : form.disabledFunctions.includes(other),
      ),
    });
  const otherErrors = Object.entries(errors)
    .filter(([path]) => !known.includes(path))
    .map(([path, message]) => (path ? `${path}: ${message}` : message));

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {readOnly ? (
        <p className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900">
          <Icon name="lock" className="mt-px size-4 text-sky-600" strokeWidth={2} />
          {t('settings.readOnly')}
        </p>
      ) : null}
      <Card title={t('settings.organization')} description={t('settings.organizationHint')}>
        <fieldset className="grid gap-4 sm:grid-cols-3" disabled={readOnly}>
          <legend className="sr-only">{t('settings.organization')}</legend>
          <Field label={t('settings.name')} required error={errors['name']}>
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
            label={t('settings.timezone')}
            hint={t('settings.timezoneHint')}
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
          <Field label={t('settings.locale')} error={errors['locale']}>
            {(props) => (
              <Select
                {...props}
                value={form.locale}
                onChange={(e) => setForm({ ...form, locale: e.target.value as Locale })}
              >
                <option value="es-PE">{t('shell.locales.esPE')}</option>
                <option value="en">{t('shell.locales.en')}</option>
              </Select>
            )}
          </Field>
        </fieldset>
      </Card>
      <Card title={t('settings.contact.title')} description={t('settings.contact.description')}>
        <fieldset className="max-w-xl" disabled={readOnly}>
          <legend className="sr-only">{t('settings.contact.title')}</legend>
          <Field
            label={t('settings.contact.phone')}
            hint={t('settings.contact.phoneHint')}
            error={errors['settings.coordinationPhoneE164']}
          >
            {(props) => (
              <Input
                {...props}
                type="tel"
                inputMode="tel"
                placeholder="+51987654321"
                value={form.coordinationPhoneE164}
                onChange={(e) => setForm({ ...form, coordinationPhoneE164: e.target.value })}
              />
            )}
          </Field>
        </fieldset>
      </Card>
      <Card title={t('settings.functions.title')} description={t('settings.functions.description')}>
        <fieldset className="flex flex-col gap-4" disabled={readOnly}>
          <legend className="sr-only">{t('settings.functions.title')}</legend>
          {OPTIONAL_FUNCTIONS.map((fn) => (
            <Checkbox
              key={fn}
              label={t(`settings.functions.items.${fn}.label`)}
              description={t(`settings.functions.items.${fn}.hint`)}
              checked={!form.disabledFunctions.includes(fn)}
              onChange={(e) => setFunctionOn(fn, e.target.checked)}
            />
          ))}
        </fieldset>
      </Card>
      <FormErrors errors={otherErrors} />
      {save.isError ? <ProblemAlert error={save.error} /> : null}
      {readOnly ? null : (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 md:bottom-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-surface/90 px-4 py-3 shadow-pop backdrop-blur-md">
            <p
              className="flex min-w-0 items-center gap-2 text-sm text-slate-600"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className={cx(
                  'size-2 shrink-0 rounded-full',
                  dirty ? 'bg-amber-500' : 'bg-emerald-500',
                )}
              />
              <span className="truncate">
                {dirty ? t('settings.unsaved') : t('settings.allSaved')}
              </span>
            </p>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t('actions.saveChanges')}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function RoleChecklist({
  value,
  onChange,
}: {
  value: RoleKey[];
  onChange: (next: RoleKey[]) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className="grid gap-1.5 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium text-slate-700">{t('settings.roles')}</legend>
      {ROLE_KEYS.map((key) => (
        <Checkbox
          key={key}
          label={t(`common:roleKey.${key}`)}
          checked={value.includes(key)}
          onChange={(e) =>
            onChange(e.target.checked ? [...value, key] : value.filter((k) => k !== key))
          }
        />
      ))}
    </fieldset>
  );
}

function MembersCard() {
  const { t } = useT();
  const { orgId } = useOrg();
  const presentation = usePresentation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Member | null>(null);
  const [roles, setRoles] = useState<RoleKey[]>([]);
  const members = useQuery({
    queryKey: keys.members(orgId),
    queryFn: ({ signal }) => api.get(orgPath(orgId, '/members'), listOf(MemberSchema), { signal }),
  });
  const save = useMutation({
    mutationFn: (input: { id: string; roleKeys: RoleKey[] }) =>
      api.mutate('PATCH', orgPath(orgId, `/members/${input.id}`), {
        body: { roleKeys: input.roleKeys },
        schema: MemberSchema,
      }),
    onSuccess: async () => {
      toast.success(t('states.saved'));
      setEditing(null);
      await Promise.all([
        invalidateOrg(queryClient, orgId, 'members'),
        queryClient.invalidateQueries({ queryKey: keys.me }),
      ]);
    },
  });

  return (
    <Card flush title={t('settings.members')} description={t('settings.membersHint')}>
      {members.isPending ? (
        <div className="px-4 sm:px-5">
          <LoadingState />
        </div>
      ) : members.isError ? (
        <div className="px-4 sm:px-5">
          <ErrorState error={members.error} />
        </div>
      ) : (
        <ul aria-label={t('settings.members')} className="divide-y divide-slate-100">
          {members.data.items.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5"
            >
              <Avatar name={presentation.person(member.name)} />
              <div className="min-w-0 flex-1 basis-44">
                <p className="truncate text-sm font-medium text-slate-900">
                  {presentation.person(member.name)}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {presentation.email(member.email) ?? t('settings.noEmail')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {member.roleKeys.map((key) => (
                  <Badge key={key} tone="indigo">
                    {t(`common:roleKey.${key}`)}
                  </Badge>
                ))}
                <Badge tone={member.status === 'active' ? 'green' : 'gray'} dot>
                  {t(`common:membershipStatus.${member.status}`)}
                </Badge>
              </div>
              <Button
                size="sm"
                className="pointer-coarse:min-h-11"
                onClick={() => {
                  setEditing(member);
                  setRoles(member.roleKeys);
                }}
              >
                {t('settings.editRoles')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('settings.editRolesOf', { name: presentation.person(editing?.name ?? '') })}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t('actions.cancel')}</Button>
            <Button
              variant="primary"
              disabled={roles.length === 0}
              loading={save.isPending}
              onClick={() => editing && save.mutate({ id: editing.id, roleKeys: roles })}
            >
              {t('actions.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <RoleChecklist value={roles} onChange={setRoles} />
            <p className="text-xs text-slate-500">{t('settings.rolesHint')}</p>
            {save.isError ? <ProblemAlert error={save.error} /> : null}
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

function InvitationsCard() {
  const { t } = useT();
  const { orgId, organization } = useOrg();
  const presentation = usePresentation();
  const locale = useFormatLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<CreateInvitationResponse | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const invitations = useQuery({
    queryKey: keys.invitations(orgId),
    queryFn: ({ signal }) =>
      api.get(orgPath(orgId, '/invitations'), listOf(InvitationListItemSchema), { signal }),
  });
  const when = (iso: string) => formatDateTime(iso, organization.timezone, locale);

  return (
    <Card
      flush
      title={t('settings.invitations')}
      description={t('settings.invitationsHint')}
      actions={
        <Button size="sm" icon="user-plus" onClick={() => setInviting(true)}>
          {t('settings.inviteByEmail')}
        </Button>
      }
    >
      {created ? (
        <div
          className="m-4 flex flex-col gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4 sm:m-5"
          role="status"
        >
          <p className="text-sm font-medium text-indigo-950 dark:text-indigo-900">
            {t('settings.invite.codeOnce')}
          </p>
          {presentation.enabled ? (
            <p className="text-sm text-indigo-900">{t('presentation.codeHidden')}</p>
          ) : (
            <p className="font-mono text-2xl font-semibold tracking-widest text-indigo-900 select-all">
              {created.code}
            </p>
          )}
          <p className="text-xs text-indigo-900">
            {presentation.email(created.email)} ·{' '}
            {t('settings.invite.expires', { time: when(created.expiresAt) })}
          </p>
          <div className="flex gap-2">
            {presentation.enabled ? (
              <PresentationLock locked>
                <Button size="sm" disabled>
                  {t('settings.invite.copyCode')}
                </Button>
              </PresentationLock>
            ) : (
              <CopyButton size="sm" text={created.code} label={t('settings.invite.copyCode')} />
            )}
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              {t('settings.invite.done')}
            </Button>
          </div>
        </div>
      ) : null}
      {invitations.isPending ? (
        <div className="px-4 sm:px-5">
          <LoadingState />
        </div>
      ) : invitations.isError ? (
        <div className="px-4 sm:px-5">
          <ErrorState error={invitations.error} />
        </div>
      ) : invitations.data.items.length === 0 ? (
        <EmptyState bare icon="mail" title={t('settings.noInvitations')}>
          {t('settings.noInvitationsHint')}
        </EmptyState>
      ) : (
        <ul aria-label={t('settings.invitations')} className="divide-y divide-slate-100">
          {invitations.data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
            >
              <div className="min-w-0 flex-1 basis-44">
                <p className="truncate text-sm font-medium text-slate-900">
                  {presentation.email(item.email) ?? t('settings.openCode')}
                </p>
                <p className="text-xs text-slate-500">
                  {item.roleKeys.map((key) => t(`common:roleKey.${key}`)).join(', ')}
                </p>
              </div>
              <p className="text-xs text-slate-500 tabular-nums">
                {t('settings.expires')}: {when(item.expiresAt)} · {t('settings.uses')}: {item.uses}/
                {item.maxUses}
              </p>
              {item.revokedAt ? (
                <Badge tone="gray">{t('settings.invite.revoked')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="pointer-coarse:min-h-11"
                  onClick={() => setRevoking(item.id)}
                >
                  {t('settings.invite.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title={t('settings.inviteByEmail')}
        size="sm"
      >
        {inviting ? (
          <InviteByEmailForm
            onCancel={() => setInviting(false)}
            onCreated={(result) => {
              setInviting(false);
              setCreated(result);
              void invalidateOrg(queryClient, orgId, 'invitations');
            }}
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('settings.invite.revokeTitle')}
        confirmLabel={t('settings.invite.revoke')}
        tone="danger"
        onConfirm={async () => {
          await api.mutate('DELETE', orgPath(orgId, `/invitations/${revoking}`), {
            schema: InvitationListItemSchema,
          });
          toast.success(t('settings.invite.revokedToast'));
          await invalidateOrg(queryClient, orgId, 'invitations');
        }}
      >
        {t('settings.invite.revokeBody')}
      </ConfirmDialog>
    </Card>
  );
}

function InviteByEmailForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (result: CreateInvitationResponse) => void;
}) {
  const { t } = useT();
  const { orgId } = useOrg();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<RoleKey[]>(['manager']);
  const [errors, setErrors] = useState<FieldErrors>({});
  const intent = useIntentKey();
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.mutate('POST', orgPath(orgId, '/invitations'), {
        body,
        schema: CreateInvitationResponseSchema,
        idempotencyKey: intent.keyFor(body),
      }),
    onSuccess: (result) => {
      intent.reset();
      onCreated(result);
    },
    onError: (error) => setErrors(problemFieldErrors(error)),
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const body = { email: email.trim(), roleKeys: roles, maxUses: 1, expiresInHours: 72 };
        const checked = validateWith(t, CreateInvitationSchema, body);
        if (!checked.ok) return setErrors(checked.errors);
        setErrors({});
        create.mutate(body);
      }}
      noValidate
    >
      <p className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900">
        <Icon name="info" className="mt-px size-4 text-sky-600" strokeWidth={2} />
        {t('settings.inviteHint')}
      </p>
      <Field label={t('settings.email')} required error={errors['email']}>
        {(props) => (
          <Input {...props} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      <RoleChecklist value={roles} onChange={setRoles} />
      {errors['roleKeys'] ? <p className="text-xs text-red-700">{errors['roleKeys']}</p> : null}
      {create.isError ? <ProblemAlert error={create.error} /> : null}
      <DialogActions>
        <Button onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={roles.length === 0}
        >
          {t('settings.createInvitation')}
        </Button>
      </DialogActions>
    </form>
  );
}
