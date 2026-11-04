import { ValidationError } from '@vime/kernel';
import { normalizeCsvHeader, type CsvRow } from '@vime/platform';
import { CsvError, parse } from 'csv-parse/sync';
import { z } from 'zod';

/** Largest accepted CSV upload (also the body limit of the `text/csv` parser). */
export const CSV_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
/** Most data rows per import. */
export const CSV_MAX_ROWS = 5000;

/**
 * Import body: the raw CSV with `Content-Type: text/csv`, or JSON `{ "csv": "..." }` (simpler for
 * browser clients that read a file into a string).
 */
export const CsvImportBodySchema = z.union([
  z.string().max(CSV_BODY_LIMIT_BYTES),
  z.object({ csv: z.string().max(CSV_BODY_LIMIT_BYTES) }),
]);
export type CsvImportBody = z.infer<typeof CsvImportBodySchema>;

const DELIMITERS = [',', ';', '\t'] as const;

/** Spreadsheets in es-PE often export with `;`: use whichever separator the header uses most. */
function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  let best: string = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = header.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

interface ParsedRecord {
  record: Record<string, string>;
  info: { lines: number };
}

/**
 * Header row → column names. Two headers that normalize alike (`name` and `Name`, `public name`
 * and `public_name`) would silently overwrite each other: a 400. Empty names (trailing delimiters
 * of spreadsheet exports) are allowed. Unknown columns are not checked here: the documented
 * exports carry columns the import ignores.
 */
function columnNames(header: string[]): string[] {
  const names = header.map((name) => name.trim());
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = normalizeCsvHeader(name);
    if (key === '') continue;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ValidationError([
        { path: 'csv', message: `Duplicate column "${name}" (same as "${first}")` },
      ]);
    }
    seen.set(key, name);
  }
  return names;
}

/** Line breaks inside a record's (quoted) cells; csv-parse counts each CR and each LF as a line. */
function lineBreaks(record: Record<string, string>): number {
  let count = 0;
  for (const cell of Object.values(record)) {
    count += cell.match(/[\r\n]/g)?.length ?? 0;
  }
  return count;
}

/**
 * Parses an import file into rows for the platform import services. The first line is the header
 * (column names; case, spaces and dashes do not matter, but two names that only differ in that are
 * a 400); empty lines are skipped; cells are trimmed; a UTF-8 BOM is ignored; the delimiter is `,`,
 * `;` or tab. A malformed file (unbalanced quotes, a row with a different number of cells) is a
 * 400 that names the line. Each row's `line` is the line its record STARTS on, also when a quoted
 * cell spans several lines.
 */
export function parseCsvRows(body: CsvImportBody): CsvRow[] {
  const text = typeof body === 'string' ? body : body.csv;
  if (text.trim() === '') {
    throw new ValidationError([{ path: 'csv', message: 'The file is empty' }]);
  }
  let records: ParsedRecord[];
  try {
    records = parse(text, {
      bom: true,
      columns: columnNames,
      delimiter: detectDelimiter(text),
      info: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown as ParsedRecord[];
  } catch (error) {
    if (error instanceof CsvError) {
      throw new ValidationError([{ path: 'csv', message: error.message }], 'Malformed CSV', {
        cause: error,
      });
    }
    throw error;
  }
  if (records.length === 0) {
    throw new ValidationError([{ path: 'csv', message: 'The file has a header but no rows' }]);
  }
  if (records.length > CSV_MAX_ROWS) {
    throw new ValidationError([
      { path: 'csv', message: `Too many rows: at most ${CSV_MAX_ROWS} per import` },
    ]);
  }
  // csv-parse's `info.lines` is the line a record ENDS on.
  return records.map(({ record, info }) => ({
    line: info.lines - lineBreaks(record),
    values: record,
  }));
}
