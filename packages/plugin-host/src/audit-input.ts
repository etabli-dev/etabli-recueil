/**
 * Reading a reference list for bibliography audit mode (CONCEPT §5.5).
 *
 * BibTeX, BibLaTeX, RIS and CSL-JSON go through `@recueil/formats`. Plain text — a reference list
 * pasted from a manuscript, one reference per line or per blank-line-separated paragraph — is read
 * with deliberately modest heuristics: the DOI if there is one, the first plausible year, and the
 * title as the longest sentence-like run after the authors. GROBID and AnyStyle parse plain text
 * far better; when one is configured it replaces this, and until then the audit report says which
 * references it could only read loosely.
 */
import { importBibtex, importCslJson, importRis, recordTitle } from '@recueil/formats';
import type { FormatRecord } from '@recueil/formats';
import { canonicalDoi } from '@recueil/plugin-sdk';
import type { Identifier, WorkStub } from '@recueil/plugin-sdk';

export type AuditFormat = 'bibtex' | 'ris' | 'csl-json' | 'text';

export interface AuditReference {
  stub: WorkStub;
  rawString?: string;
  /** True when the reference was parsed from plain text by the heuristics below. */
  loose: boolean;
}

export const detectAuditFormat = (source: string): AuditFormat => {
  const trimmed = source.trimStart();
  if (trimmed.startsWith('@')) return 'bibtex';
  if (/^TY {2}- /mu.test(source)) return 'ris';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'csl-json';
  return 'text';
};

const fromRecord = (record: FormatRecord): AuditReference => {
  const bib = record.bibliographic ?? {};
  const identifiers: Identifier[] = [];
  const doi = typeof bib.doi === 'string' ? canonicalDoi(bib.doi) : null;
  if (doi) identifiers.push({ scheme: 'doi', value: doi });
  if (typeof bib.pmid === 'string' && bib.pmid !== '') identifiers.push({ scheme: 'pmid', value: bib.pmid });
  if (typeof bib.isbn === 'string' && bib.isbn !== '') identifiers.push({ scheme: 'isbn', value: bib.isbn });
  if (typeof bib.arxivId === 'string' && bib.arxivId !== '') identifiers.push({ scheme: 'arxiv', value: bib.arxivId });
  const title = recordTitle(record);
  const year = typeof bib.issuedYear === 'number' ? bib.issuedYear : undefined;
  const container = typeof bib.containerTitle === 'string' ? bib.containerTitle : undefined;
  return {
    stub: {
      identifiers,
      ...(title === undefined ? {} : { title }),
      ...(container === undefined ? {} : { containerTitle: container }),
      ...(year === undefined ? {} : { issuedYear: year }),
      authors: (record.creators ?? []).map((creator) => ({
        ...(creator.familyName ? { family: creator.familyName } : {}),
        ...(creator.givenName ? { given: creator.givenName } : {}),
        ...(creator.literalName ? { literal: creator.literalName } : {}),
      })),
    },
    loose: false,
  };
};

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"<>]+?)(?=[.,;)\]]?(?:\s|$))/iu;

/** One plain-text reference. */
export const parseTextReference = (raw: string): AuditReference => {
  const line = raw.replace(/\s+/gu, ' ').trim();
  const identifiers: Identifier[] = [];
  const doiMatch = DOI_IN_TEXT.exec(line);
  if (doiMatch?.[1] !== undefined) identifiers.push({ scheme: 'doi', value: doiMatch[1].toLowerCase() });
  const pmid = /\bPMID:?\s*(\d{4,9})\b/iu.exec(line)?.[1];
  if (pmid !== undefined) identifiers.push({ scheme: 'pmid', value: pmid });
  const yearMatch = /\((\d{4})[a-z]?\)|\b(1[5-9]\d{2}|20\d{2})\b/u.exec(line);
  const year = Number(yearMatch?.[1] ?? yearMatch?.[2]);
  // Title: a quoted run if there is one; otherwise the sentence after the year (APA, Vancouver).
  const quoted = /["“]([^"”]{10,})["”]/u.exec(line)?.[1];
  let title = quoted;
  if (title === undefined && yearMatch !== null) {
    const after = line.slice(yearMatch.index + yearMatch[0].length).replace(/^[).,:;\s]+/u, '');
    title = after.split(/\.\s/u)[0];
  }
  if (title === undefined) title = line.split(/\.\s/u).sort((a, b) => b.length - a.length)[0];
  const authorPart = yearMatch === null ? '' : line.slice(0, yearMatch.index);
  const family = /^([\p{Lu}][\p{L}'’-]+)/u.exec(authorPart.trim())?.[1];
  return {
    stub: {
      identifiers,
      ...(title === undefined || title.trim() === '' ? {} : { title: title.trim().replace(/[.,;]$/u, '') }),
      ...(Number.isFinite(year) && year > 0 ? { issuedYear: year } : {}),
      ...(family === undefined ? {} : { authors: [{ family }] }),
    },
    rawString: raw.trim(),
    loose: true,
  };
};

export const readAuditInput = (source: string, format: AuditFormat = detectAuditFormat(source)): AuditReference[] => {
  if (format === 'bibtex') return importBibtex(source).records.map(fromRecord);
  if (format === 'ris') return importRis(source).records.map(fromRecord);
  if (format === 'csl-json') return importCslJson(source).records.map(fromRecord);
  const blocks = source.includes('\n\n') ? source.split(/\n\s*\n/u) : source.split(/\n/u);
  return blocks
    .map((block) => block.replace(/^\s*(?:\[\d+\]|\d+\.)\s*/u, '').trim())
    .filter((block) => block.length > 15)
    .map(parseTextReference);
};

/* -------------------------------------------------------------------------------------------- */
/* A manuscript PDF, through GROBID                                                                */
/* -------------------------------------------------------------------------------------------- */

const MAX_TEI_BYTES = 16 * 1024 * 1024;

const decodeXml = (text: string): string =>
  text
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();

const first = (xml: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(xml);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
};

/** GROBID's `<listBibl>` of `<biblStruct>`s → audit references. */
export const parseTeiReferences = (tei: string): AuditReference[] => {
  const out: AuditReference[] = [];
  for (const match of tei.matchAll(/<biblStruct\b[^>]*>([\s\S]*?)<\/biblStruct>/gu)) {
    const entry = match[1] ?? '';
    const analytic = /<analytic>([\s\S]*?)<\/analytic>/u.exec(entry)?.[1] ?? '';
    const monogr = /<monogr>([\s\S]*?)<\/monogr>/u.exec(entry)?.[1] ?? '';
    const title = first(analytic, /<title\b[^>]*>([\s\S]*?)<\/title>/u) ?? first(monogr, /<title\b[^>]*>([\s\S]*?)<\/title>/u);
    const container = analytic === '' ? undefined : first(monogr, /<title\b[^>]*>([\s\S]*?)<\/title>/u);
    const year = Number(/<date\b[^>]*when="(\d{4})/u.exec(entry)?.[1]);
    const identifiers: Identifier[] = [];
    const doi = canonicalDoi(first(entry, /<idno type="DOI">([\s\S]*?)<\/idno>/iu) ?? '');
    if (doi !== null) identifiers.push({ scheme: 'doi', value: doi });
    const pmid = first(entry, /<idno type="PMID">(\d+)<\/idno>/iu);
    if (pmid !== undefined) identifiers.push({ scheme: 'pmid', value: pmid });
    const authors = [...(analytic === '' ? monogr : analytic).matchAll(/<persName\b[^>]*>([\s\S]*?)<\/persName>/gu)].map((person) => {
      const family = first(person[1] ?? '', /<surname>([\s\S]*?)<\/surname>/u);
      const given = first(person[1] ?? '', /<forename[^>]*>([\s\S]*?)<\/forename>/u);
      return { ...(family === undefined ? {} : { family }), ...(given === undefined ? {} : { given }) };
    });
    const raw = first(entry, /<note type="raw_reference">([\s\S]*?)<\/note>/u);
    if (title === undefined && identifiers.length === 0) continue;
    out.push({
      stub: {
        identifiers,
        ...(title === undefined ? {} : { title }),
        ...(container === undefined ? {} : { containerTitle: container }),
        ...(Number.isFinite(year) ? { issuedYear: year } : {}),
        ...(authors.length === 0 ? {} : { authors }),
      },
      ...(raw === undefined ? {} : { rawString: raw }),
      loose: false,
    });
  }
  return out;
};

export const isPdf = (bytes: Uint8Array): boolean =>
  bytes.byteLength > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

/** The reference list of a manuscript PDF, extracted by a GROBID sidecar (`processReferences`). */
export const readAuditPdf = async (
  bytes: Uint8Array,
  options: { grobidUrl: string; fetch?: (input: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number },
): Promise<AuditReference[]> => {
  const form = new FormData();
  form.set('input', new Blob([bytes], { type: 'application/pdf' }), 'manuscript.pdf');
  form.set('includeRawCitations', '1');
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const response = await fetchImpl(`${options.grobidUrl.replace(/\/+$/u, '')}/api/processReferences`, {
    method: 'POST',
    body: form,
    headers: { Accept: 'application/xml' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  });
  if (!response.ok) throw new Error(`GROBID answered ${response.status}`);
  const tei = await response.text();
  if (tei.length > MAX_TEI_BYTES) throw new Error('GROBID sent more than 16 MiB of TEI; refused (ADR-0022)');
  return parseTeiReferences(tei);
};
