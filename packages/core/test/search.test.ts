/**
 * Full-text search (ADR-0011, §9).
 *
 * Two halves. The first is the query language: it is Recueil's, not FTS5's, so the parser is tested
 * on its own — including the part where FTS5's operator characters arrive as data and must not
 * become operators. The second is the index itself: that a note's text finds the item it belongs
 * to, that a title finds it, and that trashing an item takes it out of the index and restoring it
 * puts it back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConflictError,
  MEMORY_DATABASE,
  SearchService,
  ValidationError,
  compileSearchQuery,
  openDatabase,
  parseSearchQuery,
} from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

describe('the query language', () => {
  it('ANDs bare words and keeps a quoted phrase together', () => {
    expect(compileSearchQuery('machine learning')).toBe('(("machine") AND ("learning"))');
    expect(compileSearchQuery('"machine learning"')).toBe('("machine" "learning")');
  });

  it('maps Recueil field names onto index columns, never exposing the index\'s own', () => {
    expect(compileSearchQuery('title:sepsis')).toBe('{title} : ("sepsis")');
    expect(compileSearchQuery('creator:"van Dijk"')).toBe('{creators} : ("van" "Dijk")');
    expect(compileSearchQuery('note:mortality')).toBe('{body} : ("mortality")');
  });

  it('refuses an unknown field rather than searching for the literal text', () => {
    expect(() => compileSearchQuery('colour:red')).toThrow(ValidationError);
    expect(() => compileSearchQuery('colour:red')).toThrow(/Unknown search field/u);
  });

  it('supports prefix, OR, grouping and exclusion', () => {
    expect(compileSearchQuery('learn*')).toBe('("learn"*)');
    expect(compileSearchQuery('sepsis OR septicaemia')).toBe('(("sepsis") OR ("septicaemia"))');
    expect(compileSearchQuery('(a OR b) c')).toBe('((("a") OR ("b")) AND ("c"))');
    expect(compileSearchQuery('sepsis -draft')).toBe('((("sepsis")) NOT (("draft")))');
  });

  it('refuses a query that is nothing but exclusions', () => {
    expect(() => compileSearchQuery('-draft')).toThrow(/only of exclusions/u);
  });

  it('treats FTS5 operator syntax as data, so no input can break out of a term', () => {
    // A stray quote delimits a phrase; it never lands inside a term, and an unterminated one runs
    // to the end of the input rather than throwing — a search box is unterminated most of the time.
    expect(compileSearchQuery('say"hello')).toBe('(("say") AND ("hello"))');
    // `NEAR` and `^` are FTS5 syntax and are not part of this language: they are just words.
    expect(compileSearchQuery('NEAR')).toBe('("NEAR")');
    expect(compileSearchQuery('a^b')).toBe('("a^b")');
    // The real test of the escaping is that SQLite accepts whatever the compiler emitted.
    for (const junk of ['say"hello', 'a^b', 'NEAR(a b)', '{title} : x', '*', '""', 'a AND OR b']) {
      expect(() => library.search.search(junk), junk).not.toThrow();
    }
  });

  it('parses an empty query to nothing rather than to everything', () => {
    expect(parseSearchQuery('   ')).toBeNull();
    expect(compileSearchQuery('')).toBeNull();
    expect(library.search.search('').hits).toEqual([]);
  });
});

describe('the index', () => {
  const seed = () => {
    const item = library.library.createItem(
      {
        itemType: 'article',
        bibliographic: {
          title: 'Early antibiotics in sepsis',
          containerTitle: 'BMJ',
          doi: '10.1136/bmj.n71',
          abstract: 'A pragmatic trial of timing.',
        },
      },
      library.actor,
    );
    const other = library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Fluid resuscitation revisited' } },
      library.actor,
    );
    const note = library.notes.create(
      {
        itemId: item.item.id,
        contentMarkdown: 'The subgroup with **hyperlactataemia** showed the clearest benefit.',
      },
      library.actor,
    );
    return { item: item.item, other: other.item, note };
  };

  it('is available on a SQLite library', () => {
    expect(library.search.available).toBe(true);
  });

  it('finds an item by its title', () => {
    const { item } = seed();
    const hits = library.search.search('title:sepsis').hits;
    expect(hits.map((hit) => hit.entityId)).toContain(item.id);
    expect(hits[0]?.entityType).toBe('item');
  });

  it('finds an item by the text of a note attached to it', () => {
    const { item, note } = seed();

    const hits = library.search.search('hyperlactataemia').hits;
    expect(hits.map((hit) => hit.entityId)).toContain(note.id);
    expect(hits.find((hit) => hit.entityId === note.id)?.itemId).toBe(item.id);

    // And the item-level projection rolls the note hit up to the item it belongs to.
    expect(library.search.itemIdsMatching('hyperlactataemia')).toEqual([item.id]);
    expect(library.library.listItems({ text: 'hyperlactataemia' }).data.map((row) => row.id)).toEqual([
      item.id,
    ]);
  });

  it('finds by identifier, container and creator name, folding diacritics', () => {
    const { item } = seed();
    const creator = library.creators.create(
      { familyName: 'Müller', givenName: 'Anna' },
      library.actor,
    );
    library.creators.setItemCreators(item.id, [{ creatorId: creator.id }], library.actor);

    expect(library.search.itemIdsMatching('id:"10.1136/bmj.n71"')).toContain(item.id);
    expect(library.search.itemIdsMatching('container:BMJ')).toContain(item.id);
    expect(library.search.itemIdsMatching('creator:muller')).toContain(item.id);
    expect(library.search.itemIdsMatching('creator:Müller')).toContain(item.id);
  });

  it('follows a tag assignment and a tag rename', () => {
    const { item } = seed();
    library.tags.assignByName(item.id, 'critical care', library.actor);
    expect(library.search.itemIdsMatching('tag:critical')).toEqual([item.id]);

    const tag = library.tags.findByName('critical care');
    library.tags.rename(tag?.id as string, 'intensive care', library.actor);
    expect(library.search.itemIdsMatching('tag:critical')).toEqual([]);
    expect(library.search.itemIdsMatching('tag:intensive')).toEqual([item.id]);
  });

  it('narrows rather than widens: an unrelated item does not match', () => {
    const { item, other } = seed();
    const matched = library.search.itemIdsMatching('sepsis');
    expect(matched).toContain(item.id);
    expect(matched).not.toContain(other.id);
  });

  it('drops a trashed item and a trashed note, and puts both back on restore', () => {
    const { item, note } = seed();
    expect(library.search.itemIdsMatching('sepsis')).toContain(item.id);

    library.library.trashItem(item.id, library.actor);
    expect(library.search.search('title:sepsis').hits).toEqual([]);
    expect(library.search.search('hyperlactataemia').hits).toEqual([]);

    library.library.restoreItem(item.id, library.actor);
    expect(library.search.itemIdsMatching('sepsis')).toContain(item.id);
    expect(library.search.search('hyperlactataemia').hits.map((hit) => hit.entityId)).toContain(
      note.id,
    );
  });

  it('follows an edit to a note', () => {
    const { item, note } = seed();
    library.notes.update(note.id, { contentMarkdown: 'Now about thrombocytopenia.' }, library.actor);

    expect(library.search.search('hyperlactataemia').hits).toEqual([]);
    expect(library.search.itemIdsMatching('thrombocytopenia')).toEqual([item.id]);
  });

  it('indexes a document\'s extracted text and resolves it to the items that attach it', async () => {
    const { item } = seed();
    const ingested = await library.documents.ingestBuffer(Buffer.from('%PDF-1.7\n'), {
      sourceKind: 'upload',
      originalFilename: 'trial.pdf',
      attachTo: { itemId: item.id },
    });

    library.search.indexDocumentText(
      ingested.document.id,
      'Methods: patients received piperacillin-tazobactam within sixty minutes.',
    );

    const hits = library.search.search('piperacillin').hits;
    expect(hits.map((hit) => hit.entityType)).toContain('document');
    expect(library.search.itemIdsMatching('piperacillin')).toEqual([item.id]);
  });

  it('rebuilds from the tables, because the index is derived data', () => {
    const { item, note } = seed();

    // Simulate drift: remove the item's entry behind the service's back.
    library.search.removeEntity('item', item.id);
    expect(library.search.itemIdsMatching('sepsis')).toEqual([]);

    const counts = library.search.rebuild();
    expect(counts.items).toBe(2);
    expect(counts.notes).toBe(1);
    expect(library.search.itemIdsMatching('sepsis')).toEqual([item.id]);
    expect(library.search.search('hyperlactataemia').hits.map((hit) => hit.entityId)).toEqual([
      note.id,
    ]);
  });

  it('ranks a title match above a body match', () => {
    library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Sepsis' } },
      library.actor,
    );
    library.library.createItem(
      {
        itemType: 'article',
        bibliographic: { title: 'Something else', abstract: 'A study of sepsis in the community.' },
      },
      library.actor,
    );

    const hits = library.search.search('sepsis').hits;
    expect(hits).toHaveLength(2);
    const first = library.library.getItem(hits[0]?.entityId as string);
    expect(first.item.title).toBe('Sepsis');
  });
});

describe('the guard for a backend without FTS5', () => {
  /**
   * The `available` probe is what keeps a Postgres deployment from breaking (§9, ADR-0015): the
   * module runs no SQL at import time, and every method asks first. A database that has never seen
   * the search migration stands in for that backend here — it is the same question, "is the index
   * there", asked of something that does not have one.
   */
  const withoutIndex = () => {
    const opened = openDatabase({ databaseUrl: MEMORY_DATABASE });
    return { ...opened, search: new SearchService(opened.db) };
  };

  it('reports itself unavailable rather than throwing at construction', () => {
    const { connection, search } = withoutIndex();
    try {
      expect(search.available).toBe(false);
      // Asked twice: the probe is cached, and the answer does not change.
      expect(search.available).toBe(false);
    } finally {
      connection.close();
    }
  });

  it('makes every index write a no-op', () => {
    const { connection, search } = withoutIndex();
    try {
      expect(() => search.indexItem('01J8F3Z9K4ABCDEFGHJKMNPQR1')).not.toThrow();
      expect(() => search.indexNote('01J8F3Z9K4ABCDEFGHJKMNPQR2')).not.toThrow();
      expect(() => search.indexDocumentText('01J8F3Z9K4ABCDEFGHJKMNPQR3', 'text')).not.toThrow();
      expect(() => search.removeEntity('item', '01J8F3Z9K4ABCDEFGHJKMNPQR1')).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it('fails a search with an explanation, not a driver error', () => {
    const { connection, search } = withoutIndex();
    try {
      expect(() => search.search('anything')).toThrow(ConflictError);
      expect(() => search.search('anything')).toThrow(/FTS5 is a SQLite feature/u);
      expect(() => search.rebuild()).toThrow(ConflictError);
    } finally {
      connection.close();
    }
  });
});
