/**
 * The office heuristics: the second half of stage 6.
 *
 * CONCEPT §5.3 stage 6 asks for "date/correspondent heuristics for office documents", and §5.2
 * gives the facet they fill: correspondent, document date, ASN, amount, reference number. This is
 * the Paperless-ngx mapping of §6, and it is what makes G2 — "replace Paperless-ngx for incoming
 * paper", auto-accept over 90% — reachable at all.
 *
 * Unlike GROBID this needs no sidecar, so it is real, in-process and covered by the tests. It is
 * also, unavoidably, a pile of heuristics, and the honest thing to do with a heuristic is to score
 * it. Every field it proposes carries its own confidence, and the ones it is least sure of — a
 * correspondent guessed from a letterhead rather than read from a mail envelope — carry a low
 * enough one that a document resting on them alone fails the stage-9 gate and reaches a person (P3).
 *
 * British and German date forms are both recognised because that is the post that arrives here;
 * adding another locale means adding its month names to `MONTHS` and, if it orders the parts
 * differently again, a pattern to `readDates`.
 */
import type {
  DetectedType,
  ProposedField,
  Provenance,
} from '../types.js';
import type { ExtractedMetadata, MetadataExtractor, MetadataRequest } from './extractor.js';

export interface OfficeHeuristicOptions {
  /** Ceiling for anything this extractor proposes. Heuristics never claim certainty. */
  maxConfidence?: number;
  /** The clock, injectable so a test is deterministic. */
  now?: () => Date;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, januar: 1,
  feb: 2, february: 2, februar: 2,
  mar: 3, march: 3, 'mär': 3, 'märz': 3, maerz: 3,
  apr: 4, april: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12, dez: 12, dezember: 12,
};

const CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = {
  '£': 'GBP',
  '€': 'EUR',
  $: 'USD',
  'CHF': 'CHF',
};

/** The document type a phrase implies, and how strongly. */
const DOCUMENT_TYPES: ReadonlyArray<[RegExp, string, number]> = [
  [/\b(invoice|rechnung)\b/iu, 'invoice', 0.7],
  [/\b(credit note|gutschrift)\b/iu, 'credit_note', 0.7],
  [/\b(receipt|quittung|beleg)\b/iu, 'receipt', 0.6],
  [/\b(contract|vertrag)\b/iu, 'contract', 0.6],
  [/\b(policy|versicherungsschein|police)\b/iu, 'insurance_policy', 0.6],
  [/\b(payslip|gehaltsabrechnung|lohnabrechnung)\b/iu, 'payslip', 0.7],
  [/\b(statement|kontoauszug)\b/iu, 'statement', 0.6],
  [/\b(reminder|mahnung)\b/iu, 'reminder', 0.7],
  [/\b(certificate|bescheinigung|zeugnis)\b/iu, 'certificate', 0.6],
  [/\b(letter|schreiben|anschreiben)\b/iu, 'letter', 0.4],
];

export class OfficeHeuristicExtractor implements MetadataExtractor {
  readonly id = 'office-heuristics';

  private readonly maxConfidence: number;
  private readonly now: () => Date;

  constructor(options: OfficeHeuristicOptions = {}) {
    this.maxConfidence = options.maxConfidence ?? 0.8;
    this.now = options.now ?? (() => new Date());
  }

  supports(detectedType: DetectedType): boolean {
    return (
      detectedType === 'office_document' ||
      detectedType === 'scan' ||
      detectedType === 'image' ||
      detectedType === 'email'
    );
  }

  async extract(request: MetadataRequest): Promise<ExtractedMetadata> {
    const fetchedAt = this.now().toISOString();
    const stamp = (confidence: number): Provenance => ({
      source: this.id,
      fetchedAt,
      confidence: Math.min(confidence, this.maxConfidence),
    });

    const fields: Record<string, ProposedField> = {};
    const warnings: string[] = [];
    const text = request.text ?? '';

    /* Correspondent. The mail envelope beats the letterhead, and the letterhead beats nothing. */
    const envelopeSender = readSender(request.sourceMetadata);
    if (envelopeSender !== null) {
      fields['office.correspondent'] = { value: envelopeSender.name, provenance: stamp(0.8) };
    } else {
      const letterhead = readLetterhead(text);
      if (letterhead !== null) {
        fields['office.correspondent'] = { value: letterhead, provenance: stamp(0.35) };
      } else {
        warnings.push('no correspondent could be read from the envelope or the letterhead');
      }
    }

    /* Document date: the date printed on the page, not the date it was ingested. */
    const dates = readDates(text.slice(0, 6_000));
    const documentDate = pickDocumentDate(dates, this.now());
    if (documentDate !== null) {
      fields['office.documentDate'] = {
        value: documentDate.iso,
        provenance: stamp(documentDate.explicit ? 0.7 : 0.4),
      };
    } else {
      const envelopeDate = readEnvelopeDate(request.sourceMetadata);
      if (envelopeDate !== null) {
        fields['office.documentDate'] = { value: envelopeDate, provenance: stamp(0.6) };
      } else {
        warnings.push('no document date could be read');
      }
    }

    /* Reference number, amount, document type. */
    const reference = readReference(text);
    if (reference !== null) {
      fields['office.referenceNumber'] = { value: reference, provenance: stamp(0.6) };
    }

    const amount = readAmount(text);
    if (amount !== null) {
      fields['office.amountMinor'] = { value: amount.minor, provenance: stamp(0.55) };
      fields['office.amountCurrency'] = { value: amount.currency, provenance: stamp(0.6) };
    }

    const documentType = readDocumentType(text);
    if (documentType !== null) {
      fields['office.officeDocumentType'] = {
        value: documentType.type,
        provenance: stamp(documentType.confidence),
      };
    }

    const subject = readSubject(request.sourceMetadata);
    const title = subject ?? readTitle(text);
    if (title !== null) {
      fields['title'] = { value: title, provenance: stamp(subject === null ? 0.4 : 0.75) };
    }

    // The overall belief is the mean of what was actually proposed, floored by how much was found:
    // a document with a correspondent and nothing else should not read as 80% certain.
    const scores = Object.values(fields).map((field) => field.provenance.confidence);
    const mean = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
    const coverage = Math.min(1, scores.length / 4);

    const result: ExtractedMetadata = {
      itemType: documentType?.type === 'invoice' ? 'invoice' : 'document',
      fields,
      creators: [],
      identifiers: [],
      references: [],
      confidence: Math.min(this.maxConfidence, mean * coverage),
      extractor: this.id,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The heuristics themselves, exported so they can be tested one at a time                      */
/* ------------------------------------------------------------------------------------------ */

export interface ReadDate {
  iso: string;
  /** True when the text labelled it — "Invoice date:", "Datum:" — rather than merely contained it. */
  explicit: boolean;
}

const DATE_LABEL = /\b(date|datum|invoice date|rechnungsdatum|issued|ausgestellt am|vom)\b\s*:?\s*/iu;

/** Every date this module can read out of `text`, in document order. */
export const readDates = (text: string): ReadDate[] => {
  const out: ReadDate[] = [];
  const seen = new Set<string>();

  const push = (iso: string | null, index: number): void => {
    if (iso === null || seen.has(iso + String(index))) return;
    const before = text.slice(Math.max(0, index - 40), index);
    const explicit = DATE_LABEL.test(before);
    seen.add(iso + String(index));
    out.push({ iso, explicit });
  };

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    push(isoOf(Number(match[1]), Number(match[2]), Number(match[3])), match.index);
  }
  // `dd.mm.yyyy` and `dd/mm/yyyy`: day first, which is the British and the German reading.
  for (const match of text.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/gu)) {
    push(isoOf(fullYear(Number(match[3])), Number(match[2]), Number(match[1])), match.index);
  }
  // `12 March 2026`, `12. März 2026`, `March 12, 2026`.
  for (const match of text.matchAll(/\b(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,10})\.?\s+(\d{4})\b/gu)) {
    const month = MONTHS[(match[2] ?? '').toLowerCase()];
    if (month !== undefined) push(isoOf(Number(match[3]), month, Number(match[1])), match.index);
  }
  for (const match of text.matchAll(/\b([A-Za-zÄÖÜäöü]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/gu)) {
    const month = MONTHS[(match[1] ?? '').toLowerCase()];
    if (month !== undefined) push(isoOf(Number(match[3]), month, Number(match[2])), match.index);
  }

  return out;
};

/**
 * Which of the dates on the page is the document's own.
 *
 * A labelled date wins. Failing that, the most recent date that is not in the future, because an
 * invoice's issue date is the newest date on it and a due date in the future is not the document
 * date. A page with only future dates gets nothing rather than a guess.
 */
export const pickDocumentDate = (dates: readonly ReadDate[], now: Date): ReadDate | null => {
  const today = now.toISOString().slice(0, 10);
  const explicit = dates.filter((date) => date.explicit && date.iso <= today);
  if (explicit.length > 0) return explicit[0] as ReadDate;
  const past = dates.filter((date) => date.iso <= today).sort((a, b) => b.iso.localeCompare(a.iso));
  return past[0] ?? null;
};

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:invoice|rechnungs?)(?:\s|-)?(?:no\.?|number|nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9/-]{3,24})/iu,
  /\b(?:reference|referenz|aktenzeichen|kundennummer|customer number|account number)\s*:?\s*([A-Z0-9][A-Z0-9/-]{3,24})/iu,
  /\b(?:ref\.?|az\.?)\s*:?\s*([A-Z0-9][A-Z0-9/-]{3,24})/iu,
];

export const readReference = (text: string): string | null => {
  for (const pattern of REFERENCE_PATTERNS) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value !== undefined && value.length >= 4) return value;
  }
  return null;
};

export interface ReadAmount {
  /** Minor units. Never a float: `spec/data-model.md` §1.1 forbids REAL for money. */
  minor: number;
  currency: string;
}

const AMOUNT_LABEL =
  /\b(total|total due|amount due|grand total|gesamtbetrag|zahlbetrag|rechnungsbetrag|summe)\b[^\n]{0,40}?([£€$]|CHF|EUR|GBP|USD)?\s*([0-9][0-9.,\s]{0,15}[0-9])\s*(EUR|GBP|USD|CHF|€|£|\$)?/iu;

export const readAmount = (text: string): ReadAmount | null => {
  const match = AMOUNT_LABEL.exec(text);
  if (match === null) return null;
  const symbol = match[2] ?? match[4] ?? null;
  const raw = (match[3] ?? '').replace(/\s/gu, '');
  const minor = toMinorUnits(raw);
  if (minor === null) return null;
  const currency =
    symbol === null
      ? 'EUR'
      : (CURRENCY_BY_SYMBOL[symbol] ?? (symbol.length === 3 ? symbol.toUpperCase() : 'EUR'));
  return { minor, currency };
};

/**
 * `1.234,56` and `1,234.56` are the same amount written by different people.
 *
 * The last separator with exactly two digits after it is the decimal point; everything else is a
 * thousands separator. A number with no such separator is whole units.
 */
export const toMinorUnits = (raw: string): number | null => {
  if (!/^[0-9][0-9.,]*$/u.test(raw)) return null;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const decimalAt = Math.max(lastComma, lastDot);
  const decimals = decimalAt === -1 ? '' : raw.slice(decimalAt + 1);

  if (decimalAt !== -1 && decimals.length === 2 && /^\d{2}$/u.test(decimals)) {
    const units = raw.slice(0, decimalAt).replace(/[.,]/gu, '');
    if (!/^\d+$/u.test(units)) return null;
    return Number.parseInt(units, 10) * 100 + Number.parseInt(decimals, 10);
  }
  const units = raw.replace(/[.,]/gu, '');
  if (!/^\d+$/u.test(units)) return null;
  return Number.parseInt(units, 10) * 100;
};

export const readDocumentType = (text: string): { type: string; confidence: number } | null => {
  const head = text.slice(0, 3_000);
  for (const [pattern, type, confidence] of DOCUMENT_TYPES) {
    if (pattern.test(head)) return { type, confidence };
  }
  return null;
};

/**
 * The letterhead: the first line that reads like an organisation rather than an address.
 *
 * Deliberately conservative, and deliberately low-confidence when it fires. A letterhead is the
 * least reliable signal on the page and the one most likely to file a document under the printer's
 * name; a wrong correspondent that reaches the library silently is exactly the failure P3 exists
 * to prevent.
 */
export const readLetterhead = (text: string): string | null => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines.slice(0, 8)) {
    if (line.length < 3 || line.length > 80) continue;
    if (/^\d/u.test(line)) continue;
    if (/@|https?:\/\//u.test(line)) continue;
    if (/\b(invoice|rechnung|page|seite|date|datum)\b/iu.test(line)) continue;
    if (!/[A-Za-zÄÖÜäöüß]/u.test(line)) continue;
    return line;
  }
  return null;
};

export const readTitle = (text: string): string | null => {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length >= 4 && line.length <= 120);
  return first ?? null;
};

/**
 * How much of an envelope sender this reader will look at.
 *
 * A display name is a person's or an organisation's name. Anything past this is not one, and the
 * value would be refused as a field long before anybody read it — but the cost of *deciding* that
 * is what has to be bounded, which is what this number does.
 */
const MAX_SENDER_LENGTH = 1_024;

/**
 * `Jane Doe <jane@example.org>` becomes `Jane Doe`; a bare address is kept as written, which is the
 * best available answer without an address book.
 *
 * Read with `lastIndexOf` rather than with the regular expression this replaces. That pattern was
 * `/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u`, and its lazy `([^"<]+?)` followed by `\s*<` backtracks
 * quadratically on a value with no `<` in it: measured at 0.07 s for 8 000 trailing spaces, 0.30 s
 * for 16 000 and 1.23 s for 32 000, from a `From:` header a stranger wrote. Nobody had named it.
 * The linear reading is also the clearer one — the address is the last `<…>` on the line, and
 * everything before it is the display name.
 */
const readSender = (metadata: Record<string, unknown> | undefined): { name: string } | null => {
  const raw = pickString(metadata, ['from', 'sender', 'correspondent']);
  if (raw === null) return null;
  if (raw.length > MAX_SENDER_LENGTH) return null;

  const close = raw.lastIndexOf('>');
  const open = close === -1 ? -1 : raw.lastIndexOf('<', close);
  const display =
    open > 0 && close > open + 1 && raw.slice(close + 1).trim().length === 0
      ? raw.slice(0, open)
      : raw;

  const trimmed = display.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  const name = unquoted.length === 0 ? raw.trim() : unquoted;
  return name.length === 0 ? null : { name };
};

const readSubject = (metadata: Record<string, unknown> | undefined): string | null =>
  pickString(metadata, ['subject']);

const readEnvelopeDate = (metadata: Record<string, unknown> | undefined): string | null => {
  const raw = pickString(metadata, ['date', 'observedAt']);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const pickString = (
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null => {
  if (metadata === undefined) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
};

const fullYear = (year: number): number => (year >= 100 ? year : year >= 70 ? 1900 + year : 2000 + year);

const isoOf = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
};
