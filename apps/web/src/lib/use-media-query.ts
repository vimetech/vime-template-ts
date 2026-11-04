import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, live (it follows rotation and window resizes). Without
 * `matchMedia` (tests, old browsers) it never matches.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const snapshot = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * A narrow viewport (below Tailwind's `md`, 768 px): a phone, or a small window. The layout
 * follows the width, not the device: a tablet or a wide phone in landscape gets the desktop view.
 */
export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 767.98px)');
}
