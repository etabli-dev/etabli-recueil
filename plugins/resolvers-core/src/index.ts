/**
 * `@recueil/plugin-resolvers-core` — the first-party resolvers (CONCEPT §5.4).
 *
 * The eight sources Metadata Mender queried, with its endpoints, field mappings and request rates
 * (spec/parity-zotero-plugins.md §1.3, §1.6), plus DataCite, arXiv and Open Library. Each is one
 * `resolver` hook. They return records and never write: the host merges (spec/hooks.md §6.1).
 *
 * Conventions every resolver here keeps:
 * - a 404 or an empty answer is `[]`, never an error;
 * - fields are `bibliographic.<column>`, already in the facet's shapes (lower-case DOI, EDTF date,
 *   hyphenated ISSN), each with its own provenance;
 * - keys travel in headers where the source allows it, never in a logged URL, and the host's error
 *   messages name the host only.
 */
import { canonicalDoi } from '@recueil/plugin-sdk';
import type {
  HookContext,
  HttpResponse,
  Identifier,
  MetricObservation,
  Page,
  Provenance,
  Resolver,
  ResolverLookupRequest,
  ResolverRecord,
  WorkStub,
} from '@recueil/plugin-sdk';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type Json = { [k: string]: JsonValue };

interface Settings {
  mailto?: string;
  openalexKey?: string;
  ncbiKey?: string;
  crossrefPlusToken?: string;
  semanticScholarKey?: string;
  coreKey?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const settings = async (ctx: HookContext): Promise<Settings> => (await ctx.settings.get()) as Settings;

const http = (ctx: HookContext) => {
  if (ctx.http === undefined) throw new Error('network:outbound is not granted');
  return ctx.http;
};

const getJson = async (ctx: HookContext, url: string, headers: Record<string, string> = {}): Promise<Json | null> => {
  const response: HttpResponse = await http(ctx).get(url, { headers });
  if (response.status === 404 || response.status === 410) return null;
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status} (${new URL(url).host})`);
  const json = response.json ?? (response.text === '' ? null : (JSON.parse(response.text) as JsonValue));
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`invalid metadata response (${new URL(url).host})`);
  }
  return json as Json;
};

const userAgent = (mailto: string | undefined): Record<string, string> => ({
  'User-Agent': `Recueil (https://github.com/etabli-dev/etabli-recueil${mailto ? `; mailto:${mailto}` : ''})`,
});

const str = (value: JsonValue | undefined): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const first = (value: JsonValue | undefined): JsonValue | undefined => (Array.isArray(value) ? value[0] : value);

const obj = (value: JsonValue | undefined): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` from anything date-like; null otherwise. */
export const edtf = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/u.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day] = match;
  if (month === undefined) return year;
  const mm = month.padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12) return year;
  return day === undefined ? `${year}-${mm}` : `${year}-${mm}-${day.padStart(2, '0')}`;
};

export const issn = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const digits = value.replace(/[^0-9Xx]/gu, '').toUpperCase();
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : undefined;
};

/** MM `_normalizeLang`. */
const LANGUAGES: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl',
  rus: 'ru', chi: 'zh', zho: 'zh', jpn: 'ja', kor: 'ko', ara: 'ar', pol: 'pl', swe: 'sv',
};
export const language = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  return LANGUAGES[lower] ?? (/^[a-z]{2}(-[a-z0-9]+)*$/iu.test(value) ? lower : undefined);
};

/** "Ada Lovelace" → given "Ada", family "Lovelace" (MM `_splitName`); PubMed's "Smith JA" reversed. */
export const splitName = (name: string, lastFirst = false): { family?: string; given?: string } => {
  const parts = name.trim().split(/\s+/u).filter((part) => part !== '');
  if (parts.length === 0) return {};
  if (parts.length === 1) return { family: parts[0]! };
  if (lastFirst) return { family: parts.slice(0, -1).join(' '), given: parts[parts.length - 1]! };
  return { family: parts[parts.length - 1]!, given: parts.slice(0, -1).join(' ') };
};

const pmcid = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = /^(?:https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/|https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/)?(?:PMC)?([1-9]\d*)\/?$/iu.exec(value.trim());
  return match === null ? undefined : `PMC${match[1]}`;
};

class RecordBuilder {
  readonly fields: ResolverRecord['fields'] = {};
  readonly creators: NonNullable<ResolverRecord['creators']> = [];
  readonly matched: Identifier[] = [];
  constructor(private readonly provenance: Provenance) {}

  set(column: string, value: string | number | undefined | null): this {
    if (value === undefined || value === null || value === '') return this;
    this.fields[`bibliographic.${column}`] = { value, provenance: this.provenance };
    return this;
  }

  id(scheme: Identifier['scheme'], value: string | undefined): this {
    if (value !== undefined && value !== '' && !this.matched.some((id) => id.scheme === scheme && id.value === value)) {
      this.matched.push({ scheme, value });
    }
    return this;
  }

  creator(entry: { family?: string; given?: string; literal?: string; orcid?: string; role?: string }): this {
    if (entry.family === undefined && entry.literal === undefined) return this;
    this.creators.push({
      role: entry.role ?? 'author',
      ...(entry.family === undefined ? {} : { family: entry.family }),
      ...(entry.given === undefined || entry.given === '' ? {} : { given: entry.given }),
      ...(entry.literal === undefined ? {} : { literal: entry.literal }),
      ...(entry.orcid === undefined ? {} : { orcid: entry.orcid }),
      sequence: this.creators.length + 1,
      provenance: this.provenance,
    });
    return this;
  }

  build(itemType?: string, raw?: JsonValue): ResolverRecord {
    return {
      matched: this.matched,
      ...(itemType === undefined ? {} : { itemType }),
      fields: this.fields,
      creators: this.creators,
      score: 1,
      ...(raw === undefined ? {} : { raw }),
    };
  }
}

const provenance = (source: string, ctx: HookContext, recordId?: string): Provenance => ({
  source,
  ...(recordId === undefined ? {} : { sourceRecordId: recordId }),
  fetchedAt: ctx.now(),
  confidence: 0.9,
});

const idOf = (request: ResolverLookupRequest, scheme: Identifier['scheme']): string | undefined =>
  request.identifiers.find((id) => id.scheme === scheme)?.value;

const supports = (lookup: Identifier['scheme'][], metrics: string[] = []) => ({
  lookup,
  search: false,
  references: false,
  citations: false,
  metrics,
});

const metricOf = (identifier: Identifier, metric: string, value: unknown, source: string, ctx: HookContext): MetricObservation[] =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? [{ identifier, metric, value, observedAt: ctx.now(), provenance: provenance(source, ctx) }]
    : [];

/* -------------------------------------------------------------------------------------------- */
/* OpenAlex                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const openAlexWork = async (request: { identifiers: Identifier[] }, ctx: HookContext): Promise<Json | null> => {
  const s = await settings(ctx);
  const doi = idOf(request, 'doi');
  const pmid = idOf(request, 'pmid');
  const path = doi !== undefined ? `https://doi.org/${encodeURIComponent(doi)}` : pmid !== undefined ? `pmid:${pmid}` : null;
  if (path === null) return null;
  const headers: Record<string, string> = { ...userAgent(s.mailto) };
  if (s.openalexKey) headers['Authorization'] = `Bearer ${s.openalexKey}`;
  return getJson(ctx, `https://api.openalex.org/works/${path}`, headers);
};

/** Rebuild an abstract from OpenAlex's inverted index (MM `_reconstructAbstract`). */
export const invertedAbstract = (index: Json): string | undefined => {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of arr(positions)) if (typeof position === 'number') words[position] = word;
  }
  const text = words.filter((word) => word !== undefined).join(' ').trim();
  return text === '' ? undefined : text;
};

const openAlexStub = (work: Json): WorkStub => {
  const ids = obj(work['ids']);
  const identifiers: Identifier[] = [];
  const openalexId = str(work['id'])?.split('/').pop();
  if (openalexId !== undefined) identifiers.push({ scheme: 'openalex', value: openalexId });
  const doi = canonicalDoi(str(work['doi']) ?? '');
  if (doi !== null) identifiers.push({ scheme: 'doi', value: doi });
  const pmid = /(?:\/|^)(\d+)\/?$/u.exec(str(ids['pmid']) ?? '')?.[1];
  if (pmid !== undefined) identifiers.push({ scheme: 'pmid', value: pmid });
  const year = work['publication_year'];
  const container = str(obj(obj(work['primary_location'])['source'])['display_name']);
  const title = str(work['title']) ?? str(work['display_name']);
  return {
    identifiers,
    ...(title === undefined ? {} : { title }),
    ...(container === undefined ? {} : { containerTitle: container }),
    ...(typeof year === 'number' ? { issuedYear: year } : {}),
    authors: arr(work['authorships']).map((authorship) => splitName(str(obj(obj(authorship)['author'])['display_name']) ?? '')).filter((a) => a.family !== undefined),
    raw: { cited_by_count: typeof work['cited_by_count'] === 'number' ? work['cited_by_count'] : null },
  };
};

export const openalex: Resolver = {
  id: 'openalex',
  source: 'openalex',
  supports: { ...supports(['doi', 'pmid'], ['cited_by_count', 'venue_2yr_mean_citedness']), references: true },
  rateLimit: { requestsPerSecond: 10 },
  async lookup(request, ctx) {
    const data = await openAlexWork(request, ctx);
    if (data === null) return [];
    const openalexId = str(data['id'])?.split('/').pop();
    const record = new RecordBuilder(provenance('openalex', ctx, openalexId));
    const location = obj(data['primary_location']);
    const venue = obj(location['source']);
    const biblio = obj(data['biblio']);
    const ids = obj(data['ids']);
    const pages = [str(biblio['first_page']), str(biblio['last_page'])].filter((p) => p !== undefined);
    const doi = canonicalDoi(str(data['doi']) ?? '');
    record
      .set('title', str(data['title']) ?? str(data['display_name']))
      .set('doi', doi ?? undefined)
      .set('issuedDate', edtf(str(data['publication_date'])))
      .set('url', str(location['landing_page_url']))
      .set('containerTitle', str(venue['display_name']))
      .set('issnL', issn(str(venue['issn_l'])))
      .set('languageCode', language(str(data['language'])))
      .set('volume', str(biblio['volume']))
      .set('issue', str(biblio['issue']))
      .set('pages', pages.length === 0 ? undefined : pages.join('-'))
      .set('openalexId', openalexId)
      .set('abstract', data['abstract_inverted_index'] ? invertedAbstract(obj(data['abstract_inverted_index'])) : undefined)
      .set('oaUrl', str(obj(data['best_oa_location'])['pdf_url']) ?? str(obj(data['best_oa_location'])['landing_page_url']));
    const pmidValue = /(?:\/|^)(\d+)\/?$/u.exec(str(ids['pmid']) ?? '')?.[1];
    record.set('pmid', pmidValue).set('pmcid', pmcid(str(ids['pmcid'])));
    record.id('doi', doi ?? undefined).id('pmid', pmidValue).id('openalex', openalexId);
    for (const authorship of arr(data['authorships'])) {
      const author = obj(obj(authorship)['author']);
      const name = str(author['display_name']);
      if (name === undefined) continue;
      const orcid = str(author['orcid'])?.replace(/^https?:\/\/orcid\.org\//u, '');
      record.creator({ ...splitName(name), ...(orcid === undefined ? {} : { orcid }) });
    }
    return [record.build(undefined, { id: str(data['id']) ?? null })];
  },
  /** `referenced_works`, resolved to metadata 50 at a time; the cursor is an offset into the list. */
  async references(request, ctx): Promise<Page<WorkStub>> {
    const data = await openAlexWork({ identifiers: [request.identifier] }, ctx);
    if (data === null) return { records: [] };
    const all = arr(data['referenced_works']).map((id) => str(id)?.split('/').pop()).filter((id): id is string => id !== undefined && /^W\d+$/u.test(id));
    const offset = request.cursor === undefined ? 0 : Number(request.cursor) || 0;
    const slice = all.slice(offset, offset + Math.min(request.limit, 50));
    if (slice.length === 0) return { records: [], total: all.length };
    const s = await settings(ctx);
    const headers: Record<string, string> = { ...userAgent(s.mailto) };
    if (s.openalexKey) headers['Authorization'] = `Bearer ${s.openalexKey}`;
    const select = 'id,doi,title,display_name,publication_year,authorships,primary_location,ids,cited_by_count';
    const body = await getJson(ctx, `https://api.openalex.org/works?filter=openalex_id:${slice.join('|')}&per-page=50&select=${select}`, headers);
    const byId = new Map(arr(body?.['results']).map((work) => [str(obj(work)['id'])?.split('/').pop(), obj(work)]));
    // Order and completeness follow the reference list; an id OpenAlex did not return is kept bare.
    const records = slice.map((id) => (byId.has(id) ? openAlexStub(byId.get(id)!) : { identifiers: [{ scheme: 'openalex' as const, value: id }] }));
    const next = offset + slice.length;
    return { records, total: all.length, ...(next < all.length ? { cursor: String(next) } : {}) };
  },
  async metrics(request, ctx) {
    const data = await openAlexWork(request, ctx);
    if (data === null) return [];
    const identifier = request.identifiers[0]!;
    const out = metricOf(identifier, 'cited_by_count', data['cited_by_count'], 'openalex', ctx);
    const sourceId = str(obj(obj(data['primary_location'])['source'])['id'])?.split('/').pop();
    if (sourceId !== undefined && /^S\d+$/u.test(sourceId) && request.metrics.includes('venue_2yr_mean_citedness')) {
      // The venue changes slowly: one lookup per venue per UTC day (MM `_sourceCache`).
      const key = `venue:${sourceId}:${ctx.now().slice(0, 10)}`;
      let value = (await ctx.cache.get(key)) as number | null | undefined;
      if (value === undefined) {
        const s = await settings(ctx);
        const headers: Record<string, string> = { ...userAgent(s.mailto) };
        if (s.openalexKey) headers['Authorization'] = `Bearer ${s.openalexKey}`;
        const venue = await getJson(ctx, `https://api.openalex.org/sources/${sourceId}`, headers);
        const raw = venue !== null && str(venue['id']) === `https://openalex.org/${sourceId}` ? obj(venue['summary_stats'])['2yr_mean_citedness'] : null;
        value = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
        await ctx.cache.set(key, value, 86_400);
      }
      if (typeof value === 'number') {
        out.push({ identifier, metric: 'venue_2yr_mean_citedness', value, observedAt: ctx.now(), provenance: provenance('openalex', ctx) });
      }
    }
    return out;
  },
};

/* -------------------------------------------------------------------------------------------- */
/* Crossref                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const crossrefWork = async (doi: string, ctx: HookContext): Promise<Json | null> => {
  const s = await settings(ctx);
  const headers: Record<string, string> = { ...userAgent(s.mailto) };
  if (s.crossrefPlusToken) headers['Crossref-Plus-API-Token'] = `Bearer ${s.crossrefPlusToken}`;
  const query = s.mailto ? `?mailto=${encodeURIComponent(s.mailto)}` : '';
  const body = await getJson(ctx, `https://api.crossref.org/works/${encodeURIComponent(doi)}${query}`, headers);
  if (body === null || body['status'] !== 'ok') return null;
  return obj(body['message']);
};

const crossrefDate = (message: Json): string | undefined => {
  for (const key of ['published', 'published-print', 'published-online', 'issued']) {
    const parts = arr(obj(message[key])['date-parts'])[0];
    if (Array.isArray(parts) && typeof parts[0] === 'number') {
      return parts
        .filter((part): part is number => typeof part === 'number')
        .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
        .join('-');
    }
  }
  return undefined;
};

export const crossref: Resolver = {
  id: 'crossref',
  source: 'crossref',
  supports: { ...supports(['doi'], ['cited_by_count']), references: true },
  rateLimit: { requestsPerSecond: 20 },
  async lookup(request, ctx) {
    const doi = idOf(request, 'doi');
    if (doi === undefined) return [];
    const message = await crossrefWork(doi, ctx);
    if (message === null) return [];
    const found = canonicalDoi(str(message['DOI']) ?? '');
    const record = new RecordBuilder(provenance('crossref', ctx, found ?? undefined));
    record
      .set('title', str(first(message['title'])))
      .set('containerTitle', str(first(message['container-title'])))
      .set('containerShort', str(first(message['short-container-title'])))
      .set('volume', str(message['volume']))
      .set('issue', str(message['issue']))
      .set('pages', str(message['page']))
      .set('publisher', str(message['publisher']))
      .set('url', str(message['URL']))
      .set('issn', issn(str(first(message['ISSN']))))
      .set('languageCode', language(str(message['language'])))
      .set('issuedDate', edtf(crossrefDate(message)))
      .set('doi', found ?? undefined)
      .set('abstract', str(message['abstract'])?.replace(/<[^>]+>/gu, '').trim());
    record.id('doi', found ?? undefined);
    for (const author of arr(message['author'])) {
      const entry = obj(author);
      const orcid = str(entry['ORCID'])?.replace(/^https?:\/\/orcid\.org\//u, '');
      if (str(entry['family']) === undefined && str(entry['name']) !== undefined) record.creator({ literal: str(entry['name'])! });
      else record.creator({ family: str(entry['family']) ?? '', given: str(entry['given']) ?? '', ...(orcid === undefined ? {} : { orcid }) });
    }
    for (const editor of arr(message['editor'])) {
      const entry = obj(editor);
      record.creator({ family: str(entry['family']) ?? str(entry['name']) ?? '', given: str(entry['given']) ?? '', role: 'editor' });
    }
    return [record.build(str(message['type']))];
  },
  /** The deposited reference list, where the publisher deposited one; the cursor is an offset. */
  async references(request, ctx): Promise<Page<WorkStub>> {
    if (request.identifier.scheme !== 'doi') return { records: [] };
    const message = await crossrefWork(request.identifier.value, ctx);
    const all = arr(message?.['reference']).map((entry) => obj(entry));
    const offset = request.cursor === undefined ? 0 : Number(request.cursor) || 0;
    const slice = all.slice(offset, offset + request.limit);
    const records: WorkStub[] = slice.map((entry) => {
      const doi = canonicalDoi(str(entry['DOI']) ?? '');
      const title = str(entry['article-title']) ?? str(entry['volume-title']);
      const container = str(entry['journal-title']);
      const year = Number(/\d{4}/u.exec(str(entry['year']) ?? '')?.[0]);
      const author = str(entry['author']);
      const unstructured = str(entry['unstructured']);
      return {
        identifiers: doi === null ? [] : [{ scheme: 'doi' as const, value: doi }],
        ...(title === undefined ? {} : { title }),
        ...(container === undefined ? {} : { containerTitle: container }),
        ...(Number.isFinite(year) ? { issuedYear: year } : {}),
        ...(author === undefined ? {} : { authors: [{ family: author }] }),
        raw: { key: str(entry['key']) ?? null, unstructured: unstructured ?? null },
      };
    });
    const next = offset + slice.length;
    return { records, total: all.length, ...(next < all.length ? { cursor: String(next) } : {}) };
  },
  async metrics(request, ctx) {
    const doi = idOf(request, 'doi');
    if (doi === undefined) return [];
    const message = await crossrefWork(doi, ctx);
    if (message === null) return [];
    return metricOf({ scheme: 'doi', value: doi }, 'cited_by_count', message['is-referenced-by-count'], 'crossref', ctx);
  },
};

/* -------------------------------------------------------------------------------------------- */
/* PubMed                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const pubmed: Resolver = {
  id: 'pubmed',
  source: 'pubmed',
  supports: supports(['pmid', 'doi']),
  rateLimit: { requestsPerSecond: 3 },
  async lookup(request, ctx) {
    const s = await settings(ctx);
    const key = s.ncbiKey ? `&api_key=${encodeURIComponent(s.ncbiKey)}` : '';
    const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
    let pmidValue = idOf(request, 'pmid');
    const doi = idOf(request, 'doi');
    if (pmidValue === undefined && doi !== undefined) {
      const search = await getJson(ctx, `${base}/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(doi)}[DOI]${key}`, userAgent(s.mailto));
      pmidValue = str(arr(obj(search?.['esearchresult'])['idlist'])[0]);
    }
    if (pmidValue === undefined) return [];
    const summary = await getJson(ctx, `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${pmidValue}${key}`, userAgent(s.mailto));
    const entry = obj(obj(summary?.['result'])[pmidValue]);
    if (str(entry['uid']) === undefined) return [];
    const record = new RecordBuilder(provenance('pubmed', ctx, str(entry['uid'])));
    let foundDoi: string | undefined;
    let foundPmc: string | undefined;
    for (const articleId of arr(entry['articleids'])) {
      const idEntry = obj(articleId);
      const type = str(idEntry['idtype']);
      if (type === 'doi') foundDoi = canonicalDoi(str(idEntry['value']) ?? '') ?? undefined;
      if (type === 'pmc' || type === 'pmcid') foundPmc = /PMC\d+/u.exec(str(idEntry['value']) ?? '')?.[0];
    }
    const date = str(entry['sortpubdate'])?.split(' ')[0]?.replace(/\//gu, '-') ?? str(entry['pubdate']);
    record
      .set('title', str(entry['title']))
      .set('containerTitle', str(entry['fulljournalname']) ?? str(entry['source']))
      .set('containerShort', str(entry['source']))
      .set('volume', str(entry['volume']))
      .set('issue', str(entry['issue']))
      .set('pages', str(entry['pages']))
      .set('issuedDate', edtf(date))
      .set('pmid', str(entry['uid']))
      .set('doi', foundDoi)
      .set('pmcid', foundPmc)
      .set('issn', issn(str(entry['issn'])))
      .set('languageCode', language(str(first(entry['lang']))));
    record.id('pmid', str(entry['uid'])).id('doi', foundDoi).id('pmcid', foundPmc);
    for (const author of arr(entry['authors'])) {
      const a = obj(author);
      const name = str(a['name']);
      const type = str(a['authtype']);
      if (name === undefined) continue;
      if (type === 'CollectiveName') record.creator({ literal: name });
      else if (type === 'Author') record.creator(splitName(name, true));
    }
    return [record.build()];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* Semantic Scholar                                                                                */
/* -------------------------------------------------------------------------------------------- */

const s2Paper = async (request: { identifiers: Identifier[] }, ctx: HookContext): Promise<Json | null> => {
  const s = await settings(ctx);
  const doi = idOf(request, 'doi');
  const pmidValue = idOf(request, 'pmid');
  const id = doi !== undefined ? `DOI:${doi}` : pmidValue !== undefined ? `PMID:${pmidValue}` : null;
  if (id === null) return null;
  const headers: Record<string, string> = { ...userAgent(s.mailto) };
  if (s.semanticScholarKey) headers['x-api-key'] = s.semanticScholarKey;
  const fields = 'externalIds,title,abstract,year,publicationDate,journal,venue,authors,citationCount';
  const paper = await getJson(ctx, `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${fields}`, headers);
  return paper !== null && str(paper['paperId']) !== undefined ? paper : null;
};

export const semanticScholar: Resolver = {
  id: 'semanticscholar',
  source: 'semanticscholar',
  supports: supports(['doi', 'pmid'], ['cited_by_count']),
  rateLimit: { requestsPerSecond: 1 },
  async lookup(request, ctx) {
    const paper = await s2Paper(request, ctx);
    if (paper === null) return [];
    const ids = obj(paper['externalIds']);
    const journal = obj(paper['journal']);
    const doi = canonicalDoi(str(ids['DOI']) ?? '') ?? undefined;
    const record = new RecordBuilder(provenance('semanticscholar', ctx, str(paper['paperId'])));
    record
      .set('title', str(paper['title']))
      .set('abstract', str(paper['abstract']))
      .set('issuedDate', edtf(str(paper['publicationDate']) ?? str(paper['year'])))
      .set('containerTitle', str(journal['name']) ?? str(paper['venue']))
      .set('volume', str(journal['volume']))
      .set('pages', str(journal['pages'])?.trim())
      .set('doi', doi)
      .set('pmid', str(ids['PubMed']))
      .set('pmcid', pmcid(str(ids['PubMedCentral'])))
      .set('arxivId', str(ids['ArXiv']))
      .set('semanticScholarId', str(paper['paperId']));
    record.id('doi', doi).id('pmid', str(ids['PubMed'])).id('semantic_scholar', str(paper['paperId']));
    for (const author of arr(paper['authors'])) {
      const name = str(obj(author)['name']);
      if (name !== undefined) record.creator(splitName(name));
    }
    return [record.build()];
  },
  async metrics(request, ctx) {
    const paper = await s2Paper(request, ctx);
    if (paper === null) return [];
    return metricOf(request.identifiers[0]!, 'cited_by_count', paper['citationCount'], 'semanticscholar', ctx);
  },
};

/* -------------------------------------------------------------------------------------------- */
/* OpenAIRE, Unpaywall, CORE                                                                       */
/* -------------------------------------------------------------------------------------------- */

export const openaire: Resolver = {
  id: 'openaire',
  source: 'openaire',
  supports: supports(['doi']),
  rateLimit: { requestsPerSecond: 10 },
  async lookup(request, ctx) {
    const doi = idOf(request, 'doi');
    if (doi === undefined) return [];
    const s = await settings(ctx);
    const body = await getJson(ctx, `https://api.openaire.eu/graph/v1/researchProducts?pid=${encodeURIComponent(doi)}&pageSize=1`, userAgent(s.mailto));
    const result = obj(arr(body?.['results'])[0]);
    if (Object.keys(result).length === 0) return [];
    const record = new RecordBuilder(provenance('openaire', ctx));
    const container = obj(result['container']);
    const pages = [str(container['sp']), str(container['ep'])].filter((p) => p !== undefined);
    let foundDoi: string | undefined;
    for (const pid of arr(result['pids'])) {
      const entry = obj(pid);
      if (str(entry['scheme'])?.toLowerCase() === 'doi') foundDoi = canonicalDoi(str(entry['value']) ?? '') ?? undefined;
    }
    record
      .set('title', str(first(result['mainTitle'] ?? result['title'])))
      .set('abstract', str(first(result['descriptions'] ?? result['description'])))
      .set('issuedDate', edtf(str(result['publicationDate'])))
      .set('publisher', str(result['publisher']))
      .set('containerTitle', str(container['name']))
      .set('volume', str(container['vol']))
      .set('issue', str(container['iss']))
      .set('pages', pages.length === 0 ? undefined : pages.join('-'))
      .set('issn', issn(str(container['issnPrinted']) ?? str(container['issnOnline']) ?? str(container['issnLinking'])))
      .set('doi', foundDoi);
    record.id('doi', foundDoi);
    for (const author of arr(result['authors'])) {
      const name = str(obj(author)['fullName']) ?? str(obj(author)['name']);
      if (name === undefined) continue;
      if (name.includes(',')) {
        const [family, given] = name.split(',', 2).map((part) => part.trim());
        record.creator({ family: family ?? '', given: given ?? '' });
      } else record.creator(splitName(name));
    }
    return [record.build()];
  },
};

export const unpaywall: Resolver = {
  id: 'unpaywall',
  source: 'unpaywall',
  supports: supports(['doi']),
  rateLimit: { requestsPerSecond: 10 },
  async lookup(request, ctx) {
    const doi = idOf(request, 'doi');
    const s = await settings(ctx);
    // Unpaywall requires an email; without one it is not asked at all (MM 1.3).
    if (doi === undefined || !s.mailto) return [];
    const data = await getJson(ctx, `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(s.mailto)}`, userAgent(s.mailto));
    if (data === null) return [];
    const best = obj(data['best_oa_location']);
    const found = canonicalDoi(str(data['doi']) ?? '') ?? undefined;
    const record = new RecordBuilder(provenance('unpaywall', ctx));
    record
      .set('doi', found)
      .set('title', str(data['title']))
      .set('issuedDate', edtf(str(data['year'])))
      .set('containerTitle', str(data['journal_name']))
      .set('issnL', issn(str(data['journal_issn_l'])))
      .set('publisher', str(data['publisher']))
      .set('oaUrl', str(best['url_for_pdf']) ?? str(best['url']))
      .set('oaStatus', str(data['oa_status']));
    record.id('doi', found);
    for (const author of arr(data['z_authors'])) {
      const entry = obj(author);
      record.creator({ family: str(entry['family']) ?? '', given: str(entry['given']) ?? '' });
    }
    return [record.build()];
  },
};

export const core: Resolver = {
  id: 'core',
  source: 'core',
  supports: supports(['doi']),
  // CORE allows one request every six seconds without an agreement (MM 1.6).
  rateLimit: { requestsPerSecond: 1 / 6 },
  async lookup(request, ctx) {
    const doi = idOf(request, 'doi');
    const s = await settings(ctx);
    if (doi === undefined || !s.coreKey) return [];
    const body = await getJson(ctx, `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(`doi:"${doi}"`)}&limit=1`, {
      ...userAgent(s.mailto),
      Authorization: `Bearer ${s.coreKey}`,
    });
    const work = obj(arr(body?.['results'])[0]);
    if (Object.keys(work).length === 0) return [];
    const record = new RecordBuilder(provenance('core', ctx, str(work['id'])));
    const date = str(work['publishedDate'])?.split('T')[0] ?? str(work['datePublished'])?.split('T')[0] ?? str(work['yearPublished']);
    const found = canonicalDoi(str(work['doi']) ?? '') ?? undefined;
    record
      .set('title', str(work['title']))
      .set('abstract', str(work['abstract']))
      .set('issuedDate', edtf(date))
      .set('publisher', str(work['publisher']))
      .set('doi', found)
      .set('containerTitle', str(obj(arr(work['journals'])[0])['title']))
      .set('oaUrl', str(work['downloadUrl']));
    record.id('doi', found);
    for (const author of arr(work['authors'])) {
      const name = str(obj(author)['name']);
      if (name !== undefined) record.creator(splitName(name));
    }
    return [record.build()];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* CRAN                                                                                            */
/* -------------------------------------------------------------------------------------------- */

const CRAN_URL = /^https?:\/\/cran\.r-project\.org\/(?:package=([A-Za-z][A-Za-z0-9.]*)\/?|web\/packages\/([A-Za-z][A-Za-z0-9.]*)(?:\/(?:index\.html)?)?)(?:[?#].*)?$/iu;

export const cranPackage = (url: string): string | undefined => {
  const match = CRAN_URL.exec(url.trim());
  return match?.[1] ?? match?.[2];
};

/** DESCRIPTION authors: top-level commas only, roles and ORCIDs stripped (MM `_parseRDescriptionAuthors`). */
export const descriptionAuthors = (field: string | undefined): string[] => {
  if (field === undefined) return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of field) {
    if (char === '[' || char === '(' || char === '<') depth += 1;
    if (char === ']' || char === ')' || char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out
    .map((name) => name.replace(/\[[^\]]*\]|\([^)]*\)|<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim())
    .filter((name) => name !== '');
};

export const cran: Resolver = {
  id: 'cran',
  source: 'cran',
  supports: supports(['url']),
  rateLimit: { requestsPerSecond: 5 },
  async lookup(request, ctx) {
    const url = idOf(request, 'url');
    const name = url === undefined ? undefined : cranPackage(url);
    if (name === undefined) return [];
    const data = await getJson(ctx, `https://crandb.r-pkg.org/${encodeURIComponent(name)}`);
    const pkg = str(data?.['Package']);
    if (data === null || pkg === undefined) return [];
    const record = new RecordBuilder(provenance('cran', ctx, pkg));
    record
      .set('title', pkg)
      .set('publisher', 'Comprehensive R Archive Network (CRAN)')
      .set('url', `https://cran.r-project.org/package=${pkg}`)
      .set('abstract', (str(data['Description']) ?? str(data['Title']))?.replace(/\s+/gu, ' '))
      .set('versionLabel', str(data['Version']))
      .set('licence', str(data['License']))
      .set('issuedDate', edtf((str(data['Date/Publication']) ?? str(data['date']) ?? str(data['Date']))?.split(/[ T]/u)[0]));
    record.id('url', `https://cran.r-project.org/package=${pkg}`);
    for (const author of descriptionAuthors(str(data['Author']))) record.creator(splitName(author));
    return [record.build('software')];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* DataCite, arXiv, Open Library                                                                   */
/* -------------------------------------------------------------------------------------------- */

export const datacite: Resolver = {
  id: 'datacite',
  source: 'datacite',
  supports: supports(['doi']),
  rateLimit: { requestsPerSecond: 10 },
  async lookup(request, ctx) {
    const doi = idOf(request, 'doi');
    if (doi === undefined) return [];
    const body = await getJson(ctx, `https://api.datacite.org/dois/${encodeURIComponent(doi)}`);
    const attributes = obj(obj(body?.['data'])['attributes']);
    if (Object.keys(attributes).length === 0) return [];
    const found = canonicalDoi(str(attributes['doi']) ?? '') ?? undefined;
    const record = new RecordBuilder(provenance('datacite', ctx, found));
    const publisher = attributes['publisher'];
    record
      .set('title', str(obj(arr(attributes['titles'])[0])['title']))
      .set('doi', found)
      .set('dataciteDoi', found)
      .set('publisher', typeof publisher === 'string' ? publisher : str(obj(publisher)['name']))
      .set('issuedDate', edtf(str(attributes['publicationYear'])))
      .set('url', str(attributes['url']))
      .set('versionLabel', str(attributes['version']))
      .set('abstract', str(obj(arr(attributes['descriptions'])[0])['description']))
      .set('licence', str(obj(arr(attributes['rightsList'])[0])['rightsIdentifier']));
    record.id('doi', found);
    for (const creator of arr(attributes['creators'])) {
      const entry = obj(creator);
      if (str(entry['nameType']) === 'Organizational') record.creator({ literal: str(entry['name']) ?? '' });
      else record.creator({ family: str(entry['familyName']) ?? str(entry['name']) ?? '', given: str(entry['givenName']) ?? '' });
    }
    return [record.build(str(obj(attributes['types'])['resourceTypeGeneral'])?.toLowerCase())];
  },
};

const xmlText = (xml: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'u').exec(xml);
  return match?.[1]?.replace(/\s+/gu, ' ').trim();
};

export const arxiv: Resolver = {
  id: 'arxiv',
  source: 'arxiv',
  supports: supports(['arxiv']),
  // arXiv asks for no more than one request every three seconds.
  rateLimit: { requestsPerSecond: 1 / 3 },
  async lookup(request, ctx) {
    const id = idOf(request, 'arxiv');
    if (id === undefined) return [];
    const response = await http(ctx).get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    if (response.status !== 200) return [];
    const entry = /<entry>([\s\S]*?)<\/entry>/u.exec(response.text)?.[1];
    if (entry === undefined || xmlText(entry, 'title') === undefined || /<title>Error<\/title>/u.test(entry)) return [];
    const record = new RecordBuilder(provenance('arxiv', ctx, id));
    const publishedDoi = canonicalDoi(xmlText(entry, 'arxiv:doi') ?? '') ?? undefined;
    record
      .set('title', xmlText(entry, 'title'))
      .set('abstract', xmlText(entry, 'summary'))
      .set('issuedDate', edtf(xmlText(entry, 'published')))
      .set('arxivId', id)
      .set('url', `https://arxiv.org/abs/${id}`)
      .set('publishedVersionDoi', publishedDoi);
    record.id('arxiv', id);
    for (const author of entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/gu)) record.creator(splitName(author[1] ?? ''));
    return [record.build('preprint')];
  },
};

export const openlibrary: Resolver = {
  id: 'openlibrary',
  source: 'openlibrary',
  supports: supports(['isbn']),
  rateLimit: { requestsPerSecond: 2 },
  async lookup(request, ctx) {
    const isbn = idOf(request, 'isbn');
    if (isbn === undefined) return [];
    const body = await getJson(ctx, `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
    const book = obj(body?.[`ISBN:${isbn}`]);
    if (Object.keys(book).length === 0) return [];
    const record = new RecordBuilder(provenance('openlibrary', ctx, str(book['key'])));
    record
      .set('title', str(book['title']))
      .set('subtitle', str(book['subtitle']))
      .set('publisher', str(obj(arr(book['publishers'])[0])['name']))
      .set('publisherPlace', str(obj(arr(book['publish_places'])[0])['name']))
      .set('issuedDate', edtf(/\d{4}/u.exec(str(book['publish_date']) ?? '')?.[0]))
      .set('numberOfPages', typeof book['number_of_pages'] === 'number' ? book['number_of_pages'] : undefined)
      .set('isbn', isbn)
      .set('url', str(book['url']));
    record.id('isbn', isbn);
    for (const author of arr(book['authors'])) {
      const name = str(obj(author)['name']);
      if (name !== undefined) record.creator(splitName(name));
    }
    return [record.build('book')];
  },
};

export default {};
