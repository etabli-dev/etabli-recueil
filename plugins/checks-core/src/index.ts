/**
 * `@recueil/plugin-checks-core` — the thirteen checks of CONCEPT §5.5.
 *
 * Every check is read-only and deterministic for a given subject and upstream state (spec/hooks.md
 * §6.2). Each message names the specific problem — "DOI 10.x/y does not resolve", never "DOI check
 * failed" — and each check that consulted an upstream source says which one, and when, as evidence.
 */
import { canonicalDoi, nameKey, normaliseTitle, titleSimilarity } from '@recueil/plugin-sdk';
import type { Check, CheckResult, CheckSubject, HookContext, ItemSnapshot, Provenance, WorkStub } from '@recueil/plugin-sdk';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type Json = { [k: string]: JsonValue };

/* -------------------------------------------------------------------------------------------- */
/* Shared                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const bib = (snapshot: ItemSnapshot): Json => (snapshot.bibliographic ?? {}) as Json;
const text = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' ? String(value) : null;
const num = (value: JsonValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const itemOf = (subject: CheckSubject): ItemSnapshot | null =>
  subject.type === 'item' ? (subject.snapshot as unknown as ItemSnapshot) : null;

const subjectIdOf = (subject: CheckSubject): string => {
  switch (subject.type) {
    case 'item':
      return subject.itemId;
    case 'attachment':
      return subject.attachmentId;
    case 'document':
      return subject.documentId;
    case 'creator':
      return subject.creatorId;
    case 'reference':
      return subject.localRef;
    case 'library':
      return 'library';
  }
};

const result = (
  check: Pick<Check, 'id' | 'severity' | 'autoFixable'>,
  subject: CheckSubject,
  status: CheckResult['status'],
  message: string,
  extra: { detail?: Json; evidence?: Provenance[]; severity?: CheckResult['severity']; subjectId?: string; itemId?: string } = {},
): CheckResult => {
  const itemId =
    extra.itemId ?? (subject.type === 'item' ? subject.itemId : subject.type === 'attachment' ? subject.itemId : undefined);
  return {
    checkId: check.id,
    subjectType: extra.subjectId === undefined ? subject.type : 'item',
    subjectId: extra.subjectId ?? subjectIdOf(subject),
    ...(itemId === undefined ? {} : { itemId }),
    status,
    severity: status === 'pass' || status === 'skipped' ? 'info' : (extra.severity ?? check.severity),
    message,
    autoFixable: check.autoFixable,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
  };
};

/** What a check knows about a work, whether it is an item or a parsed reference. */
interface Work {
  title: string | null;
  year: number | null;
  firstAuthor: string | null;
  doi: string | null;
  identifiers: { scheme: string; value: string }[];
}

const workOf = (subject: CheckSubject): Work | null => {
  const item = itemOf(subject);
  if (item !== null) {
    const b = bib(item);
    const ids: Work['identifiers'] = [];
    for (const [scheme, column] of [
      ['doi', 'doi'],
      ['pmid', 'pmid'],
      ['pmcid', 'pmcid'],
      ['arxiv', 'arxivId'],
      ['isbn', 'isbn'],
    ] as const) {
      const value = text(b[column]);
      if (value !== null) ids.push({ scheme, value });
    }
    const author = item.creators.find((creator) => creator.role === 'author') ?? item.creators[0];
    return {
      title: item.title ?? text(b['title']),
      year: num(b['issuedYear']),
      firstAuthor: author?.family ?? author?.literal ?? null,
      doi: canonicalDoi(text(b['doi']) ?? ''),
      identifiers: ids,
    };
  }
  if (subject.type === 'reference') {
    const stub: WorkStub = subject.stub;
    const doi = stub.identifiers.find((id) => id.scheme === 'doi')?.value ?? null;
    return {
      title: stub.title ?? null,
      year: stub.issuedYear ?? null,
      firstAuthor: stub.authors?.[0]?.family ?? stub.authors?.[0]?.literal ?? null,
      doi: doi === null ? null : canonicalDoi(doi),
      identifiers: stub.identifiers.map((id) => ({ scheme: id.scheme, value: id.value })),
    };
  }
  return null;
};

const http = (ctx: HookContext) => {
  if (ctx.http === undefined) throw new Error('network:outbound is not granted');
  return ctx.http;
};

const mailto = async (ctx: HookContext): Promise<string | undefined> => {
  const value = ((await ctx.settings.get()) as { mailto?: string }).mailto;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const getJson = async (ctx: HookContext, url: string, headers: Record<string, string> = {}): Promise<Json | null> => {
  const contact = await mailto(ctx);
  const response = await http(ctx).get(url, {
    headers: { 'User-Agent': `Recueil checks${contact ? ` (mailto:${contact})` : ''}`, ...headers },
  });
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status} (${new URL(url).host})`);
  const value = response.json ?? JSON.parse(response.text === '' ? 'null' : response.text);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
};

const evidence = (source: string, ctx: HookContext, recordId?: string): Provenance => ({
  source,
  ...(recordId === undefined ? {} : { sourceRecordId: recordId }),
  fetchedAt: ctx.now(),
  confidence: 0.9,
});

const crossrefMessage = async (doi: string, ctx: HookContext): Promise<Json | null> => {
  const contact = await mailto(ctx);
  const body = await getJson(ctx, `https://api.crossref.org/works/${encodeURIComponent(doi)}${contact ? `?mailto=${encodeURIComponent(contact)}` : ''}`);
  return body?.['status'] === 'ok' ? ((body['message'] ?? null) as Json | null) : null;
};

const crossrefYear = (message: Json): number | null => {
  for (const key of ['published', 'published-print', 'published-online', 'issued']) {
    const parts = ((message[key] as Json | undefined)?.['date-parts'] as JsonValue[][] | undefined)?.[0];
    if (Array.isArray(parts) && typeof parts[0] === 'number') return parts[0];
  }
  return null;
};

/* -------------------------------------------------------------------------------------------- */
/* Checksums                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export const validIsbn = (raw: string): boolean => {
  const value = raw.replace(/[-\s]/gu, '').toUpperCase();
  if (/^\d{9}[\dX]$/u.test(value)) {
    const sum = [...value].reduce((total, char, index) => total + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/u.test(value)) {
    const sum = [...value].reduce((total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
};

export const validIssn = (raw: string): boolean => {
  const value = raw.replace(/-/gu, '').toUpperCase();
  if (!/^\d{7}[\dX]$/u.test(value)) return false;
  const sum = [...value.slice(0, 7)].reduce((total, char, index) => total + Number(char) * (8 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? 'X' : String(check)) === value[7];
};

const ARXIV = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/u;

/* -------------------------------------------------------------------------------------------- */
/* 1. completeness                                                                                 */
/* -------------------------------------------------------------------------------------------- */

const REQUIRED: Record<string, readonly string[]> = {
  article: ['title', 'containerTitle', 'issuedYear', 'creators'],
  book: ['title', 'publisher', 'issuedYear', 'creators'],
  chapter: ['title', 'containerTitle', 'publisher', 'issuedYear', 'creators'],
  thesis: ['title', 'publisher', 'issuedYear', 'creators'],
  report: ['title', 'publisher', 'issuedYear'],
  conference_paper: ['title', 'containerTitle', 'issuedYear', 'creators'],
  preprint: ['title', 'issuedYear', 'creators'],
  dataset: ['title', 'issuedYear'],
  software: ['title', 'issuedYear'],
  webpage: ['title', 'url'],
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  containerTitle: 'journal or book title',
  publisher: 'publisher',
  issuedYear: 'year',
  creators: 'author',
  url: 'URL',
};

export const completeness: Check = {
  id: 'completeness',
  title: 'Required fields',
  severity: 'warning',
  explanation:
    'A reference needs certain fields before it can be cited: an article its journal, a book its publisher, almost everything a year and an author.',
  subjectTypes: ['item'],
  autoFixable: false,
  async run(subject) {
    const item = itemOf(subject)!;
    const required = REQUIRED[item.itemType];
    if (required === undefined) return [result(this, subject, 'pass', `no required fields are defined for ${item.itemType}`)];
    const b = bib(item);
    const missing = required.filter((field) =>
      field === 'creators' ? item.creators.length === 0 : field === 'title' ? text(item.title) === null && text(b['title']) === null : text(b[field]) === null,
    );
    if (missing.length === 0) return [result(this, subject, 'pass', 'every required field is present')];
    return [
      result(this, subject, 'fail', `missing ${missing.map((field) => FIELD_LABELS[field] ?? field).join(', ')}`, {
        detail: { missing },
      }),
    ];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 2. identifier_syntax                                                                            */
/* -------------------------------------------------------------------------------------------- */

export const identifierSyntax: Check = {
  id: 'identifier_syntax',
  title: 'Identifier syntax',
  severity: 'error',
  explanation:
    'A malformed identifier cannot be resolved, and a wrong ISBN or ISSN check digit usually means a typing error. DOIs, ISBNs, ISSNs, PMIDs, PMCIDs and arXiv ids are checked for their form and check digits.',
  subjectTypes: ['item', 'reference'],
  autoFixable: false,
  async run(subject) {
    const problems: string[] = [];
    const item = itemOf(subject);
    const values: [string, string][] = [];
    if (item !== null) {
      const b = bib(item);
      for (const [label, column] of [
        ['DOI', 'doi'],
        ['ISBN', 'isbn'],
        ['ISSN', 'issn'],
        ['eISSN', 'eissn'],
        ['PMID', 'pmid'],
        ['PMCID', 'pmcid'],
        ['arXiv id', 'arxivId'],
      ] as const) {
        const value = text(b[column]);
        if (value !== null) values.push([label, value]);
      }
    } else if (subject.type === 'reference') {
      for (const id of subject.stub.identifiers) values.push([id.scheme.toUpperCase(), id.value]);
    }
    for (const [label, value] of values) {
      const ok =
        label === 'DOI'
          ? canonicalDoi(value) !== null
          : label === 'ISBN'
            ? validIsbn(value)
            : label === 'ISSN' || label === 'eISSN' || label === 'ISSN_L'
              ? validIssn(value)
              : label === 'PMID'
                ? /^\d{1,9}$/u.test(value)
                : label === 'PMCID'
                  ? /^PMC\d+$/u.test(value)
                  : label === 'arXiv id' || label === 'ARXIV'
                    ? ARXIV.test(value)
                    : true;
      if (!ok) problems.push(`${label} ${value} is not well formed`);
    }
    if (problems.length === 0) return [result(this, subject, 'pass', values.length === 0 ? 'no identifiers' : 'every identifier is well formed')];
    return problems.map((message) => result(this, subject, 'fail', message));
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 3. doi_resolves                                                                                 */
/* -------------------------------------------------------------------------------------------- */

export const doiResolves: Check = {
  id: 'doi_resolves',
  title: 'DOI resolves and matches',
  severity: 'error',
  explanation:
    'A DOI that does not resolve is a dead citation. One that resolves to different metadata — another title, another year, another first author — usually points at the wrong work.',
  subjectTypes: ['item', 'reference'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const work = workOf(subject)!;
    if (work.doi === null) return [result(this, subject, 'skipped', 'no DOI to resolve')];
    const handle = await getJson(ctx, `https://doi.org/api/handles/${encodeURIComponent(work.doi)}`);
    const proof = [evidence('doi.org', ctx, work.doi)];
    if (handle === null || handle['responseCode'] !== 1) {
      return [result(this, subject, 'fail', `DOI ${work.doi} does not resolve`, { evidence: proof })];
    }
    const message = await crossrefMessage(work.doi, ctx);
    if (message === null) return [result(this, subject, 'pass', `DOI ${work.doi} resolves (no Crossref metadata to compare)`, { evidence: proof })];
    proof.push(evidence('crossref', ctx, work.doi));
    const disagreements: string[] = [];
    const remoteTitle = text((message['title'] as JsonValue[] | undefined)?.[0]);
    if (work.title !== null && remoteTitle !== null) {
      const similarity = titleSimilarity(work.title, remoteTitle);
      if (similarity < 0.8) disagreements.push(`the title there is "${remoteTitle}" (${similarity.toFixed(2)} alike)`);
    }
    const remoteYear = crossrefYear(message);
    if (work.year !== null && remoteYear !== null && Math.abs(work.year - remoteYear) > 1) {
      disagreements.push(`the year there is ${remoteYear}, not ${work.year}`);
    }
    const remoteFirst = (message['author'] as Json[] | undefined)?.[0];
    const remoteSurname = text(remoteFirst?.['family']) ?? text(remoteFirst?.['name']);
    if (work.firstAuthor !== null && remoteSurname !== null && nameKey(work.firstAuthor) !== nameKey(remoteSurname)) {
      disagreements.push(`the first author there is ${remoteSurname}, not ${work.firstAuthor}`);
    }
    if (disagreements.length === 0) return [result(this, subject, 'pass', `DOI ${work.doi} resolves to this work`, { evidence: proof })];
    return [
      result(this, subject, 'warn', `DOI ${work.doi} resolves, but ${disagreements.join('; ')}`, {
        severity: 'warning',
        evidence: proof,
        detail: { remoteTitle, remoteYear, remoteFirstAuthor: remoteSurname },
      }),
    ];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 4. existence                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export const existence: Check = {
  id: 'existence',
  title: 'The work exists',
  severity: 'error',
  explanation:
    'A reference with no identifier that no bibliographic database knows may not exist at all. Reference lists written with a language model invent plausible-looking works; this is how they are caught.',
  subjectTypes: ['item', 'reference'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const work = workOf(subject)!;
    if (work.identifiers.length > 0) return [result(this, subject, 'pass', 'has an identifier; resolution is checked separately')];
    if (work.title === null) return [result(this, subject, 'fail', 'no identifier and no title: nothing to look for')];
    const contact = await mailto(ctx);
    const query = [work.title, work.firstAuthor ?? ''].join(' ').trim();
    const crossref = await getJson(
      ctx,
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5${contact ? `&mailto=${encodeURIComponent(contact)}` : ''}`,
    );
    const candidates: { title: string; year: number | null; doi: string | null; source: string }[] = [];
    for (const entry of ((crossref?.['message'] as Json | undefined)?.['items'] as Json[] | undefined) ?? []) {
      const title = text((entry['title'] as JsonValue[] | undefined)?.[0]);
      if (title !== null) candidates.push({ title, year: crossrefYear(entry), doi: canonicalDoi(text(entry['DOI']) ?? ''), source: 'crossref' });
    }
    if (!candidates.some((candidate) => matches(work, candidate))) {
      const openalex = await getJson(ctx, `https://api.openalex.org/works?search=${encodeURIComponent(work.title)}&per-page=5`);
      for (const entry of (openalex?.['results'] as Json[] | undefined) ?? []) {
        const title = text(entry['title']) ?? text(entry['display_name']);
        if (title !== null) {
          candidates.push({ title, year: num(entry['publication_year']), doi: canonicalDoi(text(entry['doi']) ?? ''), source: 'openalex' });
        }
      }
    }
    const match = candidates.find((candidate) => matches(work, candidate));
    const proof = [...new Set(candidates.map((candidate) => candidate.source).concat('crossref'))].map((source) => evidence(source, ctx));
    if (match !== undefined) {
      return [
        result(this, subject, 'pass', `found in ${match.source}${match.doi ? ` as DOI ${match.doi}` : ''}`, {
          evidence: proof,
          detail: { match: { title: match.title, year: match.year, doi: match.doi } },
        }),
      ];
    }
    return [
      result(this, subject, 'fail', `no identifier, and neither Crossref nor OpenAlex knows "${work.title}": unverifiable, possibly fabricated`, {
        evidence: proof,
      }),
    ];
  },
};

const matches = (work: Work, candidate: { title: string; year: number | null }): boolean =>
  titleSimilarity(work.title ?? '', candidate.title) >= 0.9 &&
  (work.year === null || candidate.year === null || Math.abs(work.year - candidate.year) <= 1);

/* -------------------------------------------------------------------------------------------- */
/* 5. retraction                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export const retraction: Check = {
  id: 'retraction',
  title: 'Retractions and corrections',
  severity: 'error',
  explanation:
    'A retracted paper should not be cited as evidence. Crossref records retractions, corrections and expressions of concern against the DOI they concern, including those collected by Retraction Watch.',
  subjectTypes: ['item', 'reference'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const work = workOf(subject)!;
    if (work.doi === null) return [result(this, subject, 'skipped', 'no DOI to look up')];
    const contact = await mailto(ctx);
    const body = await getJson(
      ctx,
      `https://api.crossref.org/works?filter=updates:${encodeURIComponent(work.doi)}&rows=20${contact ? `&mailto=${encodeURIComponent(contact)}` : ''}`,
    );
    const notices: { type: string; doi: string | null }[] = [];
    for (const entry of ((body?.['message'] as Json | undefined)?.['items'] as Json[] | undefined) ?? []) {
      for (const update of (entry['update-to'] as Json[] | undefined) ?? []) {
        if (canonicalDoi(text(update['DOI']) ?? '') !== work.doi) continue;
        notices.push({ type: (text(update['type']) ?? 'update').toLowerCase(), doi: canonicalDoi(text(entry['DOI']) ?? '') });
      }
    }
    const proof = [evidence('crossref', ctx, work.doi)];
    const retracted = notices.find((notice) => notice.type === 'retraction' || notice.type === 'withdrawal' || notice.type === 'removal');
    if (retracted !== undefined) {
      return [result(this, subject, 'fail', `DOI ${work.doi} has been retracted${retracted.doi ? ` (notice ${retracted.doi})` : ''}`, { evidence: proof, detail: { notices } })];
    }
    const concern = notices.find((notice) => notice.type.includes('concern'));
    if (concern !== undefined) {
      return [result(this, subject, 'warn', `DOI ${work.doi} carries an expression of concern${concern.doi ? ` (${concern.doi})` : ''}`, { severity: 'warning', evidence: proof, detail: { notices } })];
    }
    if (notices.length > 0) {
      return [result(this, subject, 'warn', `DOI ${work.doi} has ${notices.length} correction${notices.length === 1 ? '' : 's'}: ${notices.map((n) => n.type).join(', ')}`, { severity: 'info', evidence: proof, detail: { notices } })];
    }
    return [result(this, subject, 'pass', 'no retraction, correction or concern recorded', { evidence: proof })];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 6. preprint_published                                                                           */
/* -------------------------------------------------------------------------------------------- */

export const preprintPublished: Check = {
  id: 'preprint_published',
  title: 'Preprint has been published',
  severity: 'warning',
  explanation:
    'A preprint that has since appeared in a journal should usually be cited as the published version, which may differ from the preprint after peer review.',
  subjectTypes: ['item'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const item = itemOf(subject)!;
    const b = bib(item);
    const arxivId = text(b['arxivId']);
    const isPreprint = item.itemType === 'preprint' || b['isPreprint'] === true || arxivId !== null;
    if (!isPreprint) return [result(this, subject, 'pass', 'not a preprint')];
    const known = canonicalDoi(text(b['publishedVersionDoi']) ?? '');
    let published: string | null = known;
    const proof: Provenance[] = [];
    const doi = canonicalDoi(text(b['doi']) ?? '');
    if (published === null && doi !== null) {
      const message = await crossrefMessage(doi, ctx);
      proof.push(evidence('crossref', ctx, doi));
      const relation = (message?.['relation'] as Json | undefined)?.['is-preprint-of'] as Json[] | undefined;
      published = canonicalDoi(text(relation?.[0]?.['id']) ?? '');
    }
    if (published === null && arxivId !== null) {
      const response = await http(ctx).get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`);
      proof.push(evidence('arxiv', ctx, arxivId));
      published = canonicalDoi(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/u.exec(response.text)?.[1] ?? '');
    }
    if (published === null) return [result(this, subject, 'pass', 'no published version found', { evidence: proof })];
    const inLibrary = ctx.library === undefined ? [] : await ctx.library.findByIdentifier('doi', published);
    return [
      result(
        this,
        subject,
        'warn',
        inLibrary.length > 0
          ? `published as DOI ${published}, which is also in the library`
          : `published as DOI ${published}; cite the published version`,
        { severity: 'warning', evidence: proof, detail: { publishedDoi: published, inLibrary } },
      ),
    ];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 7. version_duplicate                                                                            */
/* -------------------------------------------------------------------------------------------- */

const allItems = async (ctx: HookContext): Promise<ItemSnapshot[]> => {
  if (ctx.library === undefined) throw new Error('items:read is not granted');
  const out: ItemSnapshot[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.library.listItems({ ...(cursor === undefined ? {} : { cursor }), limit: 500 });
    out.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
};

export const versionDuplicate: Check = {
  id: 'version_duplicate',
  title: 'Two versions of one work',
  severity: 'warning',
  explanation:
    'A preprint and its published version, or two arXiv versions of one paper, are the same work. Keeping both risks citing the wrong one.',
  subjectTypes: ['library'],
  autoFixable: false,
  async run(subject, ctx) {
    const items = await allItems(ctx);
    const results: CheckResult[] = [];
    const byArxiv = new Map<string, ItemSnapshot[]>();
    const byDoi = new Map<string, ItemSnapshot>();
    for (const item of items) {
      const b = bib(item);
      const arxivId = text(b['arxivId'])?.replace(/v\d+$/u, '');
      if (arxivId) byArxiv.set(arxivId, [...(byArxiv.get(arxivId) ?? []), item]);
      const doi = canonicalDoi(text(b['doi']) ?? '');
      if (doi !== null) byDoi.set(doi, item);
    }
    for (const [arxivId, group] of byArxiv) {
      if (group.length < 2) continue;
      for (const item of group) {
        results.push(result(this, subject, 'warn', `${group.length} items are versions of arXiv ${arxivId}`, { subjectId: item.id, itemId: item.id, detail: { items: group.map((g) => g.id) } }));
      }
    }
    for (const item of items) {
      const published = canonicalDoi(text(bib(item)['publishedVersionDoi']) ?? '');
      const other = published === null ? undefined : byDoi.get(published);
      if (other !== undefined && other.id !== item.id) {
        results.push(result(this, subject, 'warn', `this preprint's published version (DOI ${published}) is also in the library`, { subjectId: item.id, itemId: item.id, detail: { publishedItemId: other.id } }));
      }
    }
    if (results.length === 0) results.push(result(this, subject, 'pass', 'no work is in the library twice in different versions'));
    return results;
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 8. author_consistency                                                                           */
/* -------------------------------------------------------------------------------------------- */

export const authorConsistency: Check = {
  id: 'author_consistency',
  title: 'Author names match ORCID',
  severity: 'warning',
  explanation: 'An author with an ORCID iD whose surname differs from the ORCID record is either misspelt or attached to the wrong person.',
  subjectTypes: ['item'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const item = itemOf(subject)!;
    const withOrcid = item.creators.filter((creator) => creator.orcid !== null && creator.orcid !== '');
    if (withOrcid.length === 0) return [result(this, subject, 'pass', 'no creator carries an ORCID iD')];
    const results: CheckResult[] = [];
    for (const creator of withOrcid) {
      const person = await getJson(ctx, `https://pub.orcid.org/v3.0/${encodeURIComponent(creator.orcid!)}/person`, { Accept: 'application/json' });
      const family = text(((person?.['name'] as Json | undefined)?.['family-name'] as Json | undefined)?.['value']);
      if (person === null) results.push(result(this, subject, 'fail', `ORCID iD ${creator.orcid} does not exist`));
      else if (family !== null && creator.family !== null && nameKey(family) !== nameKey(creator.family)) {
        results.push(result(this, subject, 'warn', `${creator.family} carries ORCID iD ${creator.orcid}, which belongs to someone called ${family}`, { evidence: [evidence('orcid', ctx, creator.orcid!)] }));
      }
    }
    return results.length > 0 ? results : [result(this, subject, 'pass', 'every ORCID iD matches its author')];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 9. venue_issn, 10. plausibility                                                                 */
/* -------------------------------------------------------------------------------------------- */

export const venueIssn: Check = {
  id: 'venue_issn',
  title: 'Journal ISSN',
  severity: 'warning',
  explanation: 'An ISSN with a wrong check digit identifies no journal, which breaks venue-level analysis and some citation styles.',
  subjectTypes: ['item'],
  autoFixable: false,
  async run(subject) {
    const b = bib(itemOf(subject)!);
    const problems: string[] = [];
    for (const [label, column] of [
      ['ISSN', 'issn'],
      ['eISSN', 'eissn'],
      ['linking ISSN', 'issnL'],
    ] as const) {
      const value = text(b[column]);
      if (value !== null && !validIssn(value)) problems.push(`${label} ${value} has a wrong check digit or form`);
    }
    return problems.length === 0 ? [result(this, subject, 'pass', 'ISSNs are valid')] : problems.map((message) => result(this, subject, 'fail', message));
  },
};

export const plausibility: Check = {
  id: 'plausibility',
  title: 'Plausible values',
  severity: 'warning',
  explanation: 'Page ranges that run backwards, years in the future or before printing, and impossible months are almost always data-entry errors.',
  subjectTypes: ['item'],
  autoFixable: false,
  async run(subject, ctx) {
    const b = bib(itemOf(subject)!);
    const problems: string[] = [];
    const first = num(b['pageFirst']);
    const last = num(b['pageLast']);
    if (first !== null && last !== null && last < first) problems.push(`the page range ends (${last}) before it starts (${first})`);
    if (first !== null && last !== null && last - first > 5000) problems.push(`the page range spans ${last - first} pages`);
    const year = num(b['issuedYear']);
    const thisYear = Number(ctx.now().slice(0, 4));
    if (year !== null && (year < 1450 || year > thisYear + 1)) problems.push(`the year ${year} is implausible`);
    const month = num(b['issuedMonth']);
    if (month !== null && (month < 1 || month > 12)) problems.push(`the month ${month} does not exist`);
    const volume = text(b['volume']);
    if (volume !== null && /^\d+$/u.test(volume) && Number(volume) > 10_000) problems.push(`volume ${volume} is implausibly high`);
    return problems.length === 0 ? [result(this, subject, 'pass', 'values are plausible')] : problems.map((message) => result(this, subject, 'warn', message));
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 11. oa_status                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export const oaStatus: Check = {
  id: 'oa_status',
  title: 'Open-access copy available',
  severity: 'info',
  explanation: 'An open-access copy of a work that has no file in the library can usually be attached legally and for free.',
  subjectTypes: ['item'],
  autoFixable: false,
  requires: { network: true },
  async run(subject, ctx) {
    const item = itemOf(subject)!;
    const doi = canonicalDoi(text(bib(item)['doi']) ?? '');
    if (doi === null) return [result(this, subject, 'skipped', 'no DOI to look up')];
    if (item.attachments.some((attachment) => attachment.documentId !== null)) return [result(this, subject, 'pass', 'a file is attached')];
    const contact = await mailto(ctx);
    if (contact === undefined) return [result(this, subject, 'skipped', 'Unpaywall needs a contact address (setting `mailto`)')];
    const data = await getJson(ctx, `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(contact)}`);
    const best = (data?.['best_oa_location'] ?? null) as Json | null;
    const url = text(best?.['url_for_pdf']) ?? text(best?.['url']);
    if (data?.['is_oa'] === true && url !== null) {
      return [result(this, subject, 'warn', `an open-access copy is available at ${url}`, { severity: 'info', evidence: [evidence('unpaywall', ctx, doi)], detail: { url, oaStatus: text(data['oa_status']) } })];
    }
    return [result(this, subject, 'pass', 'no open-access copy known', { evidence: [evidence('unpaywall', ctx, doi)] })];
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 12. citation_key                                                                                */
/* -------------------------------------------------------------------------------------------- */

export const citationKey: Check = {
  id: 'citation_key',
  title: 'Citation keys',
  severity: 'error',
  explanation:
    'Two items whose citation keys differ only in case collide on case-insensitive systems and in some LaTeX tool chains; a key with spaces or braces breaks BibTeX; an item without a key cannot be cited from a manuscript.',
  subjectTypes: ['library'],
  autoFixable: false,
  async run(subject, ctx) {
    const items = await allItems(ctx);
    const results: CheckResult[] = [];
    const byLower = new Map<string, ItemSnapshot[]>();
    for (const item of items) {
      const key = text(bib(item)['citationKey']);
      if (key === null) {
        if (item.bibliographic !== null) results.push(result(this, subject, 'warn', 'no citation key', { severity: 'info', subjectId: item.id, itemId: item.id }));
        continue;
      }
      if (!/^[A-Za-z0-9_:.\-+/]+$/u.test(key)) {
        results.push(result(this, subject, 'warn', `the key "${key}" has characters BibTeX does not accept`, { severity: 'warning', subjectId: item.id, itemId: item.id }));
      }
      byLower.set(key.toLowerCase(), [...(byLower.get(key.toLowerCase()) ?? []), item]);
    }
    for (const group of byLower.values()) {
      if (group.length < 2) continue;
      for (const item of group) {
        results.push(result(this, subject, 'fail', `the key "${text(bib(item)['citationKey'])}" collides with ${group.length - 1} other item${group.length === 2 ? '' : 's'} when case is ignored`, { subjectId: item.id, itemId: item.id }));
      }
    }
    if (results.length === 0) results.push(result(this, subject, 'pass', 'every key is present, valid and unique'));
    return results;
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 13. attachment_integrity                                                                        */
/* -------------------------------------------------------------------------------------------- */

export const attachmentIntegrity: Check = {
  id: 'attachment_integrity',
  title: 'Attached files are intact',
  severity: 'error',
  explanation: 'An attachment whose bytes are missing from the store, or empty, cannot be read or exported; the library should be restored from a backup.',
  subjectTypes: ['attachment'],
  autoFixable: false,
  async run(subject, ctx) {
    if (subject.type !== 'attachment') return [];
    const snapshot = subject.snapshot as { documentId: string | null; sha256: string | null; title: string | null };
    if (snapshot.documentId === null) return [result(this, subject, 'skipped', 'a link, not a stored file')];
    if (snapshot.sha256 === null) return [result(this, subject, 'fail', 'the attachment names a document without a hash')];
    if (ctx.storage === undefined) return [result(this, subject, 'skipped', 'storage:read is not granted')];
    const size = await ctx.storage.size(snapshot.sha256);
    if (size === null) return [result(this, subject, 'fail', `the file ${snapshot.sha256.slice(0, 12)}… is missing from the store`)];
    if (size === 0) return [result(this, subject, 'fail', `the file ${snapshot.sha256.slice(0, 12)}… is empty`)];
    return [result(this, subject, 'pass', 'the file is in the store')];
  },
};

export { normaliseTitle };
export default {};
