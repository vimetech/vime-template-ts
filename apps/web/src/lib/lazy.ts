import { lazy, type ComponentType } from 'react';

/*
 * Code loaded on demand after a deploy: the image only has the new hashed files, so a tab opened
 * before it asks for chunks that no longer exist (404) and `import()` rejects. Route pages already
 * reload once on that (TanStack's lazyRouteComponent); these helpers do the same for the rest
 * (dialogs, the auth client, the English catalog). One reload per minute at most, so a chunk
 * that is really broken shows its error instead of looping.
 *
 * No global `vite:preloadError` listener: Vite fires it for hover and idle preloads too, so it
 * would reload the page with no click (and lose what the person was typing), and cancelling it
 * makes the failed `import()` resolve to `undefined` instead of rejecting.
 */

const RELOAD_KEY = 'vime.chunkReloadAt';
const RELOAD_GUARD_MS = 60_000;

/** The browser could not fetch or evaluate a lazily loaded module (Chromium, Firefox, Safari). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    message,
  );
}

/** Reloads the page unless it already did in the last minute; true when it reloads. */
export function reloadOnce(now: () => number = Date.now): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * `load()`, but a chunk that is gone after a deploy reloads the page (once) instead of failing:
 * the returned promise then never settles, the page is already going away.
 */
export async function importOrReload<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isChunkLoadError(error) && reloadOnce()) return new Promise<T>(() => undefined);
    throw error;
  }
}

/** `React.lazy` with `importOrReload` (for components mounted on demand inside a page). */
export function lazyOrReload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ReturnType<typeof lazy<ComponentType<P>>> {
  return lazy(() => importOrReload(load));
}

/** Warms a lazy module (hover, idle) without surfacing a failure: the real load handles it. */
export function preload(load: () => Promise<unknown>): void {
  void load().catch(() => undefined);
}
