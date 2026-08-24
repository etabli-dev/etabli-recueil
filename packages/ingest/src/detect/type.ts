/**
 * Stage 4: type detection.
 *
 * CONCEPT §5.3 names four kinds — "scholarly PDF, scan, office document, image" — and the whole
 * shape of the rest of the pipeline follows from which one a file is. A scholarly PDF goes to
 * GROBID at stage 6 and gets a bibliographic facet; a scan goes to OCR at stage 5 first; an office
 * document goes to the date-and-correspondent heuristics and gets the Office facet of §5.2; an
 * image is filed as it is.
 *
 * The decision is made from three things and in this order of authority: the sniffed media type,
 * the presence and shape of a text layer, and the text itself. Never the filename. A file called
 * `invoice.pdf` that turns out to have an abstract, a DOI and a reference list is a paper somebody
 * misnamed, and the pipeline should say so rather than file it as an invoice — which is exactly why
 * the signals are counted and the result carries `confidence` and `signals`, so that a marginal
 * call arrives at stage 9 with a low score and lands in the review queue rather than being asserted.
 */
import type { DetectedType } from '../types.js';

export interface DetectionInput {
  mediaType: string;
  /**
   * What stage 3 found the file to be, when it found anything.
   *
   * It outranks the media type, and has to: a `.eml` saved by a mail client is honestly sniffed as
   * `text/plain`, because that is what its bytes are, and a sniffer that said otherwise would be
   * guessing from the extension. Stage 3 has already parsed the header block by this point, so it
   * knows.
   */
  archive?: 'zip' | 'eml' | null;
  byteSize: number;
  /** Whatever text the pipeline has at this point: the PDF's own layer, or nothing yet. */
  text: string | null;
  /** From the text-layer probe. Null for a file that is not a PDF. */
  hasTextLayer: boolean | null;
  pageCount: number | null;
  /** True when the file came out of a zip or an eml. Nudges nothing; recorded for the rules. */
  fromArchive: boolean;
}

export interface DetectionResult {
  type: DetectedType;
  /** 0..1: how sure the detector is, and the first contribution to the stage-9 score. */
  confidence: number;
  /** The named signals that produced the verdict. Written to the job log, so a call is auditable. */
  signals: string[];
}

const OFFICE_MEDIA_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
]);

/** Words that say "this is a paper", weighted by how rarely they appear in a utility bill. */
const SCHOLARLY_MARKERS: ReadonlyArray<[RegExp, number, string]> = [
  [/\bdoi\s*:?\s*10\.\d{4,9}\//iu, 3, 'a DOI is printed on the page'],
  [/\barxiv\s*:\s*\d{4}\.\d{4,5}/iu, 3, 'an arXiv identifier is printed on the page'],
  [/^\s*abstract\b/imu, 2, 'the text has an Abstract heading'],
  [/\breferences\b|\bbibliography\b|\bliteratur\b/iu, 2, 'the text has a reference list heading'],
  [/\bkeywords?\s*:/iu, 1, 'the text has a keyword line'],
  [/\bet al\.?\b/iu, 1, 'the text cites with "et al."'],
  [/\bjournal of\b|\bproceedings of\b|\bconference on\b/iu, 1, 'a venue name appears in the text'],
  [/\bissn\b|\be-?issn\b/iu, 1, 'an ISSN appears in the text'],
];

/** Words that say "this is post": the Office facet of CONCEPT §5.2 and the Paperless mapping. */
const OFFICE_MARKERS: ReadonlyArray<[RegExp, number, string]> = [
  [/\b(invoice|rechnung|facture|bill)\b/iu, 3, 'the text names itself an invoice'],
  [/\b(kundennummer|customer number|account number|reference number|aktenzeichen)\b/iu, 2, 'a customer or reference number appears'],
  [/\b(iban|bic|vat|ust-?idnr|steuernummer)\b/iu, 2, 'a banking or tax identifier appears'],
  [/\b(amount due|total due|zahlbetrag|gesamtbetrag|betrag)\b/iu, 2, 'an amount due appears'],
  [/\b(dear (sir|madam|mr|mrs|ms)|sehr geehrte)\b/iu, 2, 'the text opens with a letter salutation'],
  [/\b(contract|vertrag|policy|police|versicherungsschein)\b/iu, 2, 'the text names itself a contract or policy'],
  [/\b(yours (sincerely|faithfully)|mit freundlichen gr)\b/iu, 1, 'the text closes with a letter sign-off'],
];

export const detectType = (input: DetectionInput): DetectionResult => {
  const signals: string[] = [];
  const { mediaType } = input;

  if (input.archive === 'eml') {
    return { type: 'email', confidence: 0.9, signals: ['stage 3 read an RFC 5322 header block'] };
  }
  if (input.archive === 'zip') {
    return { type: 'archive', confidence: 0.9, signals: ['stage 3 read a ZIP central directory'] };
  }
  if (mediaType === 'message/rfc822') {
    return { type: 'email', confidence: 0.9, signals: ['the media type is message/rfc822'] };
  }
  if (mediaType === 'application/zip' || mediaType === 'application/gzip') {
    return { type: 'archive', confidence: 0.9, signals: [`the media type is ${mediaType}`] };
  }
  if (mediaType.startsWith('image/')) {
    signals.push(`the media type is ${mediaType}`);
    return { type: 'image', confidence: 0.85, signals };
  }
  if (OFFICE_MEDIA_TYPES.has(mediaType)) {
    signals.push(`the media type is ${mediaType}`);
    return { type: 'office_document', confidence: 0.7, signals };
  }

  if (mediaType !== 'application/pdf') {
    if (mediaType.startsWith('text/') || mediaType === 'application/xml') {
      signals.push(`the media type is ${mediaType}`);
      return { type: 'text', confidence: 0.6, signals };
    }
    signals.push(`nothing recognised the media type ${mediaType}`);
    return { type: 'unknown', confidence: 0.1, signals };
  }

  /* A PDF. The interesting case, and the one the four-way split is really about. */

  if (input.hasTextLayer === false) {
    signals.push('the PDF has no usable text layer, so it is a picture of a page');
    return { type: 'scan', confidence: 0.8, signals };
  }

  const text = input.text ?? '';
  if (text.length === 0) {
    signals.push('the PDF yielded no text, so it is treated as a scan until OCR says otherwise');
    return { type: 'scan', confidence: 0.6, signals };
  }

  const head = text.slice(0, 8_000);
  let scholarly = 0;
  for (const [pattern, weight, description] of SCHOLARLY_MARKERS) {
    if (pattern.test(head)) {
      scholarly += weight;
      signals.push(description);
    }
  }
  let office = 0;
  for (const [pattern, weight, description] of OFFICE_MARKERS) {
    if (pattern.test(head)) {
      office += weight;
      signals.push(description);
    }
  }

  if (scholarly === 0 && office === 0) {
    signals.push('the PDF has a text layer but nothing in it identifies the kind of document');
    return { type: 'office_document', confidence: 0.3, signals };
  }

  // A tie is a genuine ambiguity and must not be broken silently: the low score is what carries it
  // to the stage-9 gate and, from there, to the review queue (P3).
  if (scholarly === office) {
    signals.push(`the scholarly and office signals are level at ${scholarly}`);
    return { type: 'office_document', confidence: 0.25, signals };
  }

  const winner = scholarly > office ? 'scholarly_pdf' : 'office_document';
  const margin = Math.abs(scholarly - office);
  const total = scholarly + office;
  const confidence = clamp(0.45 + 0.1 * margin + (total === 0 ? 0 : 0.1 * (margin / total)), 0, 0.95);
  return { type: winner, confidence, signals };
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
