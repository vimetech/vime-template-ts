/*
 * Presentation-mode masking (pure functions). When someone shows the app with real data (a demo,
 * a shared screen), personal data must not be readable: people keep their first name and a
 * last-name initial, phone numbers and emails are masked. Components never mask ad hoc: they go
 * through `usePresentation()` (lib/presentation.tsx), which applies these functions only while the
 * mode is on. A feature with other personal fields adds its masker here.
 *
 * The masking is cosmetic (the data is still in the browser's memory); it protects a screen,
 * not a device.
 */

/** Placeholder of a hidden value. */
export const MASK = '•••';

function words(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

/** First letter of a word, uppercase (keeps letters with accents: "Ángel" → "Á"). */
function initialOf(word: string): string {
  return Array.from(word)[0]?.toLocaleUpperCase('es-PE') ?? '';
}

/**
 * Initials of a person: first and last word ("María José López Torres" → "M·T", "Rosa" → "R").
 * Empty for a blank name.
 */
export function initials(name: string): string {
  const parts = words(name);
  const first = parts[0];
  if (first === undefined) return '';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last === undefined ? initialOf(first) : `${initialOf(first)}·${initialOf(last)}`;
}

/**
 * A person's name → first name + initial of the last word ("Rosa Quispe Huamán" → "Rosa H.";
 * "Rosa" → "Rosa"). The first name is enough to coordinate on screen.
 */
export function maskPersonName(name: string): string {
  const parts = words(name);
  const first = parts[0];
  if (first === undefined) return name;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last === undefined ? first : `${first} ${initialOf(last)}.`;
}

/** A phone number is hidden entirely (no digits at all: they identify the person). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined || phone.trim() === '') return null;
  return `+${MASK} ${MASK} ${MASK}`;
}

/**
 * An email → first letter of the mailbox and of the domain, plus the top-level domain
 * ("jmena.t@gmail.com" → "j•••@g•••.com"). Anything that is not an email is masked whole.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === '') return null;
  const match = /^([^@\s]+)@([^@\s]+?)(\.[^.@\s]+)?$/.exec(email.trim());
  if (!match) return MASK;
  const [, local = '', domain = '', tld = ''] = match;
  return `${Array.from(local)[0] ?? ''}${MASK}@${Array.from(domain)[0] ?? ''}${MASK}${tld}`;
}

const EMAIL_IN_TEXT = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[A-Za-z]{2,}/g;
/** Candidate phone numbers in free text: digits with spaces, dots, dashes or parentheses. */
const PHONE_IN_TEXT = /\+?\(?\d[\d\s().-]{5,}\d/g;

/**
 * Free text (notes, descriptions) with the emails and phone numbers in it masked. A phone is a run
 * of at least 9 digits (Peruvian mobiles have 9; with a `+`, 8), so dates (`2026-10-10`), times and
 * amounts are left alone.
 */
export function maskFreeText(text: string): string {
  return text
    .replace(EMAIL_IN_TEXT, (email) => maskEmail(email) ?? MASK)
    .replace(PHONE_IN_TEXT, (candidate) => {
      const digits = candidate.replace(/\D/g, '').length;
      const minimum = candidate.startsWith('+') ? 8 : 9;
      return digits >= minimum ? (maskPhone(candidate) ?? MASK) : candidate;
    });
}
