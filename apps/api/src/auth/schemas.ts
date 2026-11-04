import { RoleKeySchema, UserIdSchema, UuidSchema } from '@vime/contracts';
import { z } from 'zod';

/*
 * Request/response shapes of the auth endpoints the API documents in OpenAPI. Better Auth owns the
 * other /auth/* endpoints (get-session, sign-out, ...); see https://www.better-auth.com/docs.
 */

/** Response of POST /auth/invite/redeem. The token also arrives as `set-auth-token` and a cookie. */
export const RedeemInvitationResponseSchema = z.object({
  /** Session token: send it as `Authorization: Bearer <token>` (mobile). */
  token: z.string(),
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    /** Null for users that sign in with codes only (synthetic email). */
    email: z.email().nullable(),
  }),
  membership: z.object({
    id: UuidSchema,
    organizationId: UuidSchema,
    roleKeys: z.array(RoleKeySchema),
    /** False when the user was already an active member (invited roles merged into it). */
    created: z.boolean(),
  }),
});
export type RedeemInvitationResponse = z.infer<typeof RedeemInvitationResponseSchema>;

/** POST /auth/sign-in/email (Better Auth). Unknown members are passed through to Better Auth. */
export const SignInEmailRequestSchema = z.looseObject({
  email: z.email(),
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().optional(),
});

/** Better Auth's sign-in response (documentation only: the body is passed through unchanged). */
export const SignInEmailResponseSchema = z.looseObject({
  redirect: z.boolean(),
  token: z.string(),
  user: z.looseObject({
    id: UserIdSchema,
    name: z.string(),
    email: z.string(),
  }),
});
