/**
 * Field mappings, and the Metadata Mender helper tests carried over as parity tests
 * (spec/parity-zotero-plugins.md §1.7, tests/helpers.test.js and tests/integrity.test.js).
 */
import type { HookContext, HttpResponse } from '@recueil/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  core,
  cran,
  cranPackage,
  crossref,
  descriptionAuthors,
  edtf,
  invertedAbstract,
  issn,
  language,
  openalex,
  pubmed,
  splitName,
  unpaywall,
} from '../src/index.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

const context = (routes: Record<string, unknown>, settings: Record<string, string> = {}): { ctx: HookContext; seen: Seen[] } => {
  const seen: Seen[] = [];
  const respond = (url: string): HttpResponse => {
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (key === undefined) return { status: 404, headers: {}, text: '' };
    const body = routes[key];
    return typeof body === 'string'
      ? { status: 200, headers: { 'content-type': 'application/atom+xml' }, text: body }
      : { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body), json: body as never };
  };
  const cache = new Map<string, unknown>();
  const ctx = {
    now: () => '2026-11-21T10:00:00.000Z',
    settings: { get: async () => settings, onChange: () => () => undefined, patch: async () => settings },
    cache: {
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => void cache.set(key, value),
      delete: async (key: string) => void cache.delete(key),
    },
    http: {
      get: async (url: string, options?: { headers?: Record<string, string> }) => {
        seen.push({ url, headers: options?.headers ?? {} });
        return respond(url);
      },
      post: async () => ({ status: 405, headers: {}, text: '' }),
    },
  } as unknown as HookContext;
  return { ctx, seen };
};

describe('Metadata Mender helpers, carried over', () => {
  it('splits names as MM did', () => {
    expect(splitName('John Smith')).toEqual({ family: 'Smith', given: 'John' });
    expect(splitName('Mary Jane Watson')).toEqual({ family: 'Watson', given: 'Mary Jane' });
    expect(splitName('')).toEqual({});
    expect(splitName('Smith JA', true)).toEqual({ family: 'Smith', given: 'JA' });
    expect(splitName('Müller H', true)).toEqual({ family: 'Müller', given: 'H' });
    expect(splitName('van der Waals JD', true)).toEqual({ family: 'van der Waals', given: 'JD' });
  });

  it('rebuilds an abstract in word order, repeated words included', () => {
    expect(invertedAbstract({ the: [0, 3], cat: [1], sat: [2], end: [4] })).toBe('the cat sat the end');
  });

  it('normalises languages', () => {
    expect(language('eng')).toBe('en');
    expect(language('ENG')).toBe('en');
    expect(language('ger')).toBe('de');
    expect(language('en')).toBe('en');
    expect(language('xyz')).toBeUndefined();
  });

  it('parses DESCRIPTION authors on top-level commas only', () => {
    expect(descriptionAuthors('Hadley Wickham [aut, cre] (<https://orcid.org/0000-0003-4757-117X>), Romain François [aut]')).toEqual([
      'Hadley Wickham',
      'Romain François',
    ]);
    expect(descriptionAuthors(undefined)).toEqual([]);
  });

  it('recognises CRAN URLs and refuses look-alikes', () => {
    expect(cranPackage('https://cran.r-project.org/package=ggplot2')).toBe('ggplot2');
    expect(cranPackage('https://cran.r-project.org/web/packages/data.table/index.html')).toBe('data.table');
    expect(cranPackage('https://example.org/cran.r-project.org/package=ggplot2')).toBeUndefined();
  });

  it('shapes dates and ISSNs for the facet', () => {
    expect(edtf('2020-5-3')).toBe('2020-05-03');
    expect(edtf('2020/05')).toBe('2020-05');
    expect(edtf('2020')).toBe('2020');
    expect(edtf('n.d.')).toBeUndefined();
    expect(issn('00201383')).toBe('0020-1383');
    expect(issn('nope')).toBeUndefined();
  });
});

describe('the resolvers', () => {
  it('Crossref: maps the work, pads the date, strips JATS from the abstract', async () => {
    const { ctx, seen } = context(
      {
        'https://api.crossref.org/works/10.1234%2Fsynthetic': {
          status: 'ok',
          message: {
            DOI: '10.1234/SYNTHETIC',
            title: ['A synthetic work'],
            'container-title': ['Injury'],
            'short-container-title': ['Injury'],
            volume: '4',
            issue: '2',
            page: '101-110',
            ISSN: ['00201383'],
            published: { 'date-parts': [[2020, 5, 3]] },
            abstract: '<jats:p>Bones heal.</jats:p>',
            author: [{ given: 'Ada', family: 'Lovelace', ORCID: 'https://orcid.org/0000-0002-1825-0097' }],
            'is-referenced-by-count': 12,
          },
        },
      },
      { mailto: 'owner@example.org' },
    );
    const [record] = await crossref.lookup({ identifiers: [{ scheme: 'doi', value: '10.1234/synthetic' }] }, ctx);
    expect(record?.fields['bibliographic.doi']?.value).toBe('10.1234/synthetic');
    expect(record?.fields['bibliographic.issuedDate']?.value).toBe('2020-05-03');
    expect(record?.fields['bibliographic.issn']?.value).toBe('0020-1383');
    expect(record?.fields['bibliographic.abstract']?.value).toBe('Bones heal.');
    expect(record?.creators?.[0]).toMatchObject({ family: 'Lovelace', given: 'Ada', orcid: '0000-0002-1825-0097' });
    expect(seen[0]?.url).toContain('mailto=owner%40example.org');
    const metrics = await crossref.metrics!({ identifiers: [{ scheme: 'doi', value: '10.1234/synthetic' }], metrics: ['cited_by_count'] }, ctx);
    expect(metrics[0]?.value).toBe(12);
  });

  it('OpenAlex: the key goes in a header, never the URL; PMIDs and PMCIDs are read strictly', async () => {
    const { ctx, seen } = context(
      {
        'https://api.openalex.org/works/': {
          id: 'https://openalex.org/W123',
          doi: 'https://doi.org/10.1234/synthetic',
          title: 'A synthetic work',
          publication_date: '2020-05-03',
          ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/' },
          biblio: { volume: '4', first_page: '101', last_page: '110' },
          authorships: [{ author: { display_name: 'Ada Lovelace' } }],
          abstract_inverted_index: { Bones: [0], heal: [1] },
        },
      },
      { openalexKey: 'k3y' },
    );
    const [record] = await openalex.lookup({ identifiers: [{ scheme: 'doi', value: '10.1234/synthetic' }] }, ctx);
    expect(seen[0]?.url).not.toContain('k3y');
    expect(seen[0]?.headers['Authorization']).toBe('Bearer k3y');
    expect(record?.fields['bibliographic.pmid']?.value).toBe('12345');
    expect(record?.fields['bibliographic.pmcid']?.value).toBe('PMC123');
    expect(record?.fields['bibliographic.pages']?.value).toBe('101-110');
    expect(record?.fields['bibliographic.abstract']?.value).toBe('Bones heal');
  });

  it('PubMed: collective names stay whole, investigators are dropped', async () => {
    const { ctx } = context({
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi': {
        result: {
          '12345': {
            uid: '12345',
            title: 'A synthetic work',
            fulljournalname: 'Injury',
            sortpubdate: '2020/05/03 00:00',
            authors: [
              { name: 'van der Waals JD', authtype: 'Author' },
              { name: 'Trauma Study Group', authtype: 'CollectiveName' },
              { name: 'Someone X', authtype: 'Investigator' },
              { name: '', authtype: 'Author' },
            ],
            articleids: [{ idtype: 'doi', value: '10.1234/SYNTHETIC' }, { idtype: 'pmc', value: 'PMC999' }],
          },
        },
      },
    });
    const [record] = await pubmed.lookup({ identifiers: [{ scheme: 'pmid', value: '12345' }] }, ctx);
    expect(record?.creators?.map((c) => c.family ?? c.literal)).toEqual(['van der Waals', 'Trauma Study Group']);
    expect(record?.fields['bibliographic.issuedDate']?.value).toBe('2020-05-03');
    expect(record?.fields['bibliographic.doi']?.value).toBe('10.1234/synthetic');
    expect(record?.fields['bibliographic.pmcid']?.value).toBe('PMC999');
  });

  it('asks Unpaywall only with an address and CORE only with a key', async () => {
    const { ctx, seen } = context({});
    expect(await unpaywall.lookup({ identifiers: [{ scheme: 'doi', value: '10.1234/x' }] }, ctx)).toEqual([]);
    expect(await core.lookup({ identifiers: [{ scheme: 'doi', value: '10.1234/x' }] }, ctx)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('CRAN: a package from crandb', async () => {
    const { ctx } = context({
      'https://crandb.r-pkg.org/ggplot2': {
        Package: 'ggplot2',
        Title: 'Create Elegant Data Visualisations',
        Description: 'A system for\n  declaratively creating graphics.',
        Version: '3.5.1',
        License: 'MIT + file LICENSE',
        'Date/Publication': '2024-04-23 08:00:02 UTC',
        Author: 'Hadley Wickham [aut], Winston Chang [aut]',
      },
    });
    const [record] = await cran.lookup({ identifiers: [{ scheme: 'url', value: 'https://cran.r-project.org/package=ggplot2' }] }, ctx);
    expect(record?.fields['bibliographic.versionLabel']?.value).toBe('3.5.1');
    expect(record?.fields['bibliographic.issuedDate']?.value).toBe('2024-04-23');
    expect(record?.fields['bibliographic.abstract']?.value).toBe('A system for declaratively creating graphics.');
    expect(record?.creators).toHaveLength(2);
  });

  it('a 404 is no match, not an error', async () => {
    const { ctx } = context({});
    expect(await crossref.lookup({ identifiers: [{ scheme: 'doi', value: '10.1234/missing' }] }, ctx)).toEqual([]);
  });
});
