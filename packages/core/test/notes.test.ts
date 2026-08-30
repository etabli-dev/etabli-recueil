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

/**
 * `htmlToMarkdown` used to be six chained `String.replace` calls over lazy `([\s\S]*?)` patterns
 * bounded by a closing tag, two of them with a backreference. Every opener without its closer cost
 * a scan to the end of the note, so the conversion was quadratic in the note size: measured against
 * the shipped build, 500 unclosed `<strong>` in 260 KB took 0.04 s, 2 000 in 1 MB took 0.67 s,
 * 4 000 in 2 MB took 2.58 s, and 30 000 in 16 MB — the server's own body limit — took 219 s of
 * fully synchronous work. Note bodies arrive from `POST /api/v1/notes`, from the Zotero connector
 * and from imported libraries (ADR-0022).
 */
describe('htmlToMarkdown is linear in the note (ADR-0022)', () => {
  const timed = (html: string): number => {
    const started = performance.now();
    htmlToMarkdown(html);
    return performance.now() - started;
  };

  it('converts a megabyte and a half of unclosed opening tags in milliseconds', () => {
    // 3 000 openers over 1.5 MB cost about 1.5 s through the replacement chain, and cost single
    // milliseconds now. The threshold is deliberately far below the old figure and far above the
    // new one, so the test is about the shape of the growth rather than about this machine.
    const html = '<strong>'.repeat(3_000) + 'x'.repeat(1_500_000);
    const elapsed = timed(html);
    expect(elapsed, `${(html.length / 1024).toFixed(0)} KB took ${elapsed.toFixed(0)} ms`).toBeLessThan(400);
  }, 20_000);

  it('is not quadratic in closing tags with no opener either', () => {
    // The obvious way to write the replacement — search the element stack on every closing tag —
    // reintroduces the same shape from the other end. The counter in `htmlToMarkdown` is what
    // makes "there is no such opener" a constant-time answer.
    const elapsed = timed('<b>'.repeat(100_000) + '</i>'.repeat(100_000));
    expect(elapsed, `orphan closers took ${elapsed.toFixed(0)} ms`).toBeLessThan(500);
  }, 20_000);

  it('does not run away on an unterminated attribute, tag or comment', () => {
    expect(timed(`<a href="${'x'.repeat(500_000)}`)).toBeLessThan(400);
    expect(timed(`<p class=${'y'.repeat(500_000)}`)).toBeLessThan(400);
    expect(timed(`<!--${'z'.repeat(500_000)}`)).toBeLessThan(400);
  }, 20_000);

  it('trims trailing whitespace without going quadratic on an interior run of it', () => {
    // The final normalisation pass was `line.replace(/[ \t]+$/u, '')`, which is anchored only at
    // the end: the engine restarts inside the run and backtracks through every length from every
    // position. `<p>a<100 000 spaces>b</p>` cost 17.8 s through the shipped build — a note body a
    // stranger can post, and a regular expression that survived the rewrite of everything around
    // it because it is not a tag pattern.
    const elapsed = timed(`<p>a${' '.repeat(200_000)}b</p>`);
    expect(elapsed, `an interior run of 200 000 spaces took ${elapsed.toFixed(0)} ms`).toBeLessThan(400);

    expect(htmlToMarkdown('<p>trailing   \t</p><p>kept  here</p>')).toBe('trailing\nkept  here');
  }, 20_000);

  it('treats a numeric reference beyond the last code point as data, not a crash', () => {
    // `String.fromCodePoint(99999999)` throws a RangeError, which used to escape the converter and
    // reach the request handler as a 500 rather than as anything a caller could act on.
    expect(htmlToMarkdown('<p>a&#99999999;b</p>')).toBe('a&#99999999;b');
    expect(htmlToMarkdown('<p>a&#8212;b</p>')).toBe('a—b');
  });

  it('keeps the tag vocabulary it always had', () => {
    expect(htmlToMarkdown('<h2>Findings</h2><p>Mortality was <strong>lower</strong>.</p><ul><li>One</li></ul>'))
      .toBe('## Findings\nMortality was **lower**.\n\n- One');
    expect(htmlToMarkdown('<p>Use <code>rm -rf</code> carefully.</p>')).toBe('Use `rm -rf` carefully.');
    expect(htmlToMarkdown('<strong><em>both</em></strong>')).toBe('***both***');
    expect(htmlToMarkdown('<p>Unclosed <strong>bold')).toBe('Unclosed bold');
    // Every line of a blockquote is quoted, which the replacement chain could not do: its `\n`s
    // were produced by later passes, so only the first line ever got a `>`.
    expect(htmlToMarkdown('<blockquote><p>one</p><p>two</p></blockquote>')).toBe('> one\n> two');
    // A `>` inside an attribute value no longer ends the tag.
    expect(htmlToMarkdown('<a title="a > b" href="https://example.org">link</a>')).toBe(
      '[link](https://example.org)',
    );
  });
});
