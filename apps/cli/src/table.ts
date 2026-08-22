/**
 * Plain text tables.
 *
 * No box-drawing characters, no colour inside a cell, and columns separated by two spaces. The
 * output of `recueil import` is a thing people paste into a migration log and read six months
 * later on a terminal that may not be a terminal; anything more decorative survives that journey
 * badly. Two spaces and right-aligned numbers are enough for a column to be legible, and the
 * result is still `grep`-able and `awk`-able, which a boxed table is not.
 */

export interface TableColumn {
  readonly header: string;
  /** Numbers right, everything else left. */
  readonly align?: 'left' | 'right';
}

/** Display width, treating a combining mark as zero-width. Good enough for Latin and CJK-free text. */
const width = (value: string): number => [...value.normalize('NFC')].length;

const pad = (value: string, to: number, align: 'left' | 'right'): string => {
  const spaces = ' '.repeat(Math.max(0, to - width(value)));
  return align === 'right' ? `${spaces}${value}` : `${value}${spaces}`;
};

/**
 * Render a table as lines, without a trailing newline on the last one.
 *
 * The rule under the header is dashes of the column's own width, so the header row and the rule
 * line up whatever the content is.
 */
export const renderTable = (
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
): string[] => {
  const widths = columns.map((column, index) =>
    Math.max(width(column.header), ...rows.map((row) => width(row[index] ?? ''))),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] ?? 0, columns[index]?.align ?? 'left'))
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((value) => '-'.repeat(value))),
    ...rows.map(line),
  ];
};

/** A narrow no-break space (U+202F) every three digits: readable, and still one `awk` field. */
export const count = (value: number): string =>
  Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');

/** Bytes as something a person reads: `1.4 MB`, `912 kB`, `8 B`. Decimal units, as disks are sold. */
export const bytes = (value: number): string => {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(size)) : size.toFixed(size < 10 ? 1 : 0)} ${units[unit] ?? 'B'}`;
};

/** `1.4 s`, `320 ms`, `2 min 05 s`. */
export const duration = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
};
