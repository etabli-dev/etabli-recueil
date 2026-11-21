import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let lib: TestLibrary;
beforeEach(() => {
  lib = makeLibrary();
});
afterEach(() => {
  lib.dispose();
});

const article = (title: string, bibliographic: Record<string, unknown> = {}) =>
  lib.library.createItem({ itemType: 'article', title, bibliographic: { title, ...bibliographic } }, lib.actor).item.id;

describe('ItemMergeService', () => {
  it('moves children, unites tags and collections, fills blanks, and trashes the loser with a record', async () => {
    const winner = article('Hip fractures', { volume: '12' });
    const loser = article('Hip fractures', { doi: '10.1000/hip', issue: '3', volume: '99' });
    const collection = lib.collections.create({ name: 'Trauma' }, lib.actor);
    lib.collections.addItems(collection.id, [loser], lib.actor);
    lib.tags.assignByName(loser, 'geriatrics', lib.actor);
    lib.notes.create({ itemId: loser, contentMarkdown: 'A note on the loser' }, lib.actor);
    const doc = await lib.documents.ingestBuffer(Buffer.from('%PDF-1.4 loser'), {
      sourceKind: 'upload',
      attachTo: { itemId: loser },
    });

    const outcome = lib.merges.merge(winner, [loser], lib.actor);
    const record = outcome.losers[0]!.record;

    const merged = lib.library.getItem(winner);
    expect(merged.bibliographic?.volume).toBe('12');
    expect(merged.bibliographic?.doi).toBe('10.1000/hip');
    expect(merged.bibliographic?.issue).toBe('3');
    expect(lib.tags.forItem(winner).map((tag) => tag.name)).toEqual(['geriatrics']);
    expect(lib.collections.forItem(winner).map((c) => c.name)).toEqual(['Trauma']);
    expect(lib.notes.forItem(winner)).toHaveLength(1);
    expect(record.movedAttachments).toHaveLength(1);
    expect(record.filled).toMatchObject({ doi: '10.1000/hip', issue: '3' });
    expect(record.filled).not.toHaveProperty('volume');

    const gone = lib.library.getItem(loser, { includeTrashed: true }).item;
    expect(gone.trashedAt).not.toBeNull();
    expect(gone.libraryState).toBe('merged');
    expect(gone.mergedIntoItemId).toBe(winner);
    expect(lib.merges.mergeRecordOf(loser)?.winnerId).toBe(winner);
    void doc;
  });

  it('reverses a merge exactly', async () => {
    const winner = article('Hip fractures', { volume: '12' });
    const loser = article('Hip fractures', { doi: '10.1000/hip', issue: '3' });
    lib.tags.assignByName(loser, 'geriatrics', lib.actor);
    lib.notes.create({ itemId: loser, contentMarkdown: 'A note on the loser' }, lib.actor);
    await lib.documents.ingestBuffer(Buffer.from('%PDF-1.4 loser'), { sourceKind: 'upload', attachTo: { itemId: loser } });
    lib.merges.merge(winner, [loser], lib.actor);

    const outcome = lib.merges.unmerge(loser, lib.actor);
    expect(outcome.keptOnWinner).toEqual([]);
    const back = lib.library.getItem(loser);
    expect(back.item.libraryState).toBe('normal');
    expect(back.bibliographic?.doi).toBe('10.1000/hip');
    expect(lib.notes.forItem(loser)).toHaveLength(1);
    expect(lib.notes.forItem(winner)).toHaveLength(0);
    expect(lib.tags.forItem(winner)).toHaveLength(0);
    expect(lib.tags.forItem(loser).map((tag) => tag.name)).toEqual(['geriatrics']);
    const winnerAfter = lib.library.getItem(winner);
    expect(winnerAfter.bibliographic?.doi).toBeNull();
    expect(winnerAfter.bibliographic?.issue).toBeNull();
    expect(winnerAfter.bibliographic?.volume).toBe('12');
  });

  it('leaves a filled value someone edited since the merge, and says so', () => {
    const winner = article('Hip fractures');
    const loser = article('Hip fractures', { issue: '3' });
    lib.merges.merge(winner, [loser], lib.actor);
    lib.library.updateItem(winner, { bibliographic: { issue: '4' } }, lib.actor);
    const outcome = lib.merges.unmerge(loser, lib.actor);
    expect(outcome.keptOnWinner).toEqual(['issue']);
    expect(lib.library.getItem(winner).bibliographic?.issue).toBe('4');
  });

  it('does not move a file the winner already has', async () => {
    const winner = article('A');
    const loser = article('A');
    const bytes = Buffer.from('%PDF-1.4 same file');
    await lib.documents.ingestBuffer(bytes, { sourceKind: 'upload', attachTo: { itemId: winner } });
    await lib.documents.ingestBuffer(bytes, { sourceKind: 'upload', attachTo: { itemId: loser } });
    const { losers } = lib.merges.merge(winner, [loser], lib.actor);
    expect(losers[0]?.record.movedAttachments).toEqual([]);
  });

  it('refuses nonsense', () => {
    const a = article('A');
    const book = lib.library.createItem({ itemType: 'book', title: 'B' }, lib.actor).item.id;
    expect(() => lib.merges.merge(a, [a], lib.actor)).toThrow(ValidationError);
    expect(() => lib.merges.merge(a, [], lib.actor)).toThrow(ValidationError);
    expect(() => lib.merges.merge(a, [book], lib.actor)).toThrow(ValidationError);
  });
});
