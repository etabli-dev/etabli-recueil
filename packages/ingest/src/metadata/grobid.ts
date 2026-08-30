/**
 * The real GROBID adapter.
 *
 * **This file is not exercised by the test suite, and that is deliberate.** GROBID is a sidecar
 * (CONCEPT §5.1, ADR list §5.16) and no Recueil test may require a container. The tests exercise
 * the `MetadataExtractor` interface through `FakeMetadataExtractor` and, for the office path,
 * through `OfficeHeuristicExtractor`, which is real and needs nothing.
 *
 * The compatibility claim this file makes is: **untested against a real GROBID in this
 * repository**. It is written against GROBID 0.8's documented REST API — `POST /api/processHeader
 * Document` and `POST /api/processFulltextDocument`, multipart field `input`, TEI-XML back — and it
 * has not been run against one here. When someone does run it, the honest way to make the claim
 * real is to capture a TEI response from a live GROBID into `fixtures/grobid/` and test the parser
 * against that fixture; the parser is split out as `parseTeiHeader` for exactly that reason, and it
 * *is* testable without a container the moment a captured fixture exists.
 *
 * How to turn it on:
 *
 * ```ts
 * import { GrobidExtractor, IngestPipeline } from '@recueil/ingest';
 *
 * const pipeline = new IngestPipeline({
 *   recueil,
 *   extractors: [new GrobidExtractor({ baseUrl: 'http://localhost:8070' })],
 * });
 * ```
 *
 * `deploy/docker-compose.yml` carries the sidecar profile that starts one.
 *
 * ## The budget
 *
 * A sidecar is not a trusted party. It is reached over the network at an address an operator
 * configured, it can be swapped for something else, and — decisively — what it returns is derived
 * from a PDF that arrived from a stranger's mailbox, so the strings in the TEI are the attacker's
 * strings. ADR-0022 therefore applies here exactly as it applies to a zip:
 *
 *   - The response body is read with a running total and abandoned past `maxResponseBytes`, rather
 *     than `await response.text()` materialising whatever the far side chose to send. Nothing in
 *     this package bounded that; the re-attack listed it among the reads with no ceiling of their
 *     own.
 *   - `parseTeiHeader` refuses a document past `maxTeiBytes` before it scans it.
 *   - The tag scanner is linear. It was not: a TEI holding N unclosed openers of the same name
 *     re-scanned the gap to the closing tag once per opener, which is quadratic — 3.42 MB of TEI
 *     cost 15.86 s of blocked event loop, synchronously, on the ingest worker. Nobody had named
 *     this one; it is the same lazy-span-with-no-floor shape as the PDF page count, written with
 *     `indexOf` instead of a regular expression.
 */
import { ResourceBudgetError } from '../budgets.js';
import { AdapterUnavailableError } from '../errors.js';
import { extractIdentifiers, normaliseDoi } from '../resolve/identifiers.js';
import type {
  DetectedType,
  ExtractedReference,
  HealthReport,
  Identifier,
  ProposedCreator,
  ProposedField,
  Provenance,
} from '../types.js';
import type { ExtractedMetadata, MetadataExtractor, MetadataRequest } from './extractor.js';

export interface GrobidOptions {
  baseUrl: string;
  /** `header` is fast and gives title/authors/DOI/abstract; `fulltext` adds the reference list. */
  mode?: 'header' | 'fulltext';
  timeoutMs?: number;
  /** Consolidation asks GROBID to check the header against Crossref. Off by default: it is slow. */
  consolidateHeader?: 0 | 1 | 2;
  /** The confidence stamped on every field this extractor writes. Never 1. */
  confidence?: number;
  /**
   * Ceiling on the response body this adapter will read, in bytes.
   *
   * A TEI header for a paper is tens of kilobytes and a full-text TEI with its reference list is a
   * few hundred; sixteen mebibytes is far above both and far below what an unbounded read of a
   * hostile endpoint costs.
   */
  maxResponseBytes?: number;
  /** Injected in tests of the parser; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Defaults for the two ceilings, stated once so a caller can raise them knowingly. */
export const DEFAULT_GROBID_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TEI_MAX_BYTES = 16 * 1024 * 1024;

export class GrobidExtractor implements MetadataExtractor {
  readonly id = 'grobid';

  private readonly baseUrl: string;
  private readonly mode: 'header' | 'fulltext';
  private readonly timeoutMs: number;
  private readonly consolidateHeader: 0 | 1 | 2;
  private readonly confidence: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GrobidOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.mode = options.mode ?? 'header';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.consolidateHeader = options.consolidateHeader ?? 0;
    this.confidence = options.confidence ?? 0.7;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_GROBID_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  supports(detectedType: DetectedType, mediaType: string): boolean {
    return mediaType === 'application/pdf' && (detectedType === 'scholarly_pdf' || detectedType === 'scan');
  }

  async extract(request: MetadataRequest): Promise<ExtractedMetadata> {
    const endpoint =
      this.mode === 'fulltext'
        ? `${this.baseUrl}/api/processFulltextDocument`
        : `${this.baseUrl}/api/processHeaderDocument`;

    const form = new FormData();
    form.append(
      'input',
      new Blob([new Uint8Array(request.bytes)], { type: 'application/pdf' }),
      request.filename ?? 'document.pdf',
    );
    form.append('consolidateHeader', String(this.consolidateHeader));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    let tei: string;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        body: form,
        headers: { accept: 'application/xml' },
        signal: controller.signal,
      });
      if (response.status === 204) {
        return {
          fields: {},
          creators: [],
          identifiers: [],
          references: [],
          confidence: 0,
          extractor: this.id,
          warnings: ['GROBID could not extract anything from this PDF'],
        };
      }
      if (!response.ok) {
        throw new AdapterUnavailableError('grobid', `HTTP ${response.status} from ${endpoint}`, {
          status: response.status,
        });
      }
      tei = await readBounded(response, this.maxResponseBytes, `${endpoint} response`);
    } catch (error) {
      if (error instanceof AdapterUnavailableError) throw error;
      // A body past the ceiling is a budget refusal, not an unavailable adapter: the sidecar
      // answered, it answered with more than this reader will hold, and P3 wants that named.
      if (error instanceof ResourceBudgetError) throw error;
      throw new AdapterUnavailableError(
        'grobid',
        error instanceof Error ? error.message : String(error),
        { endpoint },
      );
    } finally {
      clearTimeout(timer);
    }

    return parseTeiHeader(tei, { extractor: this.id, confidence: this.confidence });
  }

  async health(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/isalive`, { method: 'GET' });
      // `isalive` answers `true` or `false`. A kilobyte is generous and a health probe is not a
      // place to accept an unbounded body from a host that may not be the one you configured.
      const body = (await readBounded(response, 1024, 'isalive response')).trim();
      return response.ok && body === 'true'
        ? { status: 'ok', checkedAt }
        : { status: 'degraded', message: `isalive said '${body}'`, checkedAt };
    } catch (error) {
      return {
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }
}

/**
 * Read a response body with a running total, abandoning it past `limit`.
 *
 * `await response.text()` is the shape ADR-0022 §2 forbids: the buffer is materialised and *then*
 * it could be measured. This reads the stream, adds up what has arrived, and cancels the moment the
 * total passes the ceiling, so the memory a hostile endpoint can command is the ceiling rather than
 * whatever it decided to send. A body with no stream — some `fetch` implementations and every
 * hand-written fake — falls back to `text()` and is measured after, which is honest for a caller
 * that already has the whole string in memory and is stated rather than hidden.
 */
const readBounded = async (response: Response, limit: number, what: string): Promise<string> => {
  const body = response.body;
  if (body === null || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > limit) throw responseTooBig(what, text.length, limit);
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw responseTooBig(what, total, limit);
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Cancel rather than leave the socket draining a body nobody will read.
    await reader.cancel().catch(() => undefined);
  }
  chunks.push(decoder.decode());
  return chunks.join('');
};

const responseTooBig = (what: string, seen: number, limit: number): ResourceBudgetError =>
  new ResourceBudgetError(
    'grobid.maxResponseBytes',
    limit,
    `The ${what} passed ${seen} bytes, over the grobid.maxResponseBytes budget of ${limit}. ` +
      'The read was stopped at the budget rather than measured after it.',
    { what, seen },
  );

/* ------------------------------------------------------------------------------------------ */
/* TEI parsing                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Turn GROBID's TEI into a proposal.
 *
 * Exported separately from the transport so it can be tested against a captured TEI fixture with
 * no container in sight — which is the only kind of compatibility claim worth making. Until such a
 * fixture is committed, this function is untested and says so.
 *
 * A hand-written reader rather than an XML parser dependency: the subset needed is
 * `teiHeader/fileDesc/titleStmt/title`, the author list, `idno`, `abstract`, `monogr` and
 * `listBibl/biblStruct`, all of which are flat enough to read with a tag scanner, and adding an XML
 * parser to the dependency tree for it would be the larger commitment.
 */
export const parseTeiHeader = (
  tei: string,
  options: { extractor: string; confidence: number; fetchedAt?: string; maxBytes?: number },
): ExtractedMetadata => {
  const maxBytes = options.maxBytes ?? DEFAULT_TEI_MAX_BYTES;
  if (tei.length > maxBytes) {
    throw new ResourceBudgetError(
      'grobid.maxTeiBytes',
      maxBytes,
      `The TEI document is ${tei.length} characters, over the grobid.maxTeiBytes budget of ` +
        `${maxBytes}. It was refused before it was scanned.`,
      { byteSize: tei.length },
    );
  }
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const provenance = (confidence = options.confidence): Provenance => ({
    source: options.extractor,
    fetchedAt,
    confidence,
  });

  const fields: Record<string, ProposedField> = {};
  const warnings: string[] = [];

  const header = section(tei, 'teiHeader') ?? tei;
  const analytic = section(header, 'analytic');
  const monogr = section(header, 'monogr');

  const title = textOf(firstTag(analytic ?? header, 'title'));
  if (title !== null) fields['bibliographic.title'] = { value: title, provenance: provenance() };

  const abstract = textOf(section(header, 'abstract'));
  if (abstract !== null) {
    fields['bibliographic.abstract'] = { value: abstract, provenance: provenance() };
  }

  const identifiers: Identifier[] = [];
  for (const idno of allTags(header, 'idno')) {
    const type = attribute(idno.open, 'type')?.toLowerCase() ?? '';
    const value = textOf(idno.inner);
    if (value === null) continue;
    if (type === 'doi') {
      const doi = normaliseDoi(value);
      if (doi !== null) {
        identifiers.push({ scheme: 'doi', value: doi });
        fields['bibliographic.doi'] = { value: doi, provenance: provenance() };
      }
    } else if (type === 'arxiv') {
      identifiers.push({ scheme: 'arxiv', value: value.replace(/^arxiv:/iu, '') });
    } else if (type === 'pmid') {
      identifiers.push({ scheme: 'pmid', value });
    } else if (type === 'pmc' || type === 'pmcid') {
      identifiers.push({ scheme: 'pmcid', value: value.toUpperCase() });
    }
  }

  if (monogr !== null) {
    const venue = textOf(firstTag(monogr, 'title'));
    if (venue !== null) {
      fields['bibliographic.containerTitle'] = { value: venue, provenance: provenance() };
    }
    const issued = attribute(firstTagOpen(monogr, 'date') ?? '', 'when');
    const year = issued === null ? null : Number.parseInt(issued.slice(0, 4), 10);
    if (year !== null && Number.isInteger(year)) {
      fields['bibliographic.issuedDate'] = { value: issued as string, provenance: provenance() };
      fields['bibliographic.issuedYear'] = { value: year, provenance: provenance() };
    }
    const volume = textOf(scopeByAttribute(monogr, 'biblScope', 'unit', 'volume'));
    if (volume !== null) fields['bibliographic.volume'] = { value: volume, provenance: provenance() };
    const issue = textOf(scopeByAttribute(monogr, 'biblScope', 'unit', 'issue'));
    if (issue !== null) fields['bibliographic.issue'] = { value: issue, provenance: provenance() };
  }

  const creators: ProposedCreator[] = [];
  const authorScope = analytic ?? header;
  for (const author of allTags(authorScope, 'author')) {
    const family = textOf(firstTag(author.inner, 'surname'));
    const given = textOf(firstTag(author.inner, 'forename'));
    const orcid = textOf(scopeByAttribute(author.inner, 'idno', 'type', 'ORCID'));
    if (family === null && given === null) continue;
    const entry: ProposedCreator = {
      role: 'author',
      sequence: creators.length + 1,
      provenance: provenance(),
    };
    if (family !== null) entry.family = family;
    if (given !== null) entry.given = given;
    if (orcid !== null) entry.orcid = orcid;
    const affiliation = textOf(firstTag(author.inner, 'orgName'));
    if (affiliation !== null) entry.affiliation = affiliation;
    creators.push(entry);
  }

  const references: ExtractedReference[] = [];
  const listBibl = section(tei, 'listBibl');
  if (listBibl !== null) {
    for (const struct of allTags(listBibl, 'biblStruct')) {
      const raw = textOf(struct.inner) ?? '';
      if (raw.length === 0) continue;
      const reference: ExtractedReference = {
        raw,
        identifiers: extractIdentifiers(raw, { limit: 2_000 }),
      };
      const referenceTitle = textOf(firstTag(struct.inner, 'title'));
      if (referenceTitle !== null) reference.title = referenceTitle;
      const when = attribute(firstTagOpen(struct.inner, 'date') ?? '', 'when');
      const referenceYear = when === null ? Number.NaN : Number.parseInt(when.slice(0, 4), 10);
      if (Number.isInteger(referenceYear)) reference.issuedYear = referenceYear;
      references.push(reference);
    }
  }

  if (title === null) warnings.push('GROBID returned no title');

  const filled = Object.keys(fields).length;
  const result: ExtractedMetadata = {
    itemType: 'article',
    fields,
    creators,
    identifiers,
    references,
    // A header with a title, a DOI, authors and a venue is a good extraction; one with a title
    // alone is a guess, and the gate should see the difference.
    confidence: Math.min(0.9, options.confidence * (filled === 0 ? 0 : Math.min(1, filled / 4))),
    extractor: options.extractor,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
};

/* A tag scanner. Small, and only as clever as the TEI subset above needs. ---------------------- */

interface Tag {
  open: string;
  inner: string;
}

const section = (xml: string, name: string): string | null => firstTag(xml, name);

const firstTag = (xml: string | null, name: string): string | null => {
  if (xml === null) return null;
  const tag = scanTag(xml, name, 0);
  return tag === null ? null : tag.inner;
};

const firstTagOpen = (xml: string | null, name: string): string | null => {
  if (xml === null) return null;
  const tag = scanTag(xml, name, 0);
  return tag === null ? null : tag.open;
};

const allTags = (xml: string | null, name: string): Tag[] => {
  if (xml === null) return [];
  const out: Tag[] = [];
  let cursor = 0;
  for (;;) {
    const tag = scanTag(xml, name, cursor);
    if (tag === null) break;
    out.push({ open: tag.open, inner: tag.inner });
    cursor = tag.end;
  }
  return out;
};

/**
 * The two patterns for one tag name, compiled once.
 *
 * `new RegExp` from an interpolated string is the shape that becomes an injection the day the
 * interpolated part stops being a literal, so the name is checked against the XML name production
 * this reader actually uses before it is ever put into a pattern. Every caller here passes a
 * constant, and the check is what keeps that true rather than something a reader has to verify by
 * following every call. Compiling once per name also matters on its own: `allTags` calls `scanTag`
 * in a loop, and two `RegExp` constructions per iteration is a cost paid per tag of the document.
 */
const TAG_PATTERNS = new Map<string, { any: RegExp; open: RegExp }>();

const patternsFor = (name: string): { any: RegExp; open: RegExp } => {
  const cached = TAG_PATTERNS.get(name);
  if (cached !== undefined) return cached;
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) {
    throw new TypeError(`'${name}' is not a tag name this reader will build a pattern from`);
  }
  // `[^>]*` is a negated class under a single quantifier over a bounded document: linear, and it
  // cannot be made to backtrack.
  const compiled = {
    any: new RegExp(`<${name}(\\s[^>]*)?(/)?>`, 'giu'),
    open: new RegExp(`<${name}(\\s[^>]*)?>`, 'giu'),
  };
  TAG_PATTERNS.set(name, compiled);
  return compiled;
};

/**
 * Find `<name>…</name>` from `from`, allowing the same name to nest.
 *
 * Both searches move forward and neither is ever restarted, which is the whole of the fix here.
 * The version this replaces re-ran `indexOf(closeTag, cursor)` from each nested opener, so a
 * document holding N openers of one name before its first closer re-scanned the gap N times:
 * quadratic, and measured at 15.86 s for 3.42 MB of TEI. The output is identical; only the number
 * of times the same characters are read changes.
 */
const scanTag = (
  xml: string,
  name: string,
  from: number,
): { open: string; inner: string; end: number } | null => {
  const { any, open: openPattern } = patternsFor(name);
  any.lastIndex = from;
  const match = any.exec(xml);
  if (match === null) return null;
  const open = match[0];
  if (open.endsWith('/>')) {
    return { open, inner: '', end: match.index + open.length };
  }

  const closeTag = `</${name}>`;
  const innerStart = match.index + open.length;
  let depth = 1;
  let close = xml.indexOf(closeTag, innerStart);
  openPattern.lastIndex = innerStart;
  let nested = openPattern.exec(xml);

  while (depth > 0) {
    if (close === -1) return null;
    if (nested !== null && nested.index < close) {
      depth += 1;
      // Only the opener search advances; `close` is still the next closer and does not move.
      openPattern.lastIndex = nested.index + nested[0].length;
      nested = openPattern.exec(xml);
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return { open, inner: xml.slice(innerStart, close), end: close + closeTag.length };
    }
    // Only the closer search advances, and never back over ground already read.
    close = xml.indexOf(closeTag, close + closeTag.length);
  }
  return null;
};

const scopeByAttribute = (
  xml: string | null,
  name: string,
  attributeName: string,
  attributeValue: string,
): string | null => {
  for (const tag of allTags(xml, name)) {
    if (attribute(tag.open, attributeName)?.toLowerCase() === attributeValue.toLowerCase()) {
      return tag.inner.length > 0 ? tag.inner : (attribute(tag.open, 'from') ?? null);
    }
  }
  return null;
};

/** `name="value"` readers, compiled once per name and checked the same way as the tag patterns. */
const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

const attribute = (openTag: string, name: string): string | null => {
  let pattern = ATTRIBUTE_PATTERNS.get(name);
  if (pattern === undefined) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) {
      throw new TypeError(`'${name}' is not an attribute name this reader will build a pattern from`);
    }
    pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'iu');
    ATTRIBUTE_PATTERNS.set(name, pattern);
  }
  const match = pattern.exec(openTag);
  return match === null ? null : (match[1] ?? null);
};

const textOf = (xml: string | null): string | null => {
  if (xml === null) return null;
  const text = xml
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#3[49];/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length === 0 ? null : text;
};
