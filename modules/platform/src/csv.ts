import { DomainError, ValidationError } from '@vime/kernel';
import { isIntegrityViolation, pgError } from './errors';

/**
 * One parsed CSV record, as the API hands it to the import services (it parses the file; this
 * module validates and applies the rows).
 */
export interface CsvRow {
  /** 1-based line number in the file, header included (the first data row is 2). */
  line: number;
  /**
   * Cells by header. Headers match case-insensitively; spaces and dashes count as `_`
   * (`normalizeCsvHeader`). The parser rejects headers that normalize alike, so none is lost.
   */
  values: Readonly<Record<string, string | undefined>>;
}

/** A problem with one row; becomes a `CsvImportError` and the row is skipped. */
export class CsvRowError extends Error {
  override name = 'CsvRowError';
}

/**
 * Canonical form of a CSV column name: trimmed, lowercase, runs of spaces and dashes as `_`
 * (`Public Name`, `public-name` and `public_name` are the same column).
 */
export function normalizeCsvHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Read access to one row's cells; empty cells read as undefined (field not provided). */
export class CsvCells {
  private readonly cells = new Map<string, string>();

  constructor(row: CsvRow) {
    for (const [header, value] of Object.entries(row.values)) {
      const trimmed = value?.trim();
      if (trimmed) {
        this.cells.set(normalizeCsvHeader(header), trimmed);
      }
    }
  }

  text(column: string): string | undefined {
    return this.cells.get(column);
  }

  number(column: string): number | undefined {
    const value = this.text(column);
    if (value === undefined) return undefined;
    const parsed = Number(value.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      throw new CsvRowError(`${column}: expected a number, got "${value}"`);
    }
    return parsed;
  }

  boolean(column: string): boolean | undefined {
    const value = this.text(column)?.toLowerCase();
    if (value === undefined) return undefined;
    if (['true', '1', 'yes', 'y', 'si', 'sí', 's'].includes(value)) return true;
    if (['false', '0', 'no', 'n'].includes(value)) return false;
    throw new CsvRowError(`${column}: expected true/false (sí/no), got "${value}"`);
  }
}

/**
 * The CsvImportError message for a failed row, or undefined when `error` is not a row-level
 * problem (then the import must fail as a whole). `fieldToColumn` maps contract field names in
 * validation paths back to CSV column names.
 */
export function csvRowErrorMessage(
  error: unknown,
  fieldToColumn: Readonly<Record<string, string>>,
): string | undefined {
  if (error instanceof CsvRowError) {
    return error.message;
  }
  if (error instanceof ValidationError) {
    return error.issues
      .map((issue) => {
        const field = issue.path.split('.')[0] ?? '';
        const column = fieldToColumn[field] ?? issue.path;
        return column ? `${column}: ${issue.message}` : issue.message;
      })
      .join('; ');
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  if (isIntegrityViolation(error)) {
    const pg = pgError(error);
    return `Rejected by the database (${pg?.constraint ?? pg?.code ?? 'constraint'})`;
  }
  return undefined;
}
