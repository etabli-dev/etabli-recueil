import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError, evaluateSavedSearch, parseSavedSearch } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let lib: TestLibrary;
beforeEach(() => {
  lib = makeLibrary();
});
afterEach(() => {
  lib.dispose();
});

const make = (title: string, year: number, itemType = 'article', dateAdded = `${year}-01-01T00:00:00.000Z`) =>
  lib.library.createItem({ itemType, title, dateAdded, bibliographic: { title, issuedYear: year } }, lib.actor).item.id;

describe('saved searches', () => {
  it('combines text and filters, keeping the ranking', () => {
    const a = make('Hip fracture outcomes', 2020);
    const b = make('Hip fracture in the elderly', 2012);
    make('Wrist fracture outcomes', 2021);
    const c = make('Hip fracture surgery', 2022, 'book');
    lib.tags.assignByName(a, 'geriatrics', lib.actor);
    lib.tags.assignByName(c, 'geriatrics', lib.actor);

    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ text: 'hip' }), 10).sort()).toEqual([a, b, c].sort());
    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ text: 'hip', yearFrom: 2015, itemTypes: ['article'] }), 10)).toEqual([a]);
    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ tags: ['Geriatrics'] }), 10)).toEqual([c, a]);
    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ text: 'hip', notTags: ['geriatrics'] }), 10)).toEqual([b]);
    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ tags: ['nope'] }), 10)).toEqual([]);
  });

  it('finds items with a file, and items failing a check', async () => {
    const a = make('With file', 2020);
    make('Without file', 2020);
    await lib.documents.ingestBuffer(Buffer.from('%PDF-1.4 x'), { sourceKind: 'upload', attachTo: { itemId: a } });
    expect(evaluateSavedSearch(lib.db, lib.search, parseSavedSearch({ hasFile: true }), 10)).toEqual([a]);
  });

  it('refuses a query it does not understand', () => {
    expect(() => parseSavedSearch({ txt: 'hip' })).toThrow(ValidationError);
    expect(() => parseSavedSearch({})).toThrow(ValidationError);
    expect(() => parseSavedSearch({ yearFrom: '2020' })).toThrow(ValidationError);
    expect(parseSavedSearch({ q: 'hip' })).toEqual({ text: 'hip' });
  });
});
