import type { Account, User } from 'better-auth';

/*
 * User and credential helpers on Better Auth's internal adapter. Used by the inviteCode plugin, the
 * seed script and tests. Public sign-up is disabled (`emailAndPassword.disableSignUp`), so these
 * are the only ways users are created.
 */

/** The parts of Better Auth's context (`ctx.context` / `await auth.$context`) used here. */
export interface AuthUserStore {
  internalAdapter: {
    findUserByEmail(
      email: string,
      options?: { includeAccounts: boolean },
    ): Promise<{ user: User; accounts: Account[] } | null>;
    findUserById(userId: string): Promise<User | null>;
    createUser(
      user: { id?: string; email: string; name: string; emailVerified?: boolean },
      source: { method: string },
    ): Promise<User>;
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
      password?: string;
    }): Promise<Account>;
    findAccounts(userId: string): Promise<Account[]>;
    updatePassword(userId: string, password: string): Promise<void>;
  };
  password: {
    hash(password: string): Promise<string>;
    verify(data: { password: string; hash: string }): Promise<boolean>;
  };
}

/** Better Auth's provider id for email + password accounts. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Creates a user with an email + password (credential) account. The caller checks first that the
 * email is free (unique index `user_email_unique` otherwise).
 */
export async function createCredentialUser(
  store: AuthUserStore,
  input: { email: string; name: string; password: string; method?: string },
): Promise<User> {
  const hash = await store.password.hash(input.password);
  const user = await store.internalAdapter.createUser(
    { email: normalizeEmail(input.email), name: input.name, emailVerified: false },
    { method: input.method ?? 'admin' },
  );
  await store.internalAdapter.linkAccount({
    userId: user.id,
    providerId: CREDENTIAL_PROVIDER_ID,
    accountId: user.id,
    password: hash,
  });
  return user;
}

/** True when `password` matches the user's credential account (false without one). */
export async function verifyUserPassword(
  store: AuthUserStore,
  accounts: readonly Account[],
  password: string,
): Promise<boolean> {
  const credential = accounts.find((account) => account.providerId === CREDENTIAL_PROVIDER_ID);
  if (!credential?.password) {
    // Same work as a real check, so the response time does not reveal whether a password exists.
    await store.password.hash(password);
    return false;
  }
  return store.password.verify({ hash: credential.password, password });
}

/**
 * Idempotent: returns the user with `email`, creating it (with a credential account) when missing.
 * An existing user gets `password` set as its credential password (seeds keep documented
 * credentials valid).
 */
export async function ensureCredentialUser(
  store: AuthUserStore,
  input: { email: string; name: string; password: string },
): Promise<{ user: User; created: boolean }> {
  const existing = await store.internalAdapter.findUserByEmail(normalizeEmail(input.email), {
    includeAccounts: true,
  });
  if (!existing) {
    return { user: await createCredentialUser(store, input), created: true };
  }
  const hash = await store.password.hash(input.password);
  const hasCredential = existing.accounts.some(
    (account) => account.providerId === CREDENTIAL_PROVIDER_ID,
  );
  if (hasCredential) {
    await store.internalAdapter.updatePassword(existing.user.id, hash);
  } else {
    await store.internalAdapter.linkAccount({
      userId: existing.user.id,
      providerId: CREDENTIAL_PROVIDER_ID,
      accountId: existing.user.id,
      password: hash,
    });
  }
  return { user: existing.user, created: false };
}
