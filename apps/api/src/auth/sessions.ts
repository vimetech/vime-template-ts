import type { Auth } from './auth';

/**
 * Ends the Better Auth session a revoked device is bound to, so its token (even a copy of it) gets
 * a 401 on the next request. A device without a recorded session (registered before sessions were
 * bound to devices) ends every session of its user. Idempotent. Call it outside tenant
 * transactions: the auth tables belong to another role.
 */
export async function endDeviceSession(
  auth: Auth,
  binding: { userId: string; sessionId: string | null },
): Promise<void> {
  const { internalAdapter } = await auth.$context;
  if (binding.sessionId === null) {
    await internalAdapter.deleteUserSessions(binding.userId);
    return;
  }
  const sessions = await internalAdapter.listSessions(binding.userId);
  const session = sessions.find((item) => item.id === binding.sessionId);
  if (session) {
    await internalAdapter.deleteSession(session.token);
  }
}
