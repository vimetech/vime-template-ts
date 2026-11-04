import { RedeemInvitationRequestSchema, type RedeemInvitationRequest } from '@vime/contracts';
import { withSystem, withTenant } from '@vime/db';
import { ValidationError, newId } from '@vime/kernel';
import {
  IdempotencyConflictError,
  beginIdempotentRequest,
  completeIdempotentRequest,
  computeRequestHash,
  consumeInvitation,
  findCompletedRedemption,
  findRedeemableInvitationByCode,
  invitationRedeemActorKey,
  isSyntheticEmail,
  normalizeInvitationCode,
  syntheticStaffEmail,
  type ActorContext,
  type ConsumedInvitation,
  type RedeemableInvitation,
} from '@vime/platform';
import type { BetterAuthPlugin, User } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { hkdfSync } from 'node:crypto';
import { parseIdempotencyKey } from '../context/idempotency';
import {
  APP_VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  activitySourceFor,
} from '../http/client-info';
import { UnauthenticatedError } from '../http/problem';
import type { RedeemInvitationResponse } from './schemas';
import {
  createCredentialUser,
  normalizeEmail,
  verifyUserPassword,
  type AuthUserStore,
} from './users';

/** Path of the redeem endpoint under the Better Auth base path (`/auth`). */
export const REDEEM_INVITATION_PATH = '/invite/redeem';

/**
 * HMAC key of invitation codes (`hashInvitationCode`), derived from BETTER_AUTH_SECRET so it lives
 * outside the database: a dump alone does not reveal the codes. Rotating that secret makes the
 * outstanding codes unredeemable (create new ones).
 */
export function deriveInvitationCodeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', 'vime:invitation-code', 32));
}

export interface InviteCodeOptions {
  /** Called after a membership was created or changed (the API drops its membership cache). */
  onMembershipChanged?: (change: { userId: string; orgId: string }) => void;
}

type FoundInvitation = RedeemableInvitation;

const INVALID_CODE_MESSAGE = 'Invalid or expired invitation code';
const NOT_FOR_THIS_EMAIL = 'This invitation is not for this email';

function invalidCode(): ValidationError {
  return new ValidationError(
    [{ path: 'code', message: INVALID_CODE_MESSAGE }],
    INVALID_CODE_MESSAGE,
  );
}

/**
 * Looks the code up through withSystem: the redeemer has no organization (and maybe no user) yet,
 * and the lookup is by exact code hash only.
 */
async function findInvitation(code: string, codeKey: Uint8Array): Promise<FoundInvitation | null> {
  return withSystem((tx) => findRedeemableInvitationByCode(tx, code, codeKey));
}

/** How the redeemer proved who they are. An Idempotency-Key replay must prove it again. */
type RedeemProof = 'session' | 'password' | 'code';

interface RedeemingUser {
  user: User;
  /** True when this request created the user (deleted again if redeeming fails). */
  created: boolean;
  proof: RedeemProof;
}

/** ValidationError on `email` unless the invitation is unbound or bound to `email`. */
function assertInvitedEmail(invitation: FoundInvitation, email: string): void {
  if (invitation.email !== null && normalizeEmail(email) !== invitation.email) {
    throw new ValidationError([{ path: 'email', message: NOT_FOR_THIS_EMAIL }], NOT_FOR_THIS_EMAIL);
  }
}

/**
 * Who redeems the invitation, in order of precedence:
 * 1. the signed-in user, when the request carries a session (an existing member joining another
 *    organization, or getting more roles);
 * 2. with `email` + `password`: the existing user with that email (the password must match), or a
 *    new credential user, only when the invitation is bound to that email;
 * 3. otherwise a new passwordless user with the synthetic email `u_<userId>@staff.invalid`, who can
 *    only sign in with invitation codes (never for an invitation bound to an email).
 * An invitation bound to an email is only for the user with that email (400 on `email`).
 */
async function resolveRedeemingUser(
  store: AuthUserStore,
  sessionUser: User | null,
  invitation: FoundInvitation,
  body: RedeemInvitationRequest,
): Promise<RedeemingUser> {
  if (sessionUser) {
    assertInvitedEmail(invitation, sessionUser.email);
    return { user: sessionUser, created: false, proof: 'session' };
  }
  if (body.email !== undefined) {
    if (body.password === undefined) {
      throw new ValidationError([
        { path: 'password', message: 'Email and password must be sent together' },
      ]);
    }
    const email = normalizeEmail(body.email);
    assertInvitedEmail(invitation, email);
    const existing = await store.internalAdapter.findUserByEmail(email, { includeAccounts: true });
    if (existing) {
      if (!(await verifyUserPassword(store, existing.accounts, body.password))) {
        throw new UnauthenticatedError('Invalid email or password');
      }
      return { user: existing.user, created: false, proof: 'password' };
    }
    // Nobody proved they own this address: only the invitation's creator chose it.
    if (invitation.email !== email) {
      throw new ValidationError(
        [{ path: 'email', message: NOT_FOR_THIS_EMAIL }],
        NOT_FOR_THIS_EMAIL,
      );
    }
    const name = body.name ?? email.split('@')[0] ?? email;
    const user = await createCredentialUser(store, {
      email,
      name,
      password: body.password,
      method: 'invite-code',
    });
    return { user, created: true, proof: 'password' };
  }
  if (invitation.email !== null) {
    throw new ValidationError(
      [{ path: 'email', message: 'Sign in with the invited email and a password' }],
      'This invitation is for an email: send it with a password',
    );
  }
  const id = newId();
  const user = await store.internalAdapter.createUser(
    {
      id,
      email: syntheticStaffEmail(id),
      name: body.name ?? 'Member',
      emailVerified: false,
    },
    { method: 'invite-code' },
  );
  return { user, created: true, proof: 'code' };
}

/**
 * What a completed redemption stores under its Idempotency-Key (`idempotency_keys.response`): the
 * response body without the session token (a replay creates a new session), and how the redeemer
 * proved who they were.
 */
interface StoredRedemption {
  proof: RedeemProof;
  user: RedeemInvitationResponse['user'];
  membership: RedeemInvitationResponse['membership'];
}

/**
 * Request identity for Idempotency-Key checks: the normalized code, name and email. Never the
 * password (no fast hash of a password is kept); a replay verifies the password again instead.
 */
function redeemRequestHash(body: RedeemInvitationRequest, requestHashKey: Uint8Array): string {
  return computeRequestHash(
    {
      method: 'POST',
      path: `/auth${REDEEM_INVITATION_PATH}`,
      body: {
        code: normalizeInvitationCode(body.code),
        name: body.name ?? null,
        email: body.email === undefined ? null : normalizeEmail(body.email),
      },
    },
    requestHashKey,
  );
}

/**
 * Checks that the retry comes from whoever made the stored redemption (same session user, or the
 * same email + password again; a code-only redemption needs nothing more) and returns that user.
 */
async function verifyReplayingUser(
  store: AuthUserStore,
  stored: StoredRedemption,
  sessionUser: User | null,
  body: RedeemInvitationRequest,
): Promise<User> {
  if (stored.proof === 'session' && sessionUser?.id !== stored.user.id) {
    throw new UnauthenticatedError('Sign in as the user who redeemed this invitation');
  }
  if (stored.proof === 'password') {
    const found =
      body.email === undefined
        ? null
        : await store.internalAdapter.findUserByEmail(normalizeEmail(body.email), {
            includeAccounts: true,
          });
    const valid =
      found !== null &&
      found.user.id === stored.user.id &&
      body.password !== undefined &&
      (await verifyUserPassword(store, found.accounts, body.password));
    if (!valid) {
      throw new UnauthenticatedError('Invalid email or password');
    }
  }
  const user = await store.internalAdapter.findUserById(stored.user.id);
  if (!user) {
    throw invalidCode();
  }
  return user;
}

/**
 * Better Auth plugin `inviteCode` (ADR 0005): `POST /auth/invite/redeem` with `{ code, name?,
 * email?, password? }` (RedeemInvitationRequestSchema) and an optional `Idempotency-Key`.
 *
 * Validates the code (withSystem lookup by its keyed hash), finds or creates the user (see
 * `resolveRedeemingUser`), then in ONE withTenant transaction of the invitation's organization
 * claims the Idempotency-Key, takes a use of the invitation, creates the membership (or merges the
 * invited roles into an existing active one), records the activity events (`consumeInvitation`)
 * and stores the response for replays (without the token). Finally it creates a session and returns it: session cookie, the `set-auth-token` header (bearer plugin) and
 * `token` in the body. A user created by this request is deleted again when the redemption fails.
 *
 * Idempotency-Key (scoped per invitation): an identical retry of a completed redemption, while the
 * code is still valid (it may be used up by that redemption), replays it with a NEW session and
 * `Idempotent-Replayed: true`, after the redeemer proves who they are again (same session user, or
 * the password). The same key with a different request is a 409 `idempotency_conflict`.
 *
 * Errors are domain errors (the API turns them into problem+json): an unknown, expired, revoked or
 * used-up code is a 400 on `code` (never says which); a wrong password for an existing email is a
 * 401; an email the invitation is not for is a 400 on `email`; a suspended membership is a 409.
 */
export function inviteCode(
  keys: { codeKey: Uint8Array; requestHashKey: Uint8Array },
  options: InviteCodeOptions = {},
) {
  const { codeKey, requestHashKey } = keys;
  return {
    id: 'invite-code',
    endpoints: {
      redeemInvitation: createAuthEndpoint(
        REDEEM_INVITATION_PATH,
        { method: 'POST', body: RedeemInvitationRequestSchema },
        async (ctx) => {
          const body = ctx.body;
          const headers = ctx.request?.headers ?? ctx.headers;
          const key = parseIdempotencyKey(headers?.get(IDEMPOTENCY_KEY_HEADER) ?? undefined);
          const requestHash = redeemRequestHash(body, requestHashKey);
          const store: AuthUserStore = ctx.context;
          const current = await getSessionFromCtx(ctx, { disableRefresh: true });
          const sessionUser = current?.user ?? null;

          /** Answers with a new session for the stored redemption (Idempotency-Key replay). */
          const replay = async (stored: StoredRedemption) => {
            const user = await verifyReplayingUser(store, stored, sessionUser, body);
            const session = await ctx.context.internalAdapter.createSession(user.id);
            if (!session) {
              throw APIError.fromStatus('INTERNAL_SERVER_ERROR', {
                message: 'Could not create a session',
              });
            }
            await setSessionCookie(ctx, { session, user });
            ctx.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
            const response: RedeemInvitationResponse = {
              token: session.token,
              user: stored.user,
              membership: stored.membership,
            };
            return ctx.json(response);
          };

          const invitation = await findInvitation(body.code, codeKey);
          if (!invitation) {
            // A retry whose first attempt used the code up: replay it. Looked up only now, so a
            // first attempt that commits after `findInvitation` is caught by the key claim below.
            const completed =
              key === null
                ? null
                : await withSystem((tx) => findCompletedRedemption(tx, body.code, codeKey, key));
            if (!completed) {
              throw invalidCode();
            }
            if (completed.requestHash !== requestHash) {
              throw new IdempotencyConflictError();
            }
            return replay(completed.response as StoredRedemption);
          }

          const { user, created, proof } = await resolveRedeemingUser(
            store,
            sessionUser,
            invitation,
            body,
          );
          const actor: ActorContext = {
            orgId: invitation.organizationId,
            userId: user.id,
            source: activitySourceFor(headers?.get(APP_VERSION_HEADER) ?? null),
            requestId: headers?.get('x-request-id') ?? null,
            idempotencyKey: key,
          };
          const keyRef =
            key === null ? null : { actorKey: invitationRedeemActorKey(invitation.id), key };
          let outcome:
            | { replayed: true; stored: StoredRedemption }
            | { replayed: false; consumed: ConsumedInvitation };
          try {
            outcome = await withTenant(
              { orgId: invitation.organizationId, userId: user.id },
              async (tx) => {
                if (keyRef) {
                  const begin = await beginIdempotentRequest(tx, invitation.organizationId, {
                    ...keyRef,
                    requestHash,
                  });
                  if (begin.status === 'replay') {
                    return { replayed: true, stored: begin.response as StoredRedemption };
                  }
                }
                const consumed = await consumeInvitation(tx, actor, {
                  invitationId: invitation.id,
                  userId: user.id,
                });
                if (keyRef) {
                  const stored: StoredRedemption = {
                    proof,
                    user: publicUser(user),
                    membership: membershipOf(consumed),
                  };
                  await completeIdempotentRequest(tx, {
                    ...keyRef,
                    statusCode: 200,
                    response: stored,
                  });
                }
                return { replayed: false, consumed };
              },
            );
          } catch (error) {
            if (created) {
              await deleteCreatedUser(ctx.context, user.id);
            }
            throw error;
          }
          if (outcome.replayed) {
            // A concurrent identical request completed first.
            if (created) {
              await deleteCreatedUser(ctx.context, user.id);
            }
            return replay(outcome.stored);
          }
          options.onMembershipChanged?.({ userId: user.id, orgId: invitation.organizationId });

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw APIError.fromStatus('INTERNAL_SERVER_ERROR', {
              message: 'Could not create a session',
            });
          }
          await setSessionCookie(ctx, { session, user });
          const response: RedeemInvitationResponse = {
            token: session.token,
            user: publicUser(user),
            membership: membershipOf(outcome.consumed),
          };
          return ctx.json(response);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

function publicUser(user: User): RedeemInvitationResponse['user'] {
  return {
    id: user.id,
    name: user.name,
    email: isSyntheticEmail(user.email) ? null : user.email,
  };
}

function membershipOf(consumed: ConsumedInvitation): RedeemInvitationResponse['membership'] {
  return {
    id: consumed.membership.membershipId,
    organizationId: consumed.membership.organizationId,
    roleKeys: consumed.membership.roleKeys,
    created: consumed.membershipCreated,
  };
}

async function deleteCreatedUser(
  context: {
    internalAdapter: { deleteUser(userId: string): Promise<unknown> };
    logger: { error(message: string, ...args: unknown[]): void };
  },
  userId: string,
): Promise<void> {
  await context.internalAdapter.deleteUser(userId).catch((cleanupError: unknown) => {
    context.logger.error('Could not delete the user of a failed redemption', cleanupError);
  });
}
