/**
 * Parity with Argus One and Attaclone-dedup (spec/parity-zotero-plugins.md §2.6, §3.6).
 *
 * Argus One's rule — exact normalised DOI, newest wins, fill blanks, union of tags and children,
 * undo — runs here through the dedup engine, the identifier rule and `ItemMergeService`. Its DOI
 * duplicates arrive in Recueil as items whose second DOI the importer had to drop (two live items
 * may not share a DOI, B1); the importer keeps it in a custom field and the review queue, and the
 * engine sees the shared PMID or the DOI on one side. The tests below put the DOI on one item and
 * the same work's PMID on both, which is how such a pair actually looks after an import.
 *
 * Attaclone's whole job — identical PDF bytes attached twice to one item — cannot arise in
 * Recueil: the store is content-addressed (ADR-0004) and an item cannot carry the same document
 * twice (`ux_attachments_item_document`). The tests assert that structural guarantee.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { canonicalDoi } from '@recueil/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DedupEngine, PluginHost } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEDUP = { directory: join(here, '..', '..', '..', 'plugins', 'dedup-core'), source: 'builtin' as const };

let dir: string;
let recueil: Recueil;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-parity2-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

const engine = async () => {
  const first = new PluginHost(recueil, { plugins: [DEDUP] });
  await first.boot();
  first.setEnabled('@recueil/plugin-dedup-core', true);
  const host = new PluginHost(recueil, { plugins: [DEDUP] });
  await host.boot();
  return new DedupEngine(recueil, host);
};

const make = (dateAdded: string, bibliographic: Record<string, unknown>, itemType = 'article') =>
  recueil.library.createItem({ itemType, title: 'Same work', dateAdded, bibliographic: { title: 'Same work', ...bibliographic } }, recueil.actor)
    .item.id;

describe('Argus One parity', () => {
  it('normalises DOIs exactly as Argus One did', () => {
    expect(canonicalDoi('https://DX.DOI.org/10.1234/Example.')).toBe('10.1234/example.');
    expect(canonicalDoi(' DOI: 10.1234/A;B ')).toBe('10.1234/a;b');
    for (const bad of ['10.x/a', '10.12/a', 'https://example.org/10.1234/a']) expect(canonicalDoi(bad)).toBeNull();
  });

  it('keeps the newest, trashes the older, fills blanks, unites tags and moves the note; undo restores it', async () => {
    const older = make('2024-01-01T00:00:00.000Z', { pmid: '111', containerTitle: 'Journal', volume: '0' });
    const newer = make('2025-01-01T00:00:00.000Z', { pmid: '111', doi: '10.1234/same', issue: '' });
    recueil.tags.assignByName(older, 'from-older', recueil.actor);
    recueil.tags.assignByName(newer, 'from-newer', recueil.actor);
    recueil.notes.create({ itemId: older, contentMarkdown: 'Child note' }, recueil.actor);

    const run = await (await engine()).run({ dryRun: false });
    expect(run.groups).toHaveLength(1);
    expect(run.groups[0]).toMatchObject({ winnerId: newer, loserIds: [older], decision: 'auto', merged: true });

    const kept = recueil.library.getItem(newer);
    expect(kept.bibliographic?.containerTitle).toBe('Journal');
    // Argus One: numeric 0 is not blank and fills an empty field.
    expect(kept.bibliographic?.volume).toBe('0');
    expect(recueil.tags.forItem(newer).map((tag) => tag.name).sort()).toEqual(['from-newer', 'from-older']);
    expect(recueil.notes.forItem(newer)).toHaveLength(1);
    expect(recueil.library.getItem(older, { includeTrashed: true }).item.trashedAt).not.toBeNull();

    recueil.merges.unmerge(older, recueil.actor);
    expect(recueil.library.getItem(older).item.trashedAt).toBeNull();
    expect(recueil.notes.forItem(older)).toHaveLength(1);
    expect(recueil.library.getItem(newer).bibliographic?.containerTitle).toBeNull();
  });

  it('breaks a tie on date added by the higher id', async () => {
    const a = make('2025-01-01T00:00:00.000Z', { pmid: '222' });
    const b = make('2025-01-01T00:00:00.000Z', { pmid: '222' });
    const plan = await (await engine()).run();
    expect(plan.groups[0]?.winnerId).toBe([a, b].sort().at(-1));
  });

  it('does not merge items of different types without a person', async () => {
    make('2024-01-01T00:00:00.000Z', { pmid: '333' });
    make('2025-01-01T00:00:00.000Z', { pmid: '333' }, 'book');
    const plan = await (await engine()).run();
    expect(plan.groups[0]?.decision).toBe('review');
  });

  it('plans without writing by default', async () => {
    const older = make('2024-01-01T00:00:00.000Z', { pmid: '444' });
    make('2025-01-01T00:00:00.000Z', { pmid: '444' });
    const plan = await (await engine()).run();
    expect(plan.dryRun).toBe(true);
    expect(recueil.library.getItem(older).item.trashedAt).toBeNull();
  });
});

describe('Attaclone-dedup parity', () => {
  it('cannot hold the same PDF twice on one item', async () => {
    const item = make('2025-01-01T00:00:00.000Z', {});
    const bytes = Buffer.from('%PDF-1.4 the same bytes');
    await recueil.documents.ingestBuffer(bytes, { sourceKind: 'upload', attachTo: { itemId: item } });
    await recueil.documents.ingestBuffer(bytes, { sourceKind: 'upload', attachTo: { itemId: item } }).catch(() => undefined);
    const count = recueil.connection.prepare('select count(*) as n from attachments where item_id = ?').get(item) as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps two files of the same size with different bytes', async () => {
    const item = make('2025-01-01T00:00:00.000Z', {});
    await recueil.documents.ingestBuffer(Buffer.from('%PDF-1.4 aaaaaaaa'), { sourceKind: 'upload', attachTo: { itemId: item } });
    await recueil.documents.ingestBuffer(Buffer.from('%PDF-1.4 bbbbbbbb'), { sourceKind: 'upload', attachTo: { itemId: item, role: 'supplement' } });
    const count = recueil.connection.prepare('select count(*) as n from attachments where item_id = ?').get(item) as { n: number };
    expect(count.n).toBe(2);
  });
});
