import type { CheckSubject, HookContext, HttpResponse, ItemSnapshot } from '@recueil/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  citationKey,
  completeness,
  doiResolves,
  existence,
  identifierSyntax,
  plausibility,
  retraction,
  validIsbn,
  validIssn,
  venueIssn,
  versionDuplicate,
} from '../src/index.js';

const snapshot = (overrides: Partial<ItemSnapshot> = {}, bibliographic: Record<string, unknown> = {}): ItemSnapshot => ({
  id: 'item-1',
  itemType: 'article',
  title: 'Fracture healing in the elderly',
  extra: null,
  trashed: false,
  dateAdded: '2025-01-01T00:00:00.000Z',
  bibliographic: { title: 'Fracture healing in the elderly', containerTitle: 'Injury', issuedYear: 2020, ...bibliographic } as never,
  creators: [{ role: 'author', family: 'Lovelace', given: 'Ada', literal: null, orcid: null }],
  tags: [],
  attachments: [],
  ...overrides,
});

const item = (s: ItemSnapshot): CheckSubject => ({ type: 'item', itemId: s.id, snapshot: s as never });

const ctx = (routes: Record<string, unknown> = {}, items: ItemSnapshot[] = []): HookContext =>
  ({
    now: () => '2026-11-21T10:00:00.000Z',
    settings: { get: async () => ({}) },
    http: {
      get: async (url: string): Promise<HttpResponse> => {
        const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
        if (key === undefined) return { status: 404, headers: {}, text: '' };
        return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(routes[key]), json: routes[key] as never };
      },
    },
    library: {
      listItems: async () => ({ records: items }),
      findByIdentifier: async () => [],
      getItem: async () => null,
    },
  }) as unknown as HookContext;

describe('checksums', () => {
  it('validates ISBNs and ISSNs', () => {
    expect(validIsbn('978-0-306-40615-7')).toBe(true);
    expect(validIsbn('9780306406158')).toBe(false);
    expect(validIsbn('0-306-40615-2')).toBe(true);
    expect(validIssn('0020-1383')).toBe(true);
    expect(validIssn('0020-1384')).toBe(false);
  });
});

describe('offline checks', () => {
  it('completeness names what is missing', async () => {
    const [result] = await completeness.run(item(snapshot({ creators: [] }, { containerTitle: null })), ctx());
    expect(result).toMatchObject({ status: 'fail', message: 'missing journal or book title, author' });
    const [ok] = await completeness.run(item(snapshot()), ctx());
    expect(ok?.status).toBe('pass');
  });

  it('identifier syntax names the bad identifier', async () => {
    const results = await identifierSyntax.run(item(snapshot({}, { doi: '10.12/x', isbn: '9780306406158', pmid: '12a' })), ctx());
    expect(results.map((r) => r.message)).toEqual([
      'DOI 10.12/x is not well formed',
      'ISBN 9780306406158 is not well formed',
      'PMID 12a is not well formed',
    ]);
  });

  it('plausibility catches backwards pages and future years', async () => {
    const results = await plausibility.run(item(snapshot({}, { pageFirst: 120, pageLast: 101, issuedYear: 2040 })), ctx());
    expect(results.map((r) => r.message)).toEqual(['the page range ends (101) before it starts (120)', 'the year 2040 is implausible']);
  });

  it('venue ISSN catches a wrong check digit', async () => {
    const [result] = await venueIssn.run(item(snapshot({}, { issn: '0020-1384' })), ctx());
    expect(result?.status).toBe('fail');
  });

  it('citation keys: case-insensitive collisions and bad characters', async () => {
    const items = [
      snapshot({ id: 'a' }, { citationKey: 'smith2020' }),
      snapshot({ id: 'b' }, { citationKey: 'Smith2020' }),
      snapshot({ id: 'c' }, { citationKey: 'bad key{}' }),
    ];
    const results = await citationKey.run({ type: 'library', scope: {} }, ctx({}, items));
    expect(results.filter((r) => r.status === 'fail').map((r) => r.subjectId).sort()).toEqual(['a', 'b']);
    expect(results.find((r) => r.subjectId === 'c')?.status).toBe('warn');
  });

  it('version duplicates: two arXiv versions of one paper', async () => {
    const items = [snapshot({ id: 'a' }, { arxivId: '2101.00001v1' }), snapshot({ id: 'b' }, { arxivId: '2101.00001v2' })];
    const results = await versionDuplicate.run({ type: 'library', scope: {} }, ctx({}, items));
    expect(results.map((r) => [r.subjectId, r.status])).toEqual([
      ['a', 'warn'],
      ['b', 'warn'],
    ]);
  });
});

describe('network checks', () => {
  it('doi_resolves fails a DOI the handle system does not know', async () => {
    const [result] = await doiResolves.run(item(snapshot({}, { doi: '10.1234/gone' })), ctx({ 'https://doi.org/api/handles/': { responseCode: 100 } }));
    expect(result).toMatchObject({ status: 'fail', message: 'DOI 10.1234/gone does not resolve' });
  });

  it('doi_resolves warns when the DOI points at another work', async () => {
    const [result] = await doiResolves.run(
      item(snapshot({}, { doi: '10.1234/x' })),
      ctx({
        'https://doi.org/api/handles/': { responseCode: 1 },
        'https://api.crossref.org/works/': {
          status: 'ok',
          message: { title: ['Cardiac output in marathon runners'], published: { 'date-parts': [[2020]] }, author: [{ family: 'Lovelace' }] },
        },
      }),
    );
    expect(result?.status).toBe('warn');
    expect(result?.message).toContain('the title there is "Cardiac output in marathon runners"');
  });

  it('existence flags a reference no database knows', async () => {
    const subject: CheckSubject = {
      type: 'reference',
      localRef: 'ref-0001',
      stub: { identifiers: [], title: 'A wholly invented study of quantum orthopaedics', issuedYear: 2023, authors: [{ family: 'Nobody' }] },
    };
    const [result] = await existence.run(subject, ctx({ 'https://api.crossref.org/works?': { message: { items: [] } }, 'https://api.openalex.org/works?': { results: [] } }));
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('possibly fabricated');
  });

  it('existence accepts a reference Crossref knows', async () => {
    const subject: CheckSubject = { type: 'reference', localRef: 'ref-0002', stub: { identifiers: [], title: 'Fracture healing in the elderly', issuedYear: 2020 } };
    const [result] = await existence.run(
      subject,
      ctx({ 'https://api.crossref.org/works?': { message: { items: [{ title: ['Fracture Healing in the Elderly'], DOI: '10.1234/X', issued: { 'date-parts': [[2020]] } }] } } }),
    );
    expect(result).toMatchObject({ status: 'pass', message: 'found in crossref as DOI 10.1234/x' });
  });

  it('retraction fails a retracted DOI', async () => {
    const [result] = await retraction.run(
      item(snapshot({}, { doi: '10.1234/x' })),
      ctx({ 'https://api.crossref.org/works?filter=updates': { message: { items: [{ DOI: '10.1234/notice', 'update-to': [{ DOI: '10.1234/X', type: 'retraction' }] }] } } }),
    );
    expect(result).toMatchObject({ status: 'fail', message: 'DOI 10.1234/x has been retracted (notice 10.1234/notice)' });
  });
});
