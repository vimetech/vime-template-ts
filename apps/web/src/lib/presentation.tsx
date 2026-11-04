import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useT } from './i18n-hook';
import { maskEmail, maskFreeText, maskPersonName, maskPhone } from './masking';

/*
 * Presentation mode ("Modo presentación"): a per-browser switch in the header that masks personal
 * data everywhere on screen (see lib/masking.ts). Every component that shows a phone, a person's
 * full name, an email or an invitation code reads it through `usePresentation()`; nothing masks on
 * its own. Remembered in localStorage (a preference
 * of this browser, like the language), and synchronized between open tabs.
 */

export const PRESENTATION_STORAGE_KEY = 'vime.presentationMode';

export function readPresentationMode(): boolean {
  try {
    return window.localStorage.getItem(PRESENTATION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storePresentationMode(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(PRESENTATION_STORAGE_KEY, '1');
    else window.localStorage.removeItem(PRESENTATION_STORAGE_KEY);
  } catch {
    // Storage disabled (private mode): the mode lasts until the page is reloaded.
  }
}

export interface Presentation {
  /** True while presentation mode is on. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** A person's name (first name + initial while on). */
  person: (name: string) => string;
  /** A phone number (hidden while on); null stays null. */
  phone: (phone: string | null | undefined) => string | null;
  /** An email (masked while on); null stays null. */
  email: (email: string | null | undefined) => string | null;
  /** Free text (emails and phone numbers in it masked while on). */
  text: (text: string) => string;
}

interface PresentationState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const OFF: PresentationState = { enabled: false, setEnabled: () => undefined };

const PresentationContext = createContext<PresentationState>(OFF);

/** Holds the mode for the whole app (mounted once, above the router). */
export function PresentationProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Starting value (tests); defaults to the stored preference. */
  initial?: boolean;
}) {
  const [enabled, setState] = useState<boolean>(() => initial ?? readPresentationMode());
  const setEnabled = useCallback((next: boolean) => {
    storePresentationMode(next);
    setState(next);
  }, []);
  useEffect(() => {
    // Another tab switched it: follow, so no tab keeps showing data the presenter hid.
    const onStorage = (event: StorageEvent) => {
      if (event.key === PRESENTATION_STORAGE_KEY) setState(event.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

/** Builds the maskers for a mode (exported for tests and non-React helpers). */
export function presentationFor(
  enabled: boolean,
  setEnabled: (enabled: boolean) => void = () => undefined,
): Presentation {
  if (!enabled) {
    return {
      enabled,
      setEnabled,
      person: (name) => name,
      phone: (phone) => (phone === undefined || phone === null || phone === '' ? null : phone),
      email: (email) => (email === undefined || email === null || email === '' ? null : email),
      text: (text) => text,
    };
  }
  return {
    enabled,
    setEnabled,
    person: maskPersonName,
    phone: maskPhone,
    email: maskEmail,
    text: maskFreeText,
  };
}

/**
 * The presentation mode and its maskers. Outside a provider (unit tests of a component) the mode
 * is off and every masker returns its input.
 */
export function usePresentation(): Presentation {
  const { enabled, setEnabled } = useContext(PresentationContext);
  return useMemo(() => presentationFor(enabled, setEnabled), [enabled, setEnabled]);
}

/**
 * Wraps an action that presentation mode turns off (export, print, copy): the disabled
 * control keeps a tooltip that says why (a disabled button alone shows no tooltip in some
 * browsers).
 */
export function PresentationLock({ locked, children }: { locked: boolean; children: ReactNode }) {
  const { t } = useT();
  if (!locked) return <>{children}</>;
  return (
    <span className="inline-flex" title={t('presentation.disabledHint')}>
      {children}
    </span>
  );
}
