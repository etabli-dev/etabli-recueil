import { mapZoteroFields } from '@recueil/import-zotero';
import { describe, expect, it } from 'vitest';

import { COLUMN_BASE_FIELDS, markdownToNoteHtml, mergeThreeWay } from '../src/index.js';
import type { Flat } from '../src/index.js';

const flat = (scalars: Record<string, string>, sets: Record<string, string[]> = {}): Flat => ({ scalars, sets });

describe('mergeThreeWay', () => {
  const base = flat({ a: '1', b: '1', c: '1' });

  it('implements the table', () => {
    const result = mergeThreeWay(base, flat({ a: '1', b: '2', c: '3' }), flat({ a: '9', b: '1', c: '3' }), {
      policy: 'review',
    });
    expect(result.merged.scalars).toEqual({ a: '9', b: '2', c: '3' });
    expect(result.toRecueil).toEqual(['a']);
    expect(result.toZotero).toEqual(['b']);
    expect(result.conflicts).toEqual([]);
  });

  it('holds a conflict under review and picks a side under a policy', () => {
    const recueil = flat({ a: 'R', b: '1', c: '1' });
    const zotero = flat({ a: 'Z', b: '1', c: '1' });
    const held = mergeThreeWay(base, recueil, zotero, { policy: 'review' });
    expect(held.conflicts).toEqual([{ field: 'a', base: '1', recueil: 'R', zotero: 'Z' }]);
    expect(held.toRecueil).toEqual([]);
    expect(held.toZotero).toEqual([]);
    expect(mergeThreeWay(base, recueil, zotero, { policy: 'zotero' }).merged.scalars['a']).toBe('Z');
    expect(mergeThreeWay(base, recueil, zotero, { policy: 'recueil' }).merged.scalars['a']).toBe('R');
  });

  it('treats a cleared field as a change', () => {
    const result = mergeThreeWay(base, flat({ b: '1', c: '1' }), base, { policy: 'review' });
    expect(result.toZotero).toEqual(['a']);
    expect(result.merged.scalars['a']).toBeUndefined();
  });

  it('keeps a locked field against a pull whatever the policy', () => {
    const result = mergeThreeWay(base, base, flat({ a: 'Z', b: '1', c: '1' }), {
      policy: 'zotero',
      lockedInRecueil: new Set(['a']),
    });
    expect(result.toRecueil).toEqual([]);
    expect(result.toZotero).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('freezes a field with an open conflict', () => {
    const result = mergeThreeWay(base, flat({ a: 'R', b: '1', c: '1' }), base, {
      policy: 'review',
      frozen: new Set(['a']),
    });
    expect(result.toZotero).toEqual([]);
  });

  it('merges sets element by element', () => {
    const result = mergeThreeWay(
      flat({}, { tags: ['x', 'y'] }),
      flat({}, { tags: ['x', 'r'] }),
      flat({}, { tags: ['y', 'z'] }),
      { policy: 'review' },
    );
    expect(result.merged.sets['tags']).toEqual(['r', 'z']);
  });

  it('obeys a decision', () => {
    const result = mergeThreeWay(base, flat({ a: 'R', b: '1', c: '1' }), flat({ a: 'Z', b: '1', c: '1' }), {
      policy: 'review',
      forced: new Map([['a', 'zotero']]),
    });
    expect(result.merged.scalars['a']).toBe('Z');
    expect(result.toRecueil).toEqual(['a']);
    expect(result.conflicts).toEqual([]);
  });
});

describe('the column table', () => {
  it('agrees with the importer about where every base field lands', () => {
    const probes: Record<string, string> = {
      DOI: '10.1000/xyz',
      ISBN: '9780306406157',
      ISSN: '0020-1383',
      language: 'en',
      numPages: '214',
      date: '2020-05-03',
      accessDate: '2021-01-02 03:04:05',
    };
    for (const [column, bases] of Object.entries(COLUMN_BASE_FIELDS)) {
      for (const base of bases) {
        const value = probes[base] ?? 'probe';
        const mapped = mapZoteroFields([{ field: base, baseField: base, value }], {
          zoteroItemType: 'document',
          cslType: null,
        });
        const landed =
          column === 'title' ? (mapped.title === null ? [] : ['title']) : Object.keys(mapped.bibliographic);
        expect(landed, `${base} → ${column}`).toContain(column);
      }
    }
  });
});

describe('markdownToNoteHtml', () => {
  it('renders the common structures and escapes the rest', () => {
    const html = markdownToNoteHtml('# Title\n\nSome **bold** and <script>x</script>\n\n- one\n- two\n\n[link](javascript:alert(1))');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).not.toContain('href="javascript');
  });
});
