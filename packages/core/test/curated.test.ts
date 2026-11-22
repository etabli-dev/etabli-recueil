import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError, VersionConflictError, emptyDocument } from '../src/index.js';
import type { CuratedDocument } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let lib: TestLibrary;
beforeEach(() => {
  lib = makeLibrary();
});
afterEach(() => {
  lib.dispose();
});

const doc = (itemId: string): CuratedDocument => ({
  ...emptyDocument(),
  nodes: [
    { id: 'a', kind: 'item', itemId },
    { id: 'b', kind: 'free', label: 'A cited classic' },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b', kind: 'manual' }],
  layout: { algorithm: 'manual', positions: { a: { x: 10, y: 20, pinned: true }, b: { x: 100, y: 120 } } },
});

describe('curated networks', () => {
  it('versions every save, and a frozen version keeps its metadata', () => {
    const item = lib.library.createItem({ itemType: 'article', title: 'Original title', bibliographic: { title: 'Original title', issuedYear: 2020 } }, lib.actor).item.id;
    const created = lib.curated.create({ name: 'Figure 2', document: doc(item) }, lib.actor);
    expect(created.version.version).toBe(1);
    expect(created.items[item]?.title).toBe('Original title');

    const frozen = lib.curated.freeze(created.network.id, lib.actor);
    expect(frozen.version.isFrozen).toBe(true);
    lib.library.updateItem(item, { title: 'Corrected title', bibliographic: { title: 'Corrected title' } }, lib.actor);

    // CN3: the frozen version shows what was true at freeze time; a new live version shows the correction.
    expect(lib.curated.resolve(created.network.id, 1).items[item]?.title).toBe('Original title');
    const saved = lib.curated.save(created.network.id, doc(item), lib.actor, { message: 'moved a node', expectedVersion: 1 });
    expect(saved.version.version).toBe(2);
    expect(saved.version.parentVersionId).toBe(frozen.version.id);
    expect(saved.items[item]?.title).toBe('Corrected title');
    expect(() => lib.curated.save(created.network.id, doc(item), lib.actor, { expectedVersion: 1 })).toThrow(VersionConflictError);
  });

  it('shows a trashed item as dangling instead of dropping it (CN2)', () => {
    const item = lib.library.createItem({ itemType: 'article', title: 'Gone' }, lib.actor).item.id;
    const created = lib.curated.create({ name: 'F', document: doc(item) }, lib.actor);
    lib.library.trashItem(item, lib.actor);
    expect(lib.curated.resolve(created.network.id).items[item]?.state).toBe('trashed');
    expect(lib.curated.resolve(created.network.id).document.nodes).toHaveLength(2);
  });

  it('refuses a document that does not hold together', () => {
    const broken = { ...emptyDocument(), nodes: [{ id: 'a', kind: 'free' as const }], edges: [{ id: 'e', source: 'a', target: 'z', kind: 'manual' as const }] };
    expect(() => lib.curated.create({ name: 'Bad', document: broken }, lib.actor)).toThrow(ValidationError);
    expect(() => lib.curated.create({ name: ' ', document: emptyDocument() }, lib.actor)).toThrow(ValidationError);
  });

  it('starts a figure from the citation graph', () => {
    const a = lib.library.createItem({ itemType: 'article', title: 'A', bibliographic: { title: 'A', doi: '10.1000/a' } }, lib.actor).item.id;
    lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W1', doi: '10.1000/w1', title: 'Cited' }, { source: 'openalex' });
    const document = lib.curated.documentFromGraph(lib.graph.citationNetwork());
    expect(document.nodes.map((node) => node.kind).sort()).toEqual(['free', 'item']);
    expect(document.edges[0]).toMatchObject({ kind: 'inherited', provenance: 'openalex' });
    expect(lib.curated.create({ name: 'From graph', document }, lib.actor).document.edges).toHaveLength(1);
  });
});
