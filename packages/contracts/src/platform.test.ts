import { describe, expect, it } from 'vitest';
import { ID_1, ID_2, NOW, roundTrip } from './fixtures';
import {
  ActivityEventSchema,
  CreateInvitationResponseSchema,
  CreateInvitationSchema,
  CsvImportResultSchema,
  InvitationListItemSchema,
  ListFlagsQuerySchema,
  MeOrganizationSchema,
  MemberSchema,
  MeResponseSchema,
  OrganizationSchema,
  OrganizationSettingsSchema,
  OpsFlagSchema,
  PhoneE164Schema,
  RedeemInvitationRequestSchema,
  ResolveFlagSchema,
  UpdateMemberRolesSchema,
  UpdateOrganizationSchema,
  isFunctionOn,
} from './platform';

describe('PhoneE164Schema', () => {
  it.each(['+51987654321', '+14155552671', '+442071838750', '+1234567'])('accepts %s', (phone) => {
    expect(PhoneE164Schema.parse(phone)).toBe(phone);
  });

  it.each([
    '51987654321',
    '+51 987 654 321',
    '+51-987-654-321',
    '+0123456789',
    '+51',
    '+1234567890123456',
    '',
  ])('rejects %j', (phone) => {
    expect(PhoneE164Schema.safeParse(phone).success).toBe(false);
  });
});

describe('organizations', () => {
  it('fills settings defaults from an empty jsonb', () => {
    expect(OrganizationSettingsSchema.parse({})).toEqual({
      coordinationPhoneE164: null,
      disabledFunctions: [],
    });
  });

  it('round-trips an organization', () => {
    roundTrip(OrganizationSchema, {
      id: ID_1,
      name: 'Example Org',
      slug: 'example-org',
      timezone: 'America/Lima',
      locale: 'es-PE',
      settings: {
        coordinationPhoneE164: '+51987654321',
        disabledFunctions: ['example_notes'],
      },
      createdAt: NOW,
      updatedAt: null,
    });
  });

  it('patches settings without applying defaults', () => {
    expect(
      UpdateOrganizationSchema.parse({ settings: { coordinationPhoneE164: '+51987654321' } }),
    ).toEqual({
      settings: { coordinationPhoneE164: '+51987654321' },
    });
    expect(UpdateOrganizationSchema.parse({})).toEqual({});
    expect(UpdateOrganizationSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(UpdateOrganizationSchema.safeParse({ locale: 'fr' }).success).toBe(false);
  });

  it('takes a list of function names, each once (the server checks they are known)', () => {
    const patch = (disabledFunctions: unknown) =>
      UpdateOrganizationSchema.safeParse({ settings: { disabledFunctions } }).success;
    expect(patch([])).toBe(true);
    expect(patch(['example_notes'])).toBe(true);
    // A value this build does not know may be one the client sends back as it found it.
    expect(patch(['example_notes', 'future_thing'])).toBe(true);
    expect(patch(['example_notes', 'example_notes'])).toBe(false);
    expect(patch([''])).toBe(false);
    expect(patch('example_notes')).toBe(false);
  });

  it('never fails on a function it does not know, and treats it as nothing', () => {
    // A stored value or a newer server's /me may name a function this build does not know.
    const settings = OrganizationSettingsSchema.parse({ disabledFunctions: ['future_thing'] });
    expect(settings.disabledFunctions).toEqual(['future_thing']);
    expect(isFunctionOn(settings.disabledFunctions, 'example_notes')).toBe(true);
    const me = MeOrganizationSchema.parse({
      id: ID_1,
      name: 'Example Org',
      slug: 'example-org',
      timezone: 'America/Lima',
      locale: 'es-PE',
      disabledFunctions: ['example_notes', 'future_thing'],
    });
    expect(isFunctionOn(me.disabledFunctions, 'example_notes')).toBe(false);
  });

  it('has every function on when nothing says otherwise', () => {
    expect(isFunctionOn(undefined, 'example_notes')).toBe(true);
    expect(isFunctionOn(null, 'example_notes')).toBe(true);
    expect(isFunctionOn([], 'example_notes')).toBe(true);
  });
});

describe('MeResponseSchema', () => {
  it('round-trips an owner and a member without email', () => {
    roundTrip(MeResponseSchema, {
      user: { id: 'user_abc', name: 'Ana', email: 'ana@example.com' },
      memberships: [
        {
          organization: {
            id: ID_1,
            name: 'Example Org',
            slug: 'example-org',
            timezone: 'America/Lima',
            locale: 'es-PE',
          },
          roleKeys: ['owner'],
          permissions: ['org.manage', 'note.write'],
          features: ['example'],
        },
      ],
    });
    roundTrip(MeResponseSchema, {
      user: { id: 'user_def', name: 'Rosa' },
      memberships: [
        {
          organization: {
            id: ID_1,
            name: 'Example Org',
            slug: 'example-org',
            timezone: 'America/Lima',
            locale: 'es-PE',
          },
          roleKeys: ['member'],
          permissions: ['note.read'],
        },
      ],
    });
  });

  it('rejects unknown permissions', () => {
    const result = MeResponseSchema.safeParse({
      user: { id: 'u', name: 'X' },
      memberships: [
        {
          organization: { id: ID_1, name: 'O', slug: 'o', timezone: 'UTC', locale: 'en' },
          roleKeys: ['owner'],
          permissions: ['everything'],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('invitations and members', () => {
  it('applies invitation defaults and validates role keys', () => {
    expect(CreateInvitationSchema.parse({ roleKeys: ['member'] })).toEqual({
      roleKeys: ['member'],
      expiresInHours: 72,
      maxUses: 1,
    });
    expect(CreateInvitationSchema.safeParse({ roleKeys: [] }).success).toBe(false);
    expect(CreateInvitationSchema.safeParse({ roleKeys: ['root'] }).success).toBe(false);
    expect(CreateInvitationSchema.safeParse({ roleKeys: ['member', 'member'] }).success).toBe(
      false,
    );
  });

  it('binds an invitation to an email only for a single use', () => {
    expect(
      CreateInvitationSchema.parse({ roleKeys: ['manager'], email: 'ana@example.com' }),
    ).toMatchObject({ email: 'ana@example.com', maxUses: 1 });
    const multi = CreateInvitationSchema.safeParse({
      roleKeys: ['manager'],
      email: 'ana@example.com',
      maxUses: 5,
    });
    expect(multi.success).toBe(false);
    expect(multi.error?.issues[0]?.path).toEqual(['maxUses']);
    expect(
      CreateInvitationSchema.safeParse({ roleKeys: ['member'], email: 'not-an-email' }).success,
    ).toBe(false);
  });

  const listItem = {
    id: ID_1,
    roleKeys: ['member' as const],
    email: null,
    expiresAt: NOW,
    maxUses: 1,
    uses: 0,
    revokedAt: null,
    createdBy: 'user_abc',
    createdAt: NOW,
  };

  it('returns the code only in the creation response', () => {
    roundTrip(CreateInvitationResponseSchema, { ...listItem, code: 'K7Q2-9XMP' });
    expect(InvitationListItemSchema.parse({ ...listItem, code: 'K7Q2-9XMP' })).not.toHaveProperty(
      'code',
    );
    roundTrip(InvitationListItemSchema, listItem);
  });

  it('redeems with a code alone; email and password go together', () => {
    expect(RedeemInvitationRequestSchema.parse({ code: ' K7Q2-9XMP ' })).toEqual({
      code: 'K7Q2-9XMP',
    });
    expect(RedeemInvitationRequestSchema.safeParse({ code: '' }).success).toBe(false);
    expect(
      RedeemInvitationRequestSchema.safeParse({ code: 'K7Q2', password: 'secret-pass' }).success,
    ).toBe(false);
    // An email without a password would create a user that can never sign in.
    const emailOnly = RedeemInvitationRequestSchema.safeParse({
      code: 'K7Q2',
      email: 'ana@example.com',
    });
    expect(emailOnly.success).toBe(false);
    expect(emailOnly.error?.issues[0]?.path).toEqual(['password']);
    expect(
      RedeemInvitationRequestSchema.safeParse({
        code: 'K7Q2',
        name: 'Ana',
        email: 'ana@example.com',
        password: 'secret-pass',
      }).success,
    ).toBe(true);
  });

  it('round-trips a member and validates role updates', () => {
    roundTrip(MemberSchema, {
      id: ID_1,
      userId: 'user_abc',
      name: 'Ana',
      email: null,
      roleKeys: ['manager', 'member'],
      status: 'active',
      createdAt: NOW,
      updatedAt: null,
    });
    expect(UpdateMemberRolesSchema.parse({ roleKeys: ['admin'] })).toEqual({ roleKeys: ['admin'] });
    expect(UpdateMemberRolesSchema.safeParse({ roleKeys: [] }).success).toBe(false);
  });
});

describe('activity events and CSV import', () => {
  it('round-trips an activity event', () => {
    roundTrip(ActivityEventSchema, {
      id: ID_1,
      actorUserId: 'user_abc',
      source: 'web',
      entityType: 'note',
      entityId: ID_2,
      eventType: 'note.created',
      payload: { title: 'Hello' },
      clientOccurredAt: '2026-10-04T09:59:00-05:00',
      occurredAt: NOW,
      recordedAt: NOW,
      requestId: 'req-1',
      idempotencyKey: ID_1,
    });
  });

  it('round-trips a CSV import result', () => {
    roundTrip(CsvImportResultSchema, {
      created: 3,
      updated: 1,
      errors: [{ row: 5, message: 'Invalid timezone' }],
    });
    expect(CsvImportResultSchema.safeParse({ created: -1, updated: 0, errors: [] }).success).toBe(
      false,
    );
  });
});

describe('ops flags', () => {
  it('round-trips an open and a resolved flag', () => {
    const flag = {
      id: ID_1,
      kind: 'example_needs_review' as const,
      severity: 'warning' as const,
      status: 'open' as const,
      entityType: 'note',
      entityId: ID_2,
      details: { reason: 'empty body' },
      resolvedAt: null,
      resolvedBy: null,
      createdAt: NOW,
      updatedAt: null,
    };
    roundTrip(OpsFlagSchema, flag);
    roundTrip(OpsFlagSchema, {
      ...flag,
      status: 'resolved',
      resolvedAt: NOW,
      resolvedBy: 'user_abc',
    });
    expect(OpsFlagSchema.safeParse({ ...flag, kind: 'something_new' }).success).toBe(false);
  });

  it('lists the open queue by default', () => {
    expect(ListFlagsQuerySchema.parse({})).toEqual({ status: 'open' });
    expect(
      ListFlagsQuerySchema.parse({ status: 'dismissed', kind: 'example_needs_review' }),
    ).toEqual({
      status: 'dismissed',
      kind: 'example_needs_review',
    });
    expect(ListFlagsQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('resolves or dismisses, never reopens', () => {
    expect(ResolveFlagSchema.parse({ status: 'dismissed', note: ' No aplica ' })).toEqual({
      status: 'dismissed',
      note: 'No aplica',
    });
    expect(ResolveFlagSchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(ResolveFlagSchema.safeParse({}).success).toBe(false);
  });
});
