import { describe, expect, it } from 'vitest';
import { MASK, initials, maskEmail, maskFreeText, maskPersonName, maskPhone } from './masking';

describe('masking', () => {
  it('reduces a name to initials', () => {
    expect(initials('María José López Torres')).toBe('M·T');
    expect(initials('Rosa')).toBe('R');
    expect(initials('  ángel  ')).toBe('Á');
    expect(initials('')).toBe('');
  });

  it('keeps the first name of a person and the initial of the last word', () => {
    expect(maskPersonName('Rosa Quispe Huamán')).toBe('Rosa H.');
    expect(maskPersonName('Rosa')).toBe('Rosa');
    expect(maskPersonName('')).toBe('');
  });

  it('hides phone numbers whole and masks emails to their initials', () => {
    expect(maskPhone('+51 987 654 321')).toBe(`+${MASK} ${MASK} ${MASK}`);
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('  ')).toBeNull();
    expect(maskEmail('jmena.t@gmail.com')).toBe('j•••@g•••.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b•••.co');
    expect(maskEmail('not an email')).toBe(MASK);
    expect(maskEmail(undefined)).toBeNull();
  });

  it('masks emails and phone numbers inside free text, leaving dates and amounts alone', () => {
    expect(maskFreeText('Llamar a Ana al 987 654 321 o escribir a ana@example.com')).toBe(
      `Llamar a Ana al +${MASK} ${MASK} ${MASK} o escribir a a•••@e•••.com`,
    );
    expect(maskFreeText('Entrega el 2026-10-10 a las 14:30, S/ 1,250.00')).toBe(
      'Entrega el 2026-10-10 a las 14:30, S/ 1,250.00',
    );
    expect(maskFreeText('+51987654321')).toBe(`+${MASK} ${MASK} ${MASK}`);
  });
});
