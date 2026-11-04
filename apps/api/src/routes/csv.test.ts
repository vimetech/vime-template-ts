import { ValidationError } from '@vime/kernel';
import { describe, expect, it } from 'vitest';
import { parseCsvRows } from './csv';

describe('parseCsvRows', () => {
  it('numbers rows by the line they start on (header = line 1)', () => {
    expect(parseCsvRows('code,name\nA,Alpha\nB,Beta').map((row) => row.line)).toEqual([2, 3]);
    // A quoted cell spanning lines (notes, cleaning instructions) does not shift the numbering.
    const multiline = parseCsvRows('code,name\nA,"Al\npha"\nB,Beta');
    expect(multiline.map((row) => [row.line, row.values.code])).toEqual([
      [2, 'A'],
      [4, 'B'],
    ]);
    expect(multiline[0]?.values.name).toBe('Al\npha');
    // Blank lines are skipped but still counted; CRLF files with LF inside a cell.
    expect(
      parseCsvRows('code;notes\r\n\r\nA;"one\ntwo\nthree"\r\nB;x\r\n').map((row) => row.line),
    ).toEqual([3, 6]);
  });

  it('rejects headers that only differ in case, spaces or dashes (400)', () => {
    for (const header of ['code,name,Name', 'code,public name,public_name', 'code,name,name']) {
      let error: unknown;
      try {
        parseCsvRows(`${header}\nA,first,second`);
      } catch (caught) {
        error = caught;
      }
      expect(error, header).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]).toMatchObject({
        path: 'csv',
        message: expect.stringContaining('Duplicate column'),
      });
    }
  });

  it('allows empty trailing headers and unknown columns', () => {
    const rows = parseCsvRows('code,name,team_size,,\nA,Alpha,3,,');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values).toMatchObject({ code: 'A', name: 'Alpha', team_size: '3' });
  });
});
