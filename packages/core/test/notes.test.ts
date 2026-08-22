/**
 * Notes (§4.8).
 *
 * N1 is the invariant worth guarding: `content_markdown` is populated whatever form the note
 * arrived in, and the HTML original is kept verbatim so a Zotero note round-trips (P10). The rest
 * is the optimistic-concurrency behaviour items already have, applied to a second versioned entity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

import {
  NotFoundError,
  VersionConflictError,
  deriveNoteTitle,
  htmlToMarkdown,
  schema,
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

const makeItem = (): string =>
  library.library.createItem(
    { itemType: 'article', bibliographic: { title: 'Host' } },
    library.actor,
  ).item.id;

describe('note content (N1)', () => {
  it('stores Markdown as given, with no original to keep', () => {
    const note = library.notes.create(
      { contentMarkdown: '# Heading\n\nSome text.' },
      library.actor,
    );
    expect(note.sourceFormat).toBe('markdown');
    expect(note.contentOriginal).toBeNull();
    expect(note.contentMarkdown).toBe('# Heading\n\nSome text.');
  });

  it('converts HTML on write and keeps the original verbatim (P10)', () => {
    const html = '<h2>Findings</h2><p>Mortality was <strong>lower</strong>.</p><ul><li>One</li></ul>';
    const note = library.notes.create({ itemId: makeItem(), contentHtml: html }, library.actor);

    expect(note.sourceFormat).toBe('html');
    expect(note.contentOriginal).toBe(html);
    expect(note.contentMarkdown).toContain('## Findings');
    expect(note.contentMarkdown).toContain('**lower**');
    expect(note.contentMarkdown).toContain('- One');
  });

  it('derives a title from the first heading, or the first line', () => {
    expect(deriveNoteTitle('## Findings\n\nBody')).toBe('Findings');
    expect(deriveNoteTitle('\n\nJust a line, no heading.\nMore')).toBe('Just a line, no heading.');
    expect(deriveNoteTitle('   ')).toBeNull();

    const note = library.notes.create({ contentMarkdown: '# Sepsis\n\nx' }, library.actor);
    expect(note.title).toBe('Sepsis');
  });

  it('decodes entities and drops scripts rather than passing them through', () => {
    expect(htmlToMarkdown('<p>A&nbsp;&amp;&nbsp;B</p>')).toBe('A & B');
    expect(htmlToMarkdown('<script>alert(1)</script><p>Safe</p>')).toBe('Safe');
    expect(htmlToMarkdown('<a href="https://example.org">link</a>')).toBe('[link](https://example.org)');
  });

  it('refuses a note with no content at all', () => {
    expect(() => library.notes.create({ contentMarkdown: '   ' }, library.actor)).toThrow(
      /needs content/iu,
    );
    expect(() => library.notes.create({}, library.actor)).toThrow(/contentMarkdown or contentHtml/u);
  });
});

describe('NoteService — lifecycle', () => {
  it('attaches to an item, or stands alone', () => {
    const item = makeItem();
    const attached = library.notes.create({ itemId: item, contentMarkdown: 'On the paper.' }, library.actor);
    const standalone = library.notes.create({ contentMarkdown: 'On its own.' }, library.actor);

    expect(library.notes.forItem(item).map((row) => row.id)).toEqual([attached.id]);
    expect(library.notes.list({ itemId: null }).data.map((row) => row.id)).toEqual([standalone.id]);
  });

  it('bumps the version on every edit and refuses a stale conditional write (§1.7, P1)', () => {
    const note = library.notes.create({ contentMarkdown: 'First' }, library.actor);
    expect(note.version).toBe(1);

    const updated = library.notes.update(note.id, { contentMarkdown: 'Second' }, library.actor, {
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(updated.contentMarkdown).toBe('Second');

    expect(() =>
      library.notes.update(note.id, { contentMarkdown: 'Third' }, library.actor, {
        expectedVersion: 1,
      }),
    ).toThrow(VersionConflictError);

    // P1: the refusal is logged rather than merged, and the note is unchanged.
    const conflicts = library.audit
      .forEntity('note', note.id)
      .filter((row) => row.action === 'note.conflict');
    expect(conflicts).toHaveLength(1);
    expect(library.notes.get(note.id).contentMarkdown).toBe('Second');
  });

  it('re-derives the title when the content changes, unless one is given', () => {
    const note = library.notes.create({ contentMarkdown: '# One\n\nx' }, library.actor);
    const rewritten = library.notes.update(note.id, { contentMarkdown: '# Two\n\ny' }, library.actor);
    expect(rewritten.title).toBe('Two');

    const pinned = library.notes.update(
      note.id,
      { contentMarkdown: '# Three\n\nz', title: 'Kept' },
      library.actor,
    );
    expect(pinned.title).toBe('Kept');
  });

  it('pages by cursor over (updated_at, id)', () => {
    for (let index = 0; index < 5; index += 1) {
      library.notes.create({ contentMarkdown: `Note ${index}` }, library.actor);
    }
    const first = library.notes.list({ limit: 2 });
    const second = library.notes.list({ limit: 2, cursor: first.page.nextCursor as string });
    const third = library.notes.list({ limit: 2, cursor: second.page.nextCursor as string });

    const ids = [...first.data, ...second.data, ...third.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.page.hasMore).toBe(false);
  });
});

describe('NoteService — trash and restore (P5)', () => {
  it('hides a trashed note and puts it back, keeping T1 at both ends', () => {
    const item = makeItem();
    const note = library.notes.create({ itemId: item, contentMarkdown: 'Keep me' }, library.actor);

    library.notes.trash(note.id, library.actor);
    expect(() => library.notes.get(note.id)).toThrow(NotFoundError);
    expect(library.notes.forItem(item)).toHaveLength(0);

    const open = library.db
      .select()
      .from(schema.trash)
      .where(
        and(
          eq(schema.trash.entityType, 'note'),
          eq(schema.trash.entityId, note.id),
          isNull(schema.trash.restoredAt),
        ),
      )
      .get();
    expect(open).toBeDefined();

    library.notes.restore(note.id, library.actor);
    expect(library.notes.get(note.id).trashedAt).toBeNull();
    expect(library.notes.forItem(item)).toHaveLength(1);

    const stillOpen = library.db
      .select()
      .from(schema.trash)
      .where(and(eq(schema.trash.entityId, note.id), isNull(schema.trash.restoredAt)))
      .get();
    expect(stillOpen).toBeUndefined();
  });

  it('is trashed and restored with the item it hangs off (I4)', () => {
    const item = makeItem();
    const note = library.notes.create({ itemId: item, contentMarkdown: 'Cascade' }, library.actor);

    library.library.trashItem(item, library.actor);
    expect(library.notes.get(note.id, { includeTrashed: true }).trashedAt).not.toBeNull();

    library.library.restoreItem(item, library.actor);
    expect(library.notes.get(note.id).trashedAt).toBeNull();
  });
});
