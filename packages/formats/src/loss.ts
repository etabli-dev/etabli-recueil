/**
 * Loss reporting.
 *
 * P10 says exports mirror importers; it does not say the four formats can each hold everything
 * Recueil knows. BibTeX has no place for a retraction status, RIS has no place for a licence, and
 * CSL-JSON has no place for an attachment role. The rule this module enforces is that such a field
 * is *reported* rather than quietly dropped — on the way out and on the way in — so that a
 * round-trip test can assert the loss instead of discovering it in a manuscript two years later.
 */

/** The serialisation formats this package speaks. */
export const FORMAT_NAMES = ['bibtex', 'biblatex', 'ris', 'csl-json'] as const;
export type FormatName = (typeof FORMAT_NAMES)[number];

/** One thing a conversion could not carry. */
export interface LossEntry {
  /** `export` — Recueil had it and the format cannot hold it. `import` — the file had it and the contract cannot. */
  readonly direction: 'export' | 'import';
  readonly format: FormatName;
  /** Zero-based position of the record in the batch. */
  readonly recordIndex: number;
  /** The entry key, RIS `ID` or CSL `id`, when the record has one — the human handle for the row. */
  readonly recordKey?: string | undefined;
  /** The Recueil field name on export; the format's own field or tag name on import. */
  readonly field: string;
  /** The value that was dropped, rendered for the report. Truncated; never the whole abstract. */
  readonly value?: string | undefined;
  readonly reason: string;
}

/** What every exporter returns: the serialised text, and everything it could not put in it. */
export interface ExportResult {
  readonly text: string;
  readonly losses: readonly LossEntry[];
}

const MAX_REPORTED_VALUE = 160;

/** Render a value for a loss entry: short, single-line, and never the whole field. */
export const renderLossValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > MAX_REPORTED_VALUE ? `${flat.slice(0, MAX_REPORTED_VALUE - 1)}…` : flat;
};

/** Accumulates loss entries for one conversion, so the callers stay free of bookkeeping. */
export class LossReport {
  readonly #entries: LossEntry[] = [];

  constructor(
    private readonly direction: 'export' | 'import',
    private readonly format: FormatName,
  ) {}

  add(recordIndex: number, field: string, reason: string, value?: unknown, recordKey?: string): void {
    this.#entries.push({
      direction: this.direction,
      format: this.format,
      recordIndex,
      recordKey,
      field,
      value: renderLossValue(value),
      reason,
    });
  }

  /** Add an entry only when the value is actually present. The common case at every call site. */
  addIfPresent(
    recordIndex: number,
    field: string,
    reason: string,
    value: unknown,
    recordKey?: string,
  ): void {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim().length === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    this.add(recordIndex, field, reason, value, recordKey);
  }

  get entries(): readonly LossEntry[] {
    return this.#entries;
  }
}

/** What every importer returns: the records it built, and everything the contract could not hold. */
export interface ImportResult {
  readonly records: readonly import('./record.js').FormatRecord[];
  readonly losses: readonly LossEntry[];
}
