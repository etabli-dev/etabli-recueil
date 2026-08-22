/**
 * Tags and tag assignments (§4.3, §4.4).
 *
 * TG1 — a rename is an update and assignments follow it — is the one worth guarding, because the
 * obvious wrong implementation (create the new tag, remap, delete the old) loses the assignment
 * metadata that says why each tag is there. TG2's reversible merge is the other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

import { ConflictError, NotFoundError, schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const makeItem = (title: string) =>
  library.library.createItem({ itemType: 'article', bibliographic: { title } }, library.actor).item;

describe('TagService — create and find', () => {
  it('creates a tag and refuses a duplicate name, case- and whitespace-insensitively', () => {
    const tag = library.tags.create({ name: 'Critical Care', colour: '#1e88e5' }, library.actor);
    expect(tag.nameNormalised).toBe('critical care');
    expect(tag.scheme).toBe('manual');

    expect(() => library.tags.create({ name: '  critical   care ' }, library.actor)).toThrow(
      ConflictError,
    );
  });

  it('ensure() is idempotent, which is what makes a re-import safe (P9)', () => {
    const first = library.tags.ensure('sepsis', library.actor);
    const second = library.tags.ensure('SEPSIS', library.actor);
    expect(second.id).toBe(first.id);
    expect(library.tags.list()).toHaveLength(1);
  });

  it('lists by prefix for autocomplete', () => {
    library.tags.create({ name: 'sepsis' }, library.actor);
    library.tags.create({ name: 'septic shock' }, library.actor);
    library.tags.create({ name: 'trauma' }, library.actor);

    expect(library.tags.list({ prefix: 'sep' }).map((tag) => tag.name).sort()).toEqual([
      'sepsis',
      'septic shock',
    ]);
    expect(library.tags.list({ prefix: 'SEP' })).toHaveLength(2);
  });
});

describe('TagService — assignment', () => {
  it('records why a tag is there, and refreshes rather than duplicating on reassignment', () => {
    const item = makeItem('A paper');
    const tag = library.tags.create({ name: 'auto', scheme: 'automatic' }, library.actor);

    library.tags.assign(item.id, tag.id, library.actor, {
      source: 'rule',
      ruleRef: 'ingest/invoice-sender',
      confidence: 0.7,
    });

    const [assigned] = library.tags.forItem(item.id);
    expect(assigned?.source).toBe('rule');
    expect(assigned?.ruleRef).toBe('ingest/invoice-sender');
    expect(assigned?.confidence).toBeCloseTo(0.7);

    library.tags.assign(item.id, tag.id, library.actor, { source: 'manual' });
    expect(library.tags.forItem(item.id)).toHaveLength(1);
    expect(library.tags.forItem(item.id)[0]?.source).toBe('manual');
  });

  it('unassigns, and reports whether there was anything to unassign', () => {
    const item = makeItem('A paper');
    const tag = library.tags.ensure('keep', library.actor);
    library.tags.assign(item.id, tag.id, library.actor);

    expect(library.tags.unassign(item.id, tag.id, library.actor)).toBe(true);
    expect(library.tags.unassign(item.id, tag.id, library.actor)).toBe(false);
    expect(library.tags.forItem(item.id)).toHaveLength(0);
  });

  it('counts live items only', () => {
    const kept = makeItem('Kept');
    const binned = makeItem('Binned');
    const tag = library.tags.ensure('both', library.actor);
    library.tags.assign(kept.id, tag.id, library.actor);
    library.tags.assign(binned.id, tag.id, library.actor);

    expect(library.tags.listWithCounts()[0]?.itemCount).toBe(2);
    library.library.trashItem(binned.id, library.actor);
    expect(library.tags.listWithCounts()[0]?.itemCount).toBe(1);
    expect(library.tags.listItems(tag.id).data.map((row) => row.id)).toEqual([kept.id]);
  });
});

describe('TagService — rename and merge', () => {
  it('a rename keeps every assignment, because assignments key on the id (TG1)', () => {
    const item = makeItem('A paper');
    const tag = library.tags.ensure('machine lerning', library.actor);
    library.tags.assign(item.id, tag.id, library.actor, { source: 'import', ruleRef: 'zotero' });

    const renamed = library.tags.rename(tag.id, 'machine learning', library.actor);
    expect(renamed.id).toBe(tag.id);
    expect(renamed.nameNormalised).toBe('machine learning');

    const [assigned] = library.tags.forItem(item.id);
    expect(assigned?.id).toBe(tag.id);
    expect(assigned?.name).toBe('machine learning');
    // The metadata survived: a create-and-remap would have lost it.
    expect(assigned?.source).toBe('import');
    expect(assigned?.ruleRef).toBe('zotero');
  });

  it('refuses a rename into an existing name and says to merge instead', () => {
    const first = library.tags.ensure('a', library.actor);
    library.tags.ensure('b', library.actor);
    expect(() => library.tags.rename(first.id, 'b', library.actor)).toThrow(/Merge the two/u);
  });

  it('merges two tags, collapsing duplicates and leaving a reversible record (TG2)', () => {
    const both = makeItem('Both');
    const loserOnly = makeItem('Loser only');
    const winner = library.tags.ensure('machine learning', library.actor);
    const loser = library.tags.ensure('ML', library.actor);

    library.tags.assign(both.id, winner.id, library.actor);
    library.tags.assign(both.id, loser.id, library.actor);
    library.tags.assign(loserOnly.id, loser.id, library.actor, { source: 'import' });

    const outcome = library.tags.merge(loser.id, winner.id, library.actor);
    expect(outcome.moved).toBe(1);

    // The loser is trashed, not deleted, and its assignments are gone from the items.
    expect(() => library.tags.get(loser.id)).toThrow(NotFoundError);
    expect(library.tags.get(loser.id, { includeTrashed: true }).trashedAt).not.toBeNull();
    expect(library.tags.forItem(both.id).map((tag) => tag.id)).toEqual([winner.id]);
    expect(library.tags.forItem(loserOnly.id).map((tag) => tag.id)).toEqual([winner.id]);

    const record = library.db
      .select()
      .from(schema.trash)
      .where(and(eq(schema.trash.entityId, loser.id), isNull(schema.trash.restoredAt)))
      .get();
    expect(record?.reason).toBe('merge');
    const merge = JSON.parse(record?.mergeRecord ?? '{}') as {
      winnerTagId?: string;
      movedItemIds?: string[];
      collapsedItemIds?: string[];
    };
    expect(merge.winnerTagId).toBe(winner.id);
    expect(merge.movedItemIds).toEqual([loserOnly.id]);
    expect(merge.collapsedItemIds).toEqual([both.id]);
  });

  it('refuses to merge a tag into itself', () => {
    const tag = library.tags.ensure('x', library.actor);
    expect(() => library.tags.merge(tag.id, tag.id, library.actor)).toThrow(/into itself/u);
  });
});

describe('TagService — trash and restore (P5)', () => {
  it('takes the tag off its items and puts every assignment back on restore', () => {
    const first = makeItem('First');
    const second = makeItem('Second');
    const tag = library.tags.ensure('provisional', library.actor);
    library.tags.assign(first.id, tag.id, library.actor, { source: 'rule', ruleRef: 'r1', confidence: 0.5 });
    library.tags.assign(second.id, tag.id, library.actor);

    library.tags.trash(tag.id, library.actor);
    expect(library.tags.list()).toHaveLength(0);
    expect(library.tags.forItem(first.id)).toHaveLength(0);

    library.tags.restore(tag.id, library.actor);
    expect(library.tags.list()).toHaveLength(1);

    const restored = library.tags.forItem(first.id);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.source).toBe('rule');
    expect(restored[0]?.ruleRef).toBe('r1');
    expect(restored[0]?.confidence).toBeCloseTo(0.5);
    expect(library.tags.forItem(second.id)).toHaveLength(1);
  });
});
