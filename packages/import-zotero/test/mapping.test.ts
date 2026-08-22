/**
 * The mapping, tested against literal rows rather than through the database.
 *
 * Everything in `src/map/` is a pure function of Zotero's own shapes, which is the reason it is a
 * separate directory: the awkward cases — a particle surname, a single-field institutional name, a
 * date Zotero could not parse, three citation keys that disagree — are cheaper and clearer to pin
 * down here than by importing a library and querying it back.
 */
import { describe, expect, it } from 'vitest';

import { mapZoteroAnnotation, normaliseSortIndex } from '../src/map/annotations.js';
import { resolveCitationKey } from '../src/map/citation-keys.js';
import { creatorIdentity, mapCreatorName, mapCreatorRole } from '../src/map/creators.js';
import { mapZoteroDate, mapZoteroTimestamp } from '../src/map/dates.js';
import { parseExtra } from '../src/map/extra.js';
import { mapZoteroFields, parsePageSpan } from '../src/map/fields.js';
import { mapZoteroItemType, slugify } from '../src/map/item-types.js';
import type { ZoteroFieldValue } from '../src/reader/types.js';

describe('item types', () => {
  it('maps onto a core Recueil type where one means the same thing', () => {
    expect(mapZoteroItemType('journalArticle')).toMatchObject({ itemType: 'article', kind: 'core' });
    expect(mapZoteroItemType('bookSection')).toMatchObject({ itemType: 'chapter', kind: 'core' });
    expect(mapZoteroItemType('conferencePaper')).toMatchObject({
      itemType: 'conference_paper',
      kind: 'core',
    });
    expect(mapZoteroItemType('computerProgram')).toMatchObject({ itemType: 'software', kind: 'core' });
  });

  it('carries a type Recueil does not ship across under its own name rather than flattening it', () => {
    expect(mapZoteroItemType('blogPost')).toMatchObject({ itemType: 'blog_post', kind: 'carried' });
    expect(mapZoteroItemType('audioRecording')).toMatchObject({
      itemType: 'audio_recording',
      kind: 'carried',
    });
    expect(mapZoteroItemType('case')).toMatchObject({ itemType: 'legal_case', kind: 'carried' });
  });

  it('derives a slug for a type it has never heard of, rather than losing the item', () => {
    expect(mapZoteroItemType('myCustomType')).toMatchObject({
      itemType: 'my_custom_type',
      kind: 'derived',
    });
    expect(slugify('3D Model')).toBe('x_3d_model');
    expect(slugify('!!!')).toBe('unknown');
  });

  it('records the CSL type, preferring the library’s own schema over the built-in table', () => {
    expect(mapZoteroItemType('preprint').cslType).toBe('article');
    expect(mapZoteroItemType('preprint', { preprint: 'article-journal' }).cslType).toBe('article-journal');
  });
});

describe('dates', () => {
  it('maps Zotero’s multipart date onto EDTF at the precision Zotero determined', () => {
    expect(mapZoteroDate('2019-08-00 August 2019')).toMatchObject({
      edtf: '2019-08',
      year: 2019,
      month: 8,
      raw: 'August 2019',
      rawIsLossy: true,
    });
    expect(mapZoteroDate('2018-11-06 2018-11-06')).toMatchObject({
      edtf: '2018-11-06',
      year: 2018,
      month: 11,
      rawIsLossy: false,
    });
    expect(mapZoteroDate('2021-00-00 2021')).toMatchObject({ edtf: '2021', month: null, rawIsLossy: false });
  });

  it('keeps a source string EDTF cannot hold, instead of dropping it', () => {
    expect(mapZoteroDate('2019-00-00 2019–2021')).toMatchObject({
      edtf: '2019',
      raw: '2019–2021',
      rawIsLossy: true,
    });
    expect(mapZoteroDate('0000-00-00 n.d.')).toMatchObject({
      edtf: null,
      year: null,
      raw: 'n.d.',
      rawIsLossy: true,
    });
    expect(mapZoteroDate('2021-06-08 8 juin 2021')).toMatchObject({
      edtf: '2021-06-08',
      raw: '8 juin 2021',
      rawIsLossy: true,
    });
  });

  it('maps Zotero’s SQL timestamps onto the fixed-width UTC form §1.1 requires', () => {
    expect(mapZoteroTimestamp('2023-03-16 09:19:41')).toBe('2023-03-16T09:19:41.000Z');
    expect(mapZoteroTimestamp('')).toBeNull();
    expect(mapZoteroTimestamp(null)).toBeNull();
  });
});

describe('Extra', () => {
  it('reads the conventions without altering the field', () => {
    const extra = 'Citation Key: schmidt2017soil\nPMID: 28123456\ntex.keywords: soil moisture, memory';
    const parsed = parseExtra(extra);
    expect(parsed.citationKey).toBe('schmidt2017soil');
    expect(parsed.pmid).toBe('28123456');
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[2]).toEqual({ label: 'tex.keywords', value: 'soil moisture, memory' });
  });

  it('keeps a line that is not a label at all', () => {
    const parsed = parseExtra('just a note to self\nDOI: 10.1000/xyz');
    expect(parsed.freeText).toEqual(['just a note to self']);
    expect(parsed.doi).toBe('10.1000/xyz');
  });

  it('is empty for an absent field', () => {
    expect(parseExtra(null).lines).toEqual([]);
    expect(parseExtra(undefined).citationKey).toBeNull();
  });
});

describe('creators', () => {
  it('keeps a particle that is part of the family string, without splitting it out', () => {
    expect(mapCreatorName({ creatorID: 1, lastName: 'van der Berg', firstName: 'Willem J.', fieldMode: 0 })).toEqual({
      kind: 'person',
      familyName: 'van der Berg',
      givenName: 'Willem J.',
      literalName: null,
      rawName: 'Willem J. van der Berg',
    });
    expect(mapCreatorName({ creatorID: 2, lastName: 'de Beauvoir', firstName: 'Simone', fieldMode: 0 }))
      .toMatchObject({ familyName: 'de Beauvoir' });
  });

  it('carries non-ASCII names through unchanged', () => {
    expect(mapCreatorName({ creatorID: 3, lastName: 'Ó Súilleabháin', firstName: 'Caoimhín', fieldMode: 0 }))
      .toMatchObject({ familyName: 'Ó Súilleabháin', givenName: 'Caoimhín' });
    expect(mapCreatorName({ creatorID: 4, lastName: 'Иванова', firstName: 'Екатерина Сергеевна', fieldMode: 0 }))
      .toMatchObject({ familyName: 'Иванова', givenName: 'Екатерина Сергеевна' });
    expect(mapCreatorName({ creatorID: 5, lastName: 'Szűcs', firstName: 'Márton', fieldMode: 0 }))
      .toMatchObject({ familyName: 'Szűcs' });
  });

  it('maps a single-field name onto a literal name, unsplit', () => {
    expect(mapCreatorName({ creatorID: 6, lastName: 'Ελληνική Στατιστική Αρχή', firstName: '', fieldMode: 1 })).toEqual({
      kind: 'organisation',
      familyName: null,
      givenName: null,
      literalName: 'Ελληνική Στατιστική Αρχή',
      rawName: 'Ελληνική Στατιστική Αρχή',
    });
    expect(mapCreatorName({ creatorID: 7, lastName: 'U.S. Geological Survey', firstName: null, fieldMode: 1 }))
      .toMatchObject({ kind: 'organisation', literalName: 'U.S. Geological Survey' });
  });

  it('gives two spellings of one name different identities, so neither is merged into the other', () => {
    const one = creatorIdentity(mapCreatorName({ creatorID: 8, lastName: 'Nakamura', firstName: 'Hiroshi', fieldMode: 0 }));
    const two = creatorIdentity(mapCreatorName({ creatorID: 9, lastName: 'Nakamura', firstName: 'Haruki', fieldMode: 0 }));
    expect(one).not.toBe(two);
  });

  it('maps the principal creator type of an item type onto author', () => {
    const primary = new Map([
      ['artwork', 'artist'],
      ['patent', 'inventor'],
      ['journalArticle', 'author'],
    ]);
    expect(mapCreatorRole('author', 'journalArticle', primary)).toEqual({ role: 'author', lossy: false });
    expect(mapCreatorRole('artist', 'artwork', primary)).toEqual({ role: 'author', lossy: true });
    expect(mapCreatorRole('inventor', 'patent', primary)).toEqual({ role: 'author', lossy: true });
    expect(mapCreatorRole('seriesEditor', 'book', primary)).toEqual({ role: 'series_editor', lossy: false });
    expect(mapCreatorRole('bookAuthor', 'bookSection', primary)).toEqual({ role: 'contributor', lossy: true });
  });
});

describe('fields', () => {
  const field = (name: string, base: string, value: string): ZoteroFieldValue => ({
    field: name,
    baseField: base,
    value,
  });

  it('resolves base fields onto facet columns', () => {
    const mapped = mapZoteroFields(
      [
        field('title', 'title', 'Lehrbuch der Hydrologie'),
        field('university', 'publisher', 'Universität Ulm'),
        field('thesisType', 'type', 'Dissertation'),
        field('numPages', 'numPages', '214'),
        field('date', 'date', '2022-00-00 2022'),
      ],
      { zoteroItemType: 'thesis', cslType: 'thesis' },
    );
    expect(mapped.bibliographic).toMatchObject({
      title: 'Lehrbuch der Hydrologie',
      publisher: 'Universität Ulm',
      numberOfPages: 214,
      issuedDate: '2022',
      issuedYear: 2022,
      cslType: 'thesis',
    });
    // `type` has no facet column, so it is carried rather than dropped.
    expect(mapped.carried.map((entry) => entry.fieldKey)).toContain('zotero_thesis_type');
  });

  it('writes a page count only when it is a whole number, and carries anything else', () => {
    const plain = mapZoteroFields([field('numPages', 'numPages', '214')], {
      zoteroItemType: 'book',
      cslType: 'book',
    });
    expect(plain.bibliographic.numberOfPages).toBe(214);

    const awkward = mapZoteroFields([field('numPages', 'numPages', 'xii + 214')], {
      zoteroItemType: 'book',
      cslType: 'book',
    });
    expect(awkward.bibliographic.numberOfPages).toBeUndefined();
    expect(awkward.carried).toContainEqual(
      expect.objectContaining({ fieldKey: 'zotero_num_pages', reason: 'rejected' }),
    );
  });

  it('carries an identifier the contract refuses, with the reason', () => {
    const mapped = mapZoteroFields([field('ISBN', 'ISBN', '978-3-11-054356-7')], {
      zoteroItemType: 'book',
      cslType: 'book',
    });
    expect(mapped.bibliographic.isbn).toBeUndefined();
    const carried = mapped.carried.find((entry) => entry.fieldKey === 'zotero_isbn');
    expect(carried).toMatchObject({ reason: 'rejected', value: '978-3-11-054356-7' });
    expect(carried?.detail).toMatch(/ISBN/u);
  });

  it('reads an arXiv id out of a preprint’s archiveID, and only for arXiv', () => {
    const arxiv = mapZoteroFields(
      [field('archiveID', 'number', 'arXiv:2211.04512'), field('repository', 'publisher', 'arXiv')],
      { zoteroItemType: 'preprint', cslType: 'article' },
    );
    expect(arxiv.bibliographic.arxivId).toBe('2211.04512');

    const earth = mapZoteroFields(
      [field('archiveID', 'number', 'X5RH2M'), field('repository', 'publisher', 'EarthArXiv')],
      { zoteroItemType: 'preprint', cslType: 'article' },
    );
    expect(earth.bibliographic.arxivId).toBeUndefined();
    expect(earth.carried.map((entry) => entry.fieldKey)).toContain('zotero_archive_id');
  });

  it('keeps Extra verbatim and does not put it in the facet', () => {
    const mapped = mapZoteroFields([field('extra', 'extra', 'Citation Key: x\nPMID: 1')], {
      zoteroItemType: 'journalArticle',
      cslType: 'article-journal',
    });
    expect(mapped.extra).toBe('Citation Key: x\nPMID: 1');
    expect(mapped.carried).toHaveLength(0);
  });

  it('gives the column to the first of two fields sharing a base field, and carries the second', () => {
    const mapped = mapZoteroFields(
      [field('series', 'series', 'Techniques and Methods'), field('seriesTitle', 'seriesTitle', 'TM')],
      { zoteroItemType: 'book', cslType: 'book' },
    );
    expect(mapped.bibliographic.collectionTitle).toBe('Techniques and Methods');
    expect(mapped.carried).toContainEqual(
      expect.objectContaining({ zoteroField: 'seriesTitle', reason: 'column_taken' }),
    );
  });
});

describe('page spans', () => {
  it('reads a span, a single page, and refuses anything else', () => {
    expect(parsePageSpan('218–233')).toEqual({ first: 218, last: 233 });
    expect(parsePageSpan('155-170')).toEqual({ first: 155, last: 170 });
    expect(parsePageSpan('125089')).toEqual({ first: 125089, last: 125089 });
    expect(parsePageSpan('e4')).toEqual({ first: null, last: null });
    expect(parsePageSpan('xii–xiv')).toEqual({ first: null, last: null });
    expect(parsePageSpan('200-100')).toEqual({ first: 200, last: null });
  });
});

describe('citation keys', () => {
  it('prefers Zotero’s own field, then the Extra line, then Better BibTeX', () => {
    expect(
      resolveCitationKey({
        native: 'vasquez2020trace',
        extraLine: 'vasquez2020traceelements',
        betterBibtex: { key: 'vasquez2020', pinned: true },
      }),
    ).toMatchObject({ key: 'vasquez2020trace', source: 'zotero_native', pinned: true, conflict: true });

    expect(resolveCitationKey({ extraLine: 'schmidt2017soil', betterBibtex: { key: 'schmidt2017soil', pinned: true } }))
      .toMatchObject({ key: 'schmidt2017soil', source: 'extra_line', conflict: false });

    expect(resolveCitationKey({ betterBibtex: { key: 'ng2022systematic', pinned: false } })).toMatchObject({
      key: 'ng2022systematic',
      source: 'better_bibtex',
      pinned: true,
    });
  });

  it('imports every migrated key pinned, whatever its source (ADR-0016)', () => {
    for (const inputs of [
      { native: 'a2020x' },
      { extraLine: 'b2020x' },
      { betterBibtex: { key: 'c2020x', pinned: false } },
    ]) {
      expect(resolveCitationKey(inputs).pinned).toBe(true);
    }
  });

  it('has no key, and no conflict, when the library carries none', () => {
    expect(resolveCitationKey({})).toMatchObject({ key: null, source: null, pinned: false, conflict: false });
  });
});

describe('annotations', () => {
  const base = {
    itemID: 1,
    parentItemID: 2,
    authorName: null,
    text: null,
    comment: null,
    color: '#ffd400',
    pageLabel: '224',
    sortIndex: '00007|000412|00287',
    isExternal: 0,
  };

  it('maps a highlight to a quote selector anchored by rectangles and a page', () => {
    const mapped = mapZoteroAnnotation({
      ...base,
      type: 1,
      text: 'Winterniederschläge nehmen zu',
      comment: 'Kernbefund',
      position: JSON.stringify({ pageIndex: 7, rects: [[71.2, 512.4, 480.9, 526.1]] }),
    });
    expect(mapped.annotationType).toBe('highlight');
    expect(mapped.motivation).toBe('highlighting');
    expect(mapped.quotedText).toBe('Winterniederschläge nehmen zu');
    expect(mapped.bodyText).toBe('Kernbefund');
    expect(mapped.pageIndex).toBe(7);
    expect(mapped.selector.map((selector) => selector.type)).toEqual([
      'TextQuoteSelector',
      'RectangleSelector',
      'FragmentSelector',
    ]);
    expect(mapped.selector[1]).toMatchObject({
      pageIndex: 7,
      rectangles: [{ x: 71.2, y: 512.4, width: expect.closeTo(409.7, 5), height: expect.closeTo(13.7, 5) }],
    });
  });

  it('maps ink to polylines', () => {
    const mapped = mapZoteroAnnotation({
      ...base,
      type: 4,
      position: JSON.stringify({ pageIndex: 11, paths: [[112.4, 500.1, 130.8, 512.7, 149.2, 498.3]], width: 2 }),
    });
    expect(mapped.annotationType).toBe('ink');
    expect(mapped.selector[0]).toMatchObject({
      type: 'InkSelector',
      pageIndex: 11,
      strokeWidth: 2,
      paths: [[{ x: 112.4, y: 500.1 }, { x: 130.8, y: 512.7 }, { x: 149.2, y: 498.3 }]],
    });
  });

  it('maps an image annotation to an area, with no text selector', () => {
    const mapped = mapZoteroAnnotation({
      ...base,
      type: 3,
      comment: 'Abbildung 3',
      position: JSON.stringify({ pageIndex: 10, rects: [[70, 380, 525, 700]] }),
    });
    expect(mapped.annotationType).toBe('area');
    expect(mapped.motivation).toBe('describing');
    expect(mapped.selector.map((selector) => selector.type)).toEqual(['RectangleSelector', 'FragmentSelector']);
  });

  it('always gives a note annotation a body, because the schema requires one', () => {
    const mapped = mapZoteroAnnotation({
      ...base,
      type: 2,
      comment: null,
      position: JSON.stringify({ pageIndex: 8, rects: [[492, 688, 516, 712]] }),
    });
    expect(mapped.annotationType).toBe('note');
    expect(mapped.bodyText).toBe('');
  });

  it('refuses an annotation nothing can anchor, rather than writing an unlocatable one', () => {
    expect(() => mapZoteroAnnotation({ ...base, type: 1, position: '{}' })).toThrow(/AN4/u);
    expect(() => mapZoteroAnnotation({ ...base, type: 99, position: '{"pageIndex":1}' })).toThrow(/type 99/u);
  });

  it('pads the sort index to a fixed width so comparison stays total', () => {
    expect(normaliseSortIndex('00007|000412|00287')).toBe('00007|000412|00287');
    expect(normaliseSortIndex('7|412|287')).toBe('00007|000412|00287');
    expect(normaliseSortIndex('')).toBe('00000|000000|00000');
    expect(normaliseSortIndex('00001|000002|00003') < normaliseSortIndex('00002|000000|00000')).toBe(true);
  });
});
