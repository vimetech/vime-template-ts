import { useCallback, useRef } from 'react';

const randomKey = () => crypto.randomUUID();

/**
 * One Idempotency-Key per user intent. The API client already reuses a key across its own
 * automatic retries; this covers the person pressing the same button again after those ran out
 * (a lost response on a flaky connection): the same body resent gets the SAME key, so the server
 * replays the first outcome instead of applying the change twice. A different body gets a new key
 * (reusing one with another body is a 409 `idempotency_conflict`); include the path in what you
 * pass when one form can target several resources. Call `reset()` after a success so a later,
 * deliberate repeat of the same form is a new request.
 */
export function useIntentKey(newKey: () => string = randomKey) {
  const ref = useRef<{ key: string; body: string } | null>(null);
  const keyFor = useCallback(
    (body: unknown): string => {
      const serialized = JSON.stringify(body ?? null);
      if (ref.current?.body !== serialized) ref.current = { key: newKey(), body: serialized };
      return ref.current.key;
    },
    [newKey],
  );
  const reset = useCallback(() => {
    ref.current = null;
  }, []);
  return { keyFor, reset };
}
