/**
 * CSL-JSON, out and back.
 *
 * The interesting parts are the two things CSL does better than the other three — structured names
 * and `date-parts` — and the one it does worse: it is the input format of a citation processor, so
 * it has no idea what a file on disk is.
 */
import { describe, expect, it } from 'vitest';

import { CSL_VARIABLE_ORDER, exportCslJson, importCslJson, toCslDate } from '../src/index.js';
import type { CslItem, FormatRecord } from '../src/index.js';
import { CSL_FIXTURE, awkward, chapter, ravaud } from './fixtures.js';

describe('type mapping', () => {
  const cases: Array<[string, string]> = [
    ['article', 'article-journal'],
    ['book', 'book'],
    ['chapter', 'chapter'],
    ['report', 'report'],
    ['thesis', 'thesis'],
    ['dataset', 'dataset'],
    ['webpage', 'webpage'],
    ['conference_paper', 'paper-conference'],
    ['software', 'software'],
    ['standard', 'standard'],
    ['patent', 'patent'],
    ['letter', 'personal_communication'],
    ['photo', 'graphic'],
    ['invoice', 'document'],
  ];

  it.each(cases)('%s → %s', (itemType, cslType) => {
    const { items } = exportCslJson([{ id: 't', itemType, bibliographic: { title: 'X' } }]);
    expect(items[0]?.type).toBe(cslType);
  });

  it('marks a preprint with a genre, since CSL 1.0.2 has no preprint type', () => {
    const { items } = exportCslJson([{ id: 't', itemType: 'preprint', bibliographic: { title: 'X' } }]);
    expect(items[0]?.type).toBe('article');
    expect(items[0]?.genre).toBe('preprint');
  });

  it('honours an explicit CSL type override', () => {
    const { items } = exportCslJson([{ id: 't', itemType: 'article', bibliographic: { title: 'X', cslType: 'article-magazine' } }]);
    expect(items[0]?.type).toBe('article-magazine');
  });
});

describe('dates', () => {
  const cases: Array<[string, unknown]> = [
    ['2019', { 'date-parts': [[2019]] }],
    ['2019-04', { 'date-parts': [[2019, 4]] }],
    ['2019-04-01', { 'date-parts': [[2019, 4, 1]] }],
    ['2019-04-01/2019-04-03', { 'date-parts': [[2019, 4, 1], [2019, 4, 3]] }],
    ['1920~', { 'date-parts': [[1920]], circa: true }],
  ];

  it.each(cases)('renders %s', (edtf, expected) => {
    expect(toCslDate(edtf)).toEqual(expected);
  });

  it('reads a range back into an EDTF interval', () => {
    const { records } = importCslJson([
      { id: 'x', type: 'article-journal', issued: { 'date-parts': [[2019, 4, 1], [2019, 4, 3]] } } as CslItem,
    ]);
    expect(records[0]?.bibliographic?.issuedDate).toBe('2019-04-01/2019-04-03');
  });

  it('reads circa back as an EDTF qualifier', () => {
    const { records } = importCslJson([{ id: 'x', type: 'book', issued: { 'date-parts': [[1920]], circa: true } } as CslItem]);
    expect(records[0]?.bibliographic?.issuedDate).toBe('1920~');
  });

  it('reports an issued date with no usable date-parts', () => {
    const { losses } = importCslJson([{ id: 'x', type: 'book', issued: { raw: 'sometime in the nineties' } } as CslItem]);
    expect(losses.find((loss) => loss.field === 'issued')?.value).toBe('sometime in the nineties');
  });
});

describe('names', () => {
  it('writes family, given, particle and suffix separately', () => {
    const { items } = exportCslJson([awkward]);
    expect(items[0]?.author).toEqual([
      { family: 'Müller', given: 'Jörg' },
      { family: 'Beethoven', given: 'Ludwig', 'non-dropping-particle': 'van' },
      { family: 'Kennedy', given: 'John F.', suffix: 'Jr' },
    ]);
  });

  it('writes a corporate name as a literal', () => {
    const { items } = exportCslJson([awkward]);
    expect(items[0]?.editor).toEqual([{ literal: 'World Health Organization' }]);
  });
});

describe('export', () => {
  it('writes variables in the canonical order', () => {
    const { items } = exportCslJson([awkward]);
    const positions = Object.keys(items[0] as CslItem).map((name) => CSL_VARIABLE_ORDER.indexOf(name));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('is byte-identical on a second run', () => {
    expect(exportCslJson([awkward, chapter, ravaud]).text).toBe(exportCslJson([awkward, chapter, ravaud]).text);
  });

  it('reports attachments, because CSL has no file variable', () => {
    const { losses } = exportCslJson([awkward]);
    expect(losses.find((loss) => loss.field === 'attachments')?.reason).toContain('no file variable');
  });

  it('carries the citation key in both id and citation-key', () => {
    const { items } = exportCslJson([ravaud]);
    expect(items[0]?.id).toBe('ravaudEffPreSys2019');
    expect(items[0]?.['citation-key']).toBe('ravaudEffPreSys2019');
  });
});

describe('import', () => {
  const { records, losses } = importCslJson(CSL_FIXTURE);
  const record = records[0];

  it('maps the type back', () => {
    expect(record?.itemType).toBe('chapter');
  });

  it('reads the structured names', () => {
    expect(record?.creators?.[0]).toMatchObject({ role: 'author', familyName: 'Szűcs', givenName: 'Dénes' });
    expect(record?.creators?.[1]).toMatchObject({ role: 'editor', familyName: 'Nowak' });
  });

  it('normalises the ISBN', () => {
    expect(record?.bibliographic?.isbn).toBe('9780262035613');
  });

  it('derives the page numbers from the page range', () => {
    expect(record?.bibliographic?.pageFirst).toBe(55);
    expect(record?.bibliographic?.pageLast).toBe(88);
  });

  it('reports the variable it has no field for', () => {
    expect(losses.find((loss) => loss.field === 'original-title')).toBeDefined();
  });

  it('reads a preprint back from type plus genre', () => {
    const { records: one } = importCslJson([{ id: 'p', type: 'article', genre: 'preprint', title: 'X' } as CslItem]);
    expect(one[0]?.itemType).toBe('preprint');
  });

  it('keeps a finer CSL type as an override', () => {
    const { records: one } = importCslJson([{ id: 'm', type: 'article-magazine', title: 'X' } as CslItem]);
    expect(one[0]?.itemType).toBe('article');
    expect(one[0]?.bibliographic?.cslType).toBe('article-magazine');
  });

  it('reports malformed JSON instead of throwing', () => {
    const result = importCslJson('{not json');
    expect(result.records).toEqual([]);
    expect(result.losses[0]?.field).toBe('@syntax');
  });

  it('accepts a single item as well as an array', () => {
    const { records: one } = importCslJson({ id: 's', type: 'book', title: 'X' } as CslItem);
    expect(one).toHaveLength(1);
  });
});

const roundTrip = (record: FormatRecord): FormatRecord | undefined =>
  importCslJson(exportCslJson([record]).text).records[0];

describe('round trip', () => {
  it('preserves the fields CSL can express', () => {
    const back = roundTrip(chapter);
    expect(back?.itemType).toBe('chapter');
    expect(back?.bibliographic?.title).toBe(chapter.bibliographic?.title);
    expect(back?.bibliographic?.containerTitle).toBe(chapter.bibliographic?.containerTitle);
    expect(back?.bibliographic?.collectionTitle).toBe(chapter.bibliographic?.collectionTitle);
    expect(back?.bibliographic?.collectionNumber).toBe(chapter.bibliographic?.collectionNumber);
    expect(back?.bibliographic?.publisher).toBe(chapter.bibliographic?.publisher);
    expect(back?.bibliographic?.publisherPlace).toBe(chapter.bibliographic?.publisherPlace);
    expect(back?.bibliographic?.edition).toBe(chapter.bibliographic?.edition);
    expect(back?.bibliographic?.issuedDate).toBe(chapter.bibliographic?.issuedDate);
    expect(back?.bibliographic?.isbn).toBe(chapter.bibliographic?.isbn);
    expect(back?.creators).toEqual(
      chapter.creators?.map((creator) => ({
        role: creator.role,
        kind: 'person',
        familyName: creator.familyName,
        givenName: creator.givenName,
        namePrefix: undefined,
        nameSuffix: undefined,
        literalName: undefined,
      })),
    );
  });
});
