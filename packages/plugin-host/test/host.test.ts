import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DedupEngine, EnrichmentEngine, PluginHost } from '../src/index.js';
import type { PluginSource } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEDUP_CORE = join(here, '..', '..', '..', 'plugins', 'dedup-core');

let dir: string;
let recueil: Recueil;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-host-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway plugin on disk: a manifest and an ES module. */
const writePlugin = (name: string, manifest: Record<string, unknown>, module: string): PluginSource => {
  const root = join(dir, 'plugins', name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'recueil.plugin.json'),
    JSON.stringify({
      name: `@test/${name}`,
      version: '1.0.0',
      description: 'A plugin written by the host test suite.',
      author: { name: 'Test' },
      licence: 'MIT',
      recueilApi: '^1.0.0',
      main: './index.mjs',
      ...manifest,
    }),
  );
  writeFileSync(join(root, 'index.mjs'), module);
  return { directory: root, source: 'local' };
};

const fakeResolver = writePlugin.bind(null, 'resolver', {
  permissions: ['network:outbound'],
  hooks: [{ type: 'resolver', id: 'fake', export: 'resolver' }],
  settings: {
    type: 'object',
    properties: { apiKey: { type: 'string', 'x-recueil-secret': true }, mailto: { type: 'string', default: 'x@example.org' } },
  },
});

const boot = async (sources: PluginSource[], enable: string[] = [], env: Record<string, string> = {}) => {
  const first = new PluginHost(recueil, { plugins: sources, env });
  await first.boot();
  for (const name of enable) first.setEnabled(name, true);
  const host = new PluginHost(recueil, { plugins: sources, env, sleep: async () => undefined });
  await host.boot();
  return host;
};

describe('the host', () => {
  it('installs without enabling, and activates once enabled', async () => {
    const source = { directory: DEDUP_CORE, source: 'builtin' as const };
    const installed = new PluginHost(recueil, { plugins: [source] });
    await installed.boot();
    expect(installed.list()[0]).toMatchObject({ name: '@recueil/plugin-dedup-core', state: 'disabled' });
    expect(installed.dedupRules()).toHaveLength(0);

    const host = await boot([source], ['@recueil/plugin-dedup-core']);
    expect(host.list()[0]?.state).toBe('active');
    expect(host.dedupRules().map((hook) => hook.hookId)).toEqual(['identifier', 'fuzzy']);
  });

  it('marks a plugin that will not import as failed and keeps going', async () => {
    const broken = writePlugin('broken', { hooks: [{ type: 'check', id: 'xx', export: 'nope' }] }, 'throw new Error("boom");');
    const host = await boot([broken, { directory: DEDUP_CORE, source: 'builtin' }], ['@test/broken', '@recueil/plugin-dedup-core']);
    const states = Object.fromEntries(host.list().map((p) => [p.name, p.state]));
    expect(states['@test/broken']).toBe('failed');
    expect(states['@recueil/plugin-dedup-core']).toBe('active');
  });

  it('refuses a plugin that asks for another plugin API', async () => {
    const future = writePlugin('future', { recueilApi: '^2.0.0' }, 'export default {};');
    const host = await boot([future], ['@test/future']);
    expect(host.list()[0]).toMatchObject({ state: 'incompatible' });
  });

  it('never stores a secret, only a reference, and resolves it at call time', async () => {
    const source = fakeResolver(`
      export const resolver = {
        id: 'fake', source: 'fake',
        supports: { lookup: ['doi'], search: false, references: false, citations: false, metrics: [] },
        async lookup(req, ctx) { const s = await ctx.settings.get(); return [{ matched: req.identifiers, fields: { 'bibliographic.publisher': { value: s.apiKey ?? 'none', provenance: { source: 'fake', fetchedAt: ctx.now(), confidence: 0.5 } } }, score: 1 }]; },
      };
      export default {};`);
    const host = await boot([source], ['@test/resolver'], { FAKE_KEY: 'sekret' });
    expect(() => host.setSettings('@test/resolver', { apiKey: 'sekret' })).toThrow(/secret/);
    host.setSettings('@test/resolver', { apiKey: '${env:FAKE_KEY}' });
    const stored = recueil.connection.prepare('select settings from plugins').get() as { settings: string };
    expect(stored.settings).not.toContain('sekret');
    expect(host.list()[0]?.secrets).toEqual({ apiKey: true });

    const item = recueil.library.createItem({ itemType: 'article', title: 'X', bibliographic: { doi: '10.1000/x' } }, recueil.actor);
    const result = await new EnrichmentEngine(recueil, host).enrichItem(item.item.id);
    expect(result.errors).toEqual({});
    expect(result.changes['publisher']?.after).toBe('sekret');
  });

  it('times a hook out, and disables it after three in a row', async () => {
    const source = fakeResolver(`
      export const resolver = {
        id: 'fake', source: 'fake',
        supports: { lookup: ['doi'], search: false, references: false, citations: false, metrics: [] },
        lookup() { return new Promise(() => {}); },
      };
      export default {};`);
    const host = await boot([source], ['@test/resolver']);
    const hook = host.resolvers()[0]!;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(host.call(hook, 'lookup', [{ identifiers: [] }], { defaultTimeoutMs: 20, ceilingTimeoutMs: 20 })).rejects.toThrow(/exceeded/);
    }
    expect(host.resolvers()).toHaveLength(0);
  });
});

describe('the engines with real plugins', () => {
  it('merges an identifier duplicate and proposes a fuzzy one', async () => {
    const host = await boot([{ directory: DEDUP_CORE, source: 'builtin' }], ['@recueil/plugin-dedup-core']);
    const make = (title: string, bibliographic: Record<string, unknown>, dateAdded: string) =>
      recueil.library.createItem({ itemType: 'article', title, dateAdded, bibliographic: { title, ...bibliographic } }, recueil.actor).item.id;
    const older = make('Hip fractures in older adults', { issue: '2' }, '2024-01-01T00:00:00.000Z');
    // The importer drops a second live DOI (B1); the duplicate carries it in the PMID instead.
    recueil.library.updateItem(older, { bibliographic: { pmid: '123456' } }, recueil.actor);
    const newer = make('Hip fractures in older adults', { pmid: '123456', volume: '7' }, '2025-01-01T00:00:00.000Z');
    const fuzzyA = make('Outcomes of distal radius fracture fixation', { issuedYear: 2019 }, '2024-02-01T00:00:00.000Z');
    const fuzzyB = make('Outcomes of distal radius fracture fixation.', { issuedYear: 2020 }, '2024-03-01T00:00:00.000Z');

    const engine = new DedupEngine(recueil, host);
    const plan = await engine.run();
    expect(plan.dryRun).toBe(true);
    const auto = plan.groups.find((group) => group.decision === 'auto')!;
    expect(auto.winnerId).toBe(newer);
    expect(auto.loserIds).toEqual([older]);
    const review = plan.groups.find((group) => group.decision === 'review')!;
    expect(review.itemIds.sort()).toEqual([fuzzyA, fuzzyB].sort());
    expect(recueil.library.getItem(older).item.trashedAt).toBeNull();

    const applied = await engine.run({ dryRun: false });
    expect(applied.groups.find((group) => group.decision === 'auto')?.merged).toBe(true);
    expect(recueil.library.getItem(older, { includeTrashed: true }).item.libraryState).toBe('merged');
    expect(recueil.library.getItem(newer).bibliographic?.issue).toBe('2');
    const queued = recueil.connection
      .prepare(`select reason_code as reason from review_queue where status = 'open'`)
      .all() as Array<{ reason: string }>;
    expect(queued.map((row) => row.reason)).toEqual(['record_merge_candidate']);
  });
});
