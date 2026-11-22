/**
 * What a scholarly page says about itself, read in the page.
 *
 * `extractPageMetadata` is injected into the tab with `scripting.executeScript({ func })`, which
 * serialises the function's source: it must not close over anything, so every helper is defined
 * inside it. It reads, in order of trust: Highwire `citation_*` tags (what Google Scholar indexes,
 * and what nearly every publisher and repository emits), Dublin Core, JSON-LD
 * `ScholarlyArticle`/`Book`, Open Graph, and finally a DOI in the address or the page.
 */
export interface PageAuthor {
  family?: string;
  given?: string;
  literal?: string;
}

export interface PageMetadata {
  url: string;
  itemType: 'article' | 'conference_paper' | 'book' | 'chapter' | 'thesis' | 'report' | 'preprint' | 'webpage';
  title: string | null;
  authors: PageAuthor[];
  date: string | null;
  year: number | null;
  containerTitle: string | null;
  volume: string | null;
  issue: string | null;
  firstPage: string | null;
  lastPage: string | null;
  doi: string | null;
  pmid: string | null;
  isbn: string | null;
  issn: string | null;
  publisher: string | null;
  abstract: string | null;
  language: string | null;
  pdfUrl: string | null;
  /** Which source supplied the title: `highwire`, `dublin-core`, `json-ld`, `open-graph`, `document`. */
  source: string;
}

export function extractPageMetadata(doc: Document = document, pageUrl: string = location.href): PageMetadata {
  const metas = (name: string): string[] =>
    [...doc.querySelectorAll('meta')]
      .filter((meta) => (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase() === name.toLowerCase())
      .map((meta) => (meta.getAttribute('content') ?? '').replace(/\s+/gu, ' ').trim())
      .filter((value) => value !== '');
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      const hit = metas(name)[0];
      if (hit !== undefined) return hit;
    }
    return null;
  };
  const DOI = /\b(10\.\d{4,9}\/[^\s"'<>&?#]+[^\s"'<>&?#.,;)\]])/u;
  const cleanDoi = (value: string | null): string | null => {
    if (value === null) return null;
    const match = DOI.exec(decodeURIComponent(value));
    return match === null ? null : match[1]!.toLowerCase();
  };
  const absolute = (href: string | null): string | null => {
    if (href === null) return null;
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return null;
    }
  };
  const splitName = (raw: string): PageAuthor => {
    const name = raw.trim();
    if (name.includes(',')) {
      const [family, ...rest] = name.split(',');
      return { family: family!.trim(), given: rest.join(',').trim() };
    }
    const parts = name.split(/\s+/u);
    if (parts.length === 1) return { literal: name };
    return { family: parts.at(-1)!, given: parts.slice(0, -1).join(' ') };
  };

  // JSON-LD, the first scholarly node.
  type Ld = Record<string, unknown>;
  let ld: Ld | null = null;
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? '');
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Ld)['@graph']) ? ((parsed as Ld)['@graph'] as unknown[]) : [parsed];
      const found = nodes.find((node) => {
        const type = (node as Ld | null)?.['@type'];
        const types = Array.isArray(type) ? type : [type];
        return types.some((t) => typeof t === 'string' && /^(ScholarlyArticle|Article|Book|Chapter|Thesis|Report|MedicalScholarlyArticle)$/u.test(t));
      });
      if (found !== undefined) {
        ld = found as Ld;
        break;
      }
    } catch {
      // A page with broken JSON-LD still has its meta tags.
    }
  }
  const ldText = (key: string): string | null => {
    const value = ld?.[key];
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'object' && value !== null && typeof (value as Ld)['name'] === 'string') return ((value as Ld)['name'] as string).trim() || null;
    return null;
  };

  let source = 'document';
  let title = meta('citation_title');
  if (title !== null) source = 'highwire';
  if (title === null && (title = meta('dc.title', 'dcterms.title')) !== null) source = 'dublin-core';
  if (title === null && (title = ldText('headline') ?? ldText('name')) !== null) source = 'json-ld';
  if (title === null && (title = meta('og:title')) !== null) source = 'open-graph';
  if (title === null) title = doc.title.trim() || null;

  let authors: PageAuthor[] = metas('citation_author').map(splitName);
  if (authors.length === 0) authors = [...metas('dc.creator'), ...metas('dcterms.creator')].map(splitName);
  if (authors.length === 0 && ld !== null) {
    const raw = ld['author'];
    for (const entry of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      if (typeof entry === 'string') authors.push(splitName(entry));
      else if (typeof entry === 'object' && entry !== null) {
        const person = entry as Ld;
        if (typeof person['familyName'] === 'string') authors.push({ family: person['familyName'] as string, ...(typeof person['givenName'] === 'string' ? { given: person['givenName'] as string } : {}) });
        else if (typeof person['name'] === 'string') authors.push(person['@type'] === 'Organization' ? { literal: person['name'] as string } : splitName(person['name'] as string));
      }
    }
  }

  const date = meta('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date', 'dcterms.issued', 'article:published_time') ?? ldText('datePublished');
  const yearMatch = date === null ? null : /(\d{4})/u.exec(date);
  const doi = cleanDoi(meta('citation_doi', 'dc.identifier', 'prism.doi', 'bepress_citation_doi')) ?? cleanDoi(pageUrl) ?? cleanDoi(ldText('doi')) ?? cleanDoi(doc.querySelector('a[href*="doi.org/10."]')?.getAttribute('href') ?? null);
  const journal = meta('citation_journal_title', 'prism.publicationname', 'dc.source');
  const conference = meta('citation_conference_title');
  const isbn = meta('citation_isbn');
  const thesis = meta('citation_dissertation_institution');
  const report = meta('citation_technical_report_institution');
  const preprintServer = /arxiv\.org|biorxiv\.org|medrxiv\.org|ssrn\.com|osf\.io\/preprints|researchsquare\.com/u.test(pageUrl);
  const ldType = typeof ld?.['@type'] === 'string' ? (ld['@type'] as string) : null;
  const itemType: PageMetadata['itemType'] = conference !== null
    ? 'conference_paper'
    : thesis !== null || ldType === 'Thesis'
      ? 'thesis'
      : report !== null || ldType === 'Report'
        ? 'report'
        : preprintServer && journal === null
          ? 'preprint'
          : journal !== null || doi !== null || ldType === 'ScholarlyArticle' || ldType === 'MedicalScholarlyArticle'
            ? 'article'
            : meta('citation_inbook_title') !== null || ldType === 'Chapter'
              ? 'chapter'
              : isbn !== null || ldType === 'Book'
                ? 'book'
                : 'webpage';

  const pmidRaw = meta('citation_pmid');
  return {
    url: meta('citation_public_url', 'citation_abstract_html_url') !== null ? absolute(meta('citation_public_url', 'citation_abstract_html_url')) ?? pageUrl : pageUrl,
    itemType,
    title,
    authors,
    date,
    year: yearMatch === null ? null : Number(yearMatch[1]),
    containerTitle: conference ?? journal ?? meta('citation_inbook_title') ?? ldText('isPartOf'),
    volume: meta('citation_volume', 'prism.volume'),
    issue: meta('citation_issue', 'prism.number'),
    firstPage: meta('citation_firstpage', 'prism.startingpage'),
    lastPage: meta('citation_lastpage', 'prism.endingpage'),
    doi,
    pmid: pmidRaw !== null && /^\d{1,9}$/u.test(pmidRaw) ? pmidRaw : null,
    isbn,
    issn: meta('citation_issn', 'prism.issn', 'prism.eissn'),
    publisher: meta('citation_publisher', 'dc.publisher', 'citation_dissertation_institution', 'citation_technical_report_institution') ?? ldText('publisher'),
    abstract: meta('citation_abstract', 'dc.description', 'dcterms.abstract', 'description', 'og:description') ?? ldText('description'),
    language: meta('citation_language', 'dc.language') ?? (doc.documentElement.getAttribute('lang') || null),
    pdfUrl: absolute(meta('citation_pdf_url')),
    source,
  };
}
