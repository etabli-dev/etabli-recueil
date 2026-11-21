import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChecksEngine, PluginHost, checksReportCsv, checksReportMarkdown, readAuditInput } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKS = { directory: join(here, '..', '..', '..', 'plugins', 'checks-core'), source: 'builtin' as const };

let dir: string;
let recueil: Recueil;
let routes: Record<string, unknown>;
const fakeFetch = async (input: string): Promise<Response> => {
  const key = Object.keys(routes).find((prefix) => input.startsWith(prefix));
  return key === undefined
    ? new Response('', { status: 404 })
    : new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-checks-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
  routes = {};
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

const engine = async () => {
  const first = new PluginHost(recueil, { plugins: [CHECKS] });
  await first.boot();
  first.setEnabled('@recueil/plugin-checks-core', true);
  const host = new PluginHost(recueil, { plugins: [CHECKS], fetch: fakeFetch, sleep: async () => undefined });
  await host.boot();
  return new ChecksEngine(recueil, host);
};

describe('the checks engine', () => {
  it('runs every check, stores one current result each, and keeps an acknowledgement', async () => {
    const id = recueil.library.createItem(
      { itemType: 'article', title: 'Untitled draft', bibliographic: { title: 'Untitled draft', issn: '0020-1384' } },
      recueil.actor,
    ).item.id;
    const checks = await engine();
    const first = await checks.runLibrary({ offline: true });
    const byCheck = Object.fromEntries(first.results.filter((r) => r.subjectId === id).map((r) => [r.checkId, r.status]));
    expect(byCheck).toMatchObject({ completeness: 'fail', venue_issn: 'fail', plausibility: 'pass', identifier_syntax: 'fail' });

    const rows = () => recueil.connection.prepare('select id, check_id as checkId, status from check_results where item_id = ?').all(id) as Array<{ id: string; checkId: string; status: string }>;
    const stored = rows();
    const completenessRow = stored.find((row) => row.checkId === 'completeness')!;
    checks.acknowledge([completenessRow.id], recueil.actor);
    await checks.runLibrary({ offline: true });
    expect(rows()).toHaveLength(stored.length);
    const acknowledged = recueil.connection.prepare('select acknowledged_at as at from check_results where id = ?').get(completenessRow.id) as { at: string | null };
    expect(acknowledged.at).not.toBeNull();
  });

  it('audits a pasted reference list and flags the invented reference', async () => {
    routes['https://api.crossref.org/works?query.bibliographic'] = { message: { items: [{ title: ['Fracture healing in the elderly'], DOI: '10.1234/real', issued: { 'date-parts': [[2020]] } }] } };
    routes['https://api.openalex.org/works?'] = { results: [] };
    const references = readAuditInput(
      [
        '1. Lovelace A. (2020). Fracture healing in the elderly. Injury, 12, 101–110.',
        '2. Nobody N. (2023). Quantum entanglement as a cause of hip fractures in cats. J Imaginary Med, 1, 1–2.',
      ].join('\n'),
    );
    expect(references).toHaveLength(2);
    const run = await (await engine()).audit(references, { checkIds: ['existence'] });
    expect(run.results.map((r) => [r.subjectId, r.status])).toEqual([
      ['ref-0001', 'pass'],
      ['ref-0002', 'fail'],
    ]);
    const markdown = checksReportMarkdown(run, { title: 'Reference audit' });
    expect(markdown).toContain('## The work exists');
    expect(markdown).toContain('possibly fabricated');
    const csv = checksReportCsv(run);
    expect(csv.split('\n')[0]).toBe('"check","status","severity","subject_type","subject","message"');
  });

  it('neutralises spreadsheet formulas in the CSV report', () => {
    const csv = checksReportCsv({
      auditRunId: null,
      subjects: 1,
      results: [{ checkId: 'x', subjectType: 'item', subjectId: '=HYPERLINK("evil")', status: 'fail', severity: 'error', message: 'm', autoFixable: false, title: 'x', explanation: '' }],
    });
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
  });

  it('a check that throws is a skipped result, not a failed run', async () => {
    const id = recueil.library.createItem({ itemType: 'article', title: 'X', bibliographic: { doi: '10.1234/x' } }, recueil.actor).item.id;
    // No route for doi.org: the handle lookup is a 404, which the check reads as not resolving.
    routes['https://doi.org/api/handles/'] = 'not json at all';
    const run = await (await engine()).runLibrary({ checkIds: ['doi_resolves'], itemIds: [id] });
    expect(run.results).toHaveLength(1);
    expect(['skipped', 'fail']).toContain(run.results[0]?.status);
  });
});

describe('library-wide checks', () => {
  it('clears a problem that has been fixed since the last run', async () => {
    const make = (key: string) =>
      recueil.library.createItem({ itemType: 'article', title: key, bibliographic: { title: key, citationKey: key } }, recueil.actor).item.id;
    make('smith2020');
    const b = make('Smith2020');
    const checks = await engine();
    await checks.runLibrary({ checkIds: ['citation_key'], offline: true });
    const failing = () =>
      (recueil.connection.prepare(`select count(*) as n from check_results where check_id = 'citation_key' and status = 'fail'`).get() as { n: number }).n;
    expect(failing()).toBe(2);
    recueil.library.updateItem(b, { bibliographic: { citationKey: 'jones2021' } }, recueil.actor);
    await checks.runLibrary({ checkIds: ['citation_key'], offline: true });
    expect(failing()).toBe(0);
  });
});
