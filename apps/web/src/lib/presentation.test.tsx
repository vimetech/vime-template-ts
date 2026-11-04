import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_STORAGE_KEY,
  PresentationProvider,
  presentationFor,
  readPresentationMode,
  usePresentation,
} from './presentation';

describe('presentationFor', () => {
  it('returns every value as it is while the mode is off (blank → null)', () => {
    const off = presentationFor(false);
    expect(off.person('John Smith')).toBe('John Smith');
    expect(off.phone('+51987654321')).toBe('+51987654321');
    expect(off.phone('')).toBeNull();
    expect(off.email('john@example.com')).toBe('john@example.com');
    expect(off.email(null)).toBeNull();
    expect(off.text('john@example.com')).toBe('john@example.com');
  });

  it('masks people, phones, emails and free text while the mode is on', () => {
    const on = presentationFor(true);
    expect(on.person('Rosa Quispe')).toBe('Rosa Q.');
    expect(on.phone('+51987654321')).toBe('+••• ••• •••');
    expect(on.email('john@example.com')).toBe('j•••@e•••.com');
    expect(on.text('escribe a john@example.com')).toBe('escribe a j•••@e•••.com');
  });
});

describe('PresentationProvider', () => {
  it('remembers the mode in localStorage and follows other tabs', () => {
    window.localStorage.removeItem(PRESENTATION_STORAGE_KEY);
    const { result } = renderHook(() => usePresentation(), {
      wrapper: ({ children }) => <PresentationProvider>{children}</PresentationProvider>,
    });
    expect(result.current.enabled).toBe(false);
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(readPresentationMode()).toBe(true);
    act(() => {
      window.localStorage.removeItem(PRESENTATION_STORAGE_KEY);
      window.dispatchEvent(
        new StorageEvent('storage', { key: PRESENTATION_STORAGE_KEY, newValue: null }),
      );
    });
    expect(result.current.enabled).toBe(false);
  });
});
