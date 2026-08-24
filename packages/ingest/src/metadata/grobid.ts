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
 */
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
  /** Injected in tests of the parser; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class GrobidExtractor implements MetadataExtractor {
  readonly id = 'grobid';

  private readonly baseUrl: string;
  private readonly mode: 'header' | 'fulltext';
  private readonly timeoutMs: number;
  private readonly consolidateHeader: 0 | 1 | 2;
  private readonly confidence: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GrobidOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.mode = options.mode ?? 'header';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.consolidateHeader = options.consolidateHeader ?? 0;
    this.confidence = options.confidence ?? 0.7;
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
      tei = await response.text();
    } catch (error) {
      if (error instanceof AdapterUnavailableError) throw error;
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
      const body = (await response.text()).trim();
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
  options: { extractor: string; confidence: number; fetchedAt?: string },
): ExtractedMetadata => {
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

const scanTag = (
  xml: string,
  name: string,
  from: number,
): { open: string; inner: string; end: number } | null => {
  const pattern = new RegExp(`<${name}(\\s[^>]*)?(/)?>`, 'giu');
  pattern.lastIndex = from;
  const match = pattern.exec(xml);
  if (match === null) return null;
  const open = match[0];
  if (open.endsWith('/>')) {
    return { open, inner: '', end: match.index + open.length };
  }

  // Find the matching close, allowing for nesting of the same tag name.
  const openPattern = new RegExp(`<${name}(\\s[^>]*)?>`, 'giu');
  const closeTag = `</${name}>`;
  let depth = 1;
  let cursor = match.index + open.length;
  while (depth > 0) {
    const close = xml.indexOf(closeTag, cursor);
    if (close === -1) return null;
    openPattern.lastIndex = cursor;
    const nested = openPattern.exec(xml);
    if (nested !== null && nested.index < close) {
      depth += 1;
      cursor = nested.index + nested[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return {
        open,
        inner: xml.slice(match.index + open.length, close),
        end: close + closeTag.length,
      };
    }
    cursor = close + closeTag.length;
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

const attribute = (openTag: string, name: string): string | null => {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'iu').exec(openTag);
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
