/**
 * Parity with Metadata Mender (spec/parity-zotero-plugins.md §1.7, tests/reconciliation.test.js):
 * the same inputs, through the enrichment engine and the first-party resolvers, must give the
 * same outcome — or a stricter one where Recueil's locks apply.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EnrichmentEngine, PluginHost } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESOLVERS = { directory: join(here, '..', '..', '..', 'plugins', 'resolvers-core'), source: 'builtin' as const };
const NAME = '@recueil/plugin-resolvers-core';

let dir: string;
let recueil: Recueil;
let requests: { url: string; headers: Record<string, string> }[];
let routes: Record<string, () => Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
  requests.push({ url: input, headers });
  const key = Object.keys(routes).find((prefix) => input.startsWith(prefix));
  return key === undefined ? new Response('', { status: 404 }) : routes[key]!();
};

const crossrefWork = (overrides: Record<string, unknown> = {}) =>
  json({
    status: 'ok',
    message: {
      DOI: '10.1234/synthetic',
      title: ['A synthetic study of fracture healing'],
      'container-title': ['Injury'],
      volume: '4',
      author: [{ given: 'Example', family: 'Author' }],
      ...overrides,
    },
  });

const host = async (sources = ['crossref']) => {
  const first = new PluginHost(recueil, { plugins: [RESOLVERS] });
  await first.boot();
  first.setEnabled(NAME, true);
  const h = new PluginHost(recueil, { plugins: [RESOLVERS], fetch: fakeFetch, sleep: async () => undefined });
  await h.boot();
  return { engine: new EnrichmentEngine(recueil, h), sources };
};

const item = (bibliographic: Record<string, unknown>, extra: string | null = null, author = 'Author') => {
  const record = recueil.library.createItem(
    { itemType: 'article', title: 'A synthetic study of fracture healing', extra, bibliographic: { title: 'A synthetic study of fracture healing', ...bibliographic } },
    recueil.actor,
  );
  const creator = recueil.creators.create({ kind: 'person', familyName: author, givenName: 'Example' }, recueil.actor);
  recueil.creators.setItemCreators(record.item.id, [{ creatorId: creator.id, role: 'author' }], recueil.actor);
  return record.item.id;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-parity-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
  requests = [];
  routes = {};
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Metadata Mender parity', () => {
  it('fill keeps what is there and fills what is missing', async () => {
    routes['https://api.crossref.org/works/'] = crossrefWork({ issue: '9', volume: '5' });
    const { engine, sources } = await host();
    const id = item({ doi: '10.1234/synthetic', volume: '4' });
    const result = await engine.enrichItem(id, { sources });
    expect(result.status).toBe('updated');
    const bib = recueil.library.getItem(id).bibliographic;
    expect(bib?.volume).toBe('4');
    expect(bib?.issue).toBe('9');
  });

  it.each([
    ['a different DOI', { DOI: '10.1234/other' }],
    ['no DOI', { DOI: undefined }],
    ['an unrelated title', { title: ['Something else entirely about cardiology'] }],
    ['an author with a different surname', { author: [{ given: 'X', family: 'Different' }] }],
  ])('refuses a record with %s and writes nothing, even in overwrite mode', async (_label, overrides) => {
    routes['https://api.crossref.org/works/'] = crossrefWork({ ...overrides, issue: '9' });
    const { engine, sources } = await host();
    const id = item({ doi: '10.1234/synthetic' });
    const result = await engine.enrichItem(id, { sources, mode: 'overwrite' });
    expect(result.status).toBe('error');
    expect(result.sources['crossref']).toBe('conflict');
    expect(recueil.library.getItem(id).bibliographic?.issue).toBeNull();
  });

  it.each([
    ['a DOI in Extra that contradicts the field', { doi: '10.1234/synthetic' }, 'DOI: 10.1234/other'],
    ['two different PMIDs', { pmid: '12345' }, 'PMID: 67890'],
    ['an invalid PMID', {}, 'PMID: 12345invalid'],
    ['a CRAN URL that contradicts Extra', { url: 'https://cran.r-project.org/package=dplyr' }, 'CRAN: ggplot2'],
  ])('skips an item with %s before any request', async (_label, bibliographic, extra) => {
    const { engine, sources } = await host();
    const result = await engine.enrichItem(item(bibliographic, extra), { sources });
    expect(result.status).toBe('skipped');
    expect(requests).toHaveLength(0);
  });

  it('asks CRAN only for a CRAN package, even with a DOI', async () => {
    routes['https://crandb.r-pkg.org/ggplot2'] = json({ Package: 'ggplot2', Version: '3.5.1', Author: 'Hadley Wickham [aut]' });
    const { engine } = await host();
    const result = await engine.enrichItem(item({ doi: '10.1234/synthetic', url: 'https://cran.r-project.org/package=ggplot2' }));
    expect(Object.keys(result.sources)).toEqual(['cran']);
    expect(requests.every((request) => request.url.startsWith('https://crandb.r-pkg.org/'))).toBe(true);
    expect(recueil.library.getItem(result.itemId).bibliographic?.versionLabel).toBe('3.5.1');
  });

  it('gives up at once on a Retry-After longer than 30 s, with one request', async () => {
    routes['https://api.crossref.org/works/'] = json({}, 429, { 'Retry-After': '86400' });
    const { engine, sources } = await host();
    const result = await engine.enrichItem(item({ doi: '10.1234/synthetic' }), { sources });
    expect(result.status).toBe('error');
    expect(result.errors['crossref']).toBe('HTTP 429 (api.crossref.org)');
    expect(requests).toHaveLength(1);
  });

  it('retries a 503 with Retry-After 2 for three attempts in all', async () => {
    routes['https://api.crossref.org/works/'] = json({}, 503, { 'Retry-After': '2' });
    const { engine, sources } = await host();
    await engine.enrichItem(item({ doi: '10.1234/synthetic' }), { sources });
    expect(requests).toHaveLength(3);
  });

  it('never overwrites a locked field, where Mender would have in overwrite mode', async () => {
    routes['https://api.crossref.org/works/'] = crossrefWork({ volume: '5' });
    const { engine, sources } = await host();
    const id = item({ doi: '10.1234/synthetic' });
    recueil.library.updateItem(id, { bibliographic: { volume: '4' } }, recueil.actor); // a hand edit locks
    const result = await engine.enrichItem(id, { sources, mode: 'overwrite' });
    expect(result.locked).toContain('volume');
    expect(recueil.library.getItem(id).bibliographic?.volume).toBe('4');
  });

  it('records citation counts as dated observations, once per day', async () => {
    routes['https://api.crossref.org/works/'] = crossrefWork({ 'is-referenced-by-count': 7 });
    const { engine, sources } = await host();
    const id = item({ doi: '10.1234/synthetic' });
    await engine.enrichItem(id, { sources });
    await engine.enrichItem(id, { sources });
    const rows = recueil.connection.prepare('select metric, metric_value as value, source from item_metrics').all();
    expect(rows).toEqual([{ metric: 'cited_by_count', value: 7, source: 'crossref' }]);
  });

  it('writes nothing in a dry run', async () => {
    routes['https://api.crossref.org/works/'] = crossrefWork({ issue: '9' });
    const { engine, sources } = await host();
    const id = item({ doi: '10.1234/synthetic' });
    const result = await engine.enrichItem(id, { sources, dryRun: true });
    expect(result.changes['issue']?.after).toBe('9');
    expect(recueil.library.getItem(id).bibliographic?.issue).toBeNull();
  });
});
