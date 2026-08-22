/**
 * RIS, out and back.
 *
 * RIS is the format most likely to arrive from somewhere else, so the parser is tested against the
 * things real exporters do: a continuation line in the middle of a title, repeated `KW` tags, a
 * `DA` with empty day, CRLF endings and a tag nobody documents.
 */
import { describe, expect, it } from 'vitest';

import { RIS_TAG_ORDER, exportRis, importRis, parseRisFile, parseRisName } from '../src/index.js';
import type { FormatRecord } from '../src/index.js';
import { RIS_FIXTURE, awkward, chapter, ravaud } from './fixtures.js';

const lines = (text: string): string[] => text.split(/\r\n|\n/u).filter((line) => line.length > 0);
const tagsOf = (text: string): string[] => lines(text).map((line) => line.slice(0, 2));

describe('reference type mapping', () => {
  const cases: Array<[string, string]> = [
    ['article', 'JOUR'],
    ['book', 'BOOK'],
    ['chapter', 'CHAP'],
    ['report', 'RPRT'],
    ['thesis', 'THES'],
    ['dataset', 'DATA'],
    ['preprint', 'UNPB'],
    ['webpage', 'ELEC'],
    ['conference_paper', 'CPAPER'],
    ['software', 'COMP'],
    ['standard', 'STAND'],
    ['patent', 'PAT'],
    ['letter', 'PCOMM'],
    ['photo', 'ART'],
    ['invoice', 'GEN'],
  ];

  it.each(cases)('%s → TY %s', (itemType, ty) => {
    const record: FormatRecord = { id: 't', itemType, bibliographic: { title: 'X' } };
    expect(exportRis([record], { newline: '\n' }).text).toContain(`TY  - ${ty}`);
  });
});

describe('export', () => {
  const { text } = exportRis([awkward], { newline: '\n' });

  it('opens with TY and closes with ER', () => {
    const tags = tagsOf(text);
    expect(tags[0]).toBe('TY');
    expect(tags[tags.length - 1]).toBe('ER');
  });

  it('emits tags in the canonical order', () => {
    const positions = tagsOf(text).map((tag) => RIS_TAG_ORDER.indexOf(tag));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('writes names as Family, Given and repeats KW', () => {
    expect(text).toContain('AU  - Müller, Jörg');
    expect(text).toContain('AU  - van Beethoven, Ludwig');
    expect(text).toContain('AU  - Kennedy, John F., Jr');
    expect(text).toContain('A2  - World Health Organization');
    expect(text).toContain('KW  - DNA repair');
    expect(text).toContain('KW  - p53');
  });

  it('splits the page range into SP and EP', () => {
    expect(text).toContain('SP  - 123');
    expect(text).toContain('EP  - 145');
  });

  it('writes PY and a slash-delimited DA', () => {
    expect(text).toContain('PY  - 2019');
    expect(text).toContain('DA  - 2019/04//');
  });

  it('separates records with a blank line', () => {
    const both = exportRis([ravaud, chapter], { newline: '\n' }).text;
    expect(both).toContain('ER  -\n\nTY  - CHAP');
  });

  it('is byte-identical on a second run', () => {
    expect(exportRis([awkward, chapter]).text).toBe(exportRis([awkward, chapter]).text);
  });
});

describe('names', () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ['Ravaud, Philippe', { familyName: 'Ravaud', givenName: 'Philippe' }],
    ['Kennedy, John F., Jr', { familyName: 'Kennedy', givenName: 'John F.', nameSuffix: 'Jr' }],
    ['Ravaud', { familyName: 'Ravaud' }],
  ];

  it.each(cases)('parses %s', (input, expected) => {
    const parts = parseRisName(input);
    for (const [field, value] of Object.entries(expected)) {
      expect(parts[field as keyof typeof parts]).toBe(value);
    }
  });
});

describe('parsing', () => {
  it('joins a continuation line onto the tag above it', () => {
    const { records } = parseRisFile(RIS_FIXTURE);
    const title = records[0]?.tags.find(([tag]) => tag === 'TI');
    expect(title?.[1]).toBe('The Effect of Preprints on Systematic Review Timeliness');
  });

  it('accepts CRLF and a trailing ER with no space', () => {
    const { records } = parseRisFile('TY  - JOUR\r\nTI  - X\r\nER  -\r\n');
    expect(records).toHaveLength(1);
  });
});

describe('import', () => {
  const { records, losses } = importRis(RIS_FIXTURE);
  const record = records[0];

  it('builds one record', () => {
    expect(records).toHaveLength(1);
    expect(record?.itemType).toBe('article');
  });

  it('reads both authors, the container and the numbering', () => {
    expect(record?.creators).toEqual([
      { role: 'author', kind: 'person', familyName: 'Ravaud', givenName: 'Philippe', namePrefix: undefined, nameSuffix: undefined, literalName: undefined },
      { role: 'author', kind: 'person', familyName: 'Créquit', givenName: 'Perrine', namePrefix: undefined, nameSuffix: undefined, literalName: undefined },
    ]);
    expect(record?.bibliographic?.containerTitle).toBe('Journal of Awkward Results');
    expect(record?.bibliographic?.volume).toBe('12');
    expect(record?.bibliographic?.issue).toBe('3');
    expect(record?.bibliographic?.pages).toBe('123-145');
    expect(record?.bibliographic?.pageFirst).toBe(123);
    expect(record?.bibliographic?.pageLast).toBe(145);
  });

  it('reads DA into a partial EDTF date', () => {
    expect(record?.bibliographic?.issuedDate).toBe('2019-04');
    expect(record?.bibliographic?.issuedYear).toBe(2019);
    expect(record?.bibliographic?.issuedMonth).toBe(4);
  });

  it('reads Y2 into a timestamp', () => {
    expect(record?.bibliographic?.accessedAt).toBe('2024-05-01T00:00:00.000Z');
  });

  it('recognises SN as an ISSN', () => {
    expect(record?.bibliographic?.issn).toBe('0140-6736');
  });

  it('pins the key from ID', () => {
    expect(record?.bibliographic?.citationKey).toBe('ravaudEffPreSys2019');
    expect(record?.bibliographic?.citationKeyLocked).toBe(true);
  });

  it('collects the repeated KW tags and the L1 attachment', () => {
    expect(record?.keywords).toEqual(['preprints', 'systematic reviews']);
    expect(record?.attachments).toEqual([{ path: 'files/1/paper.pdf', role: 'primary' }]);
  });

  it('reports the tag it has no field for', () => {
    const unknown = losses.find((loss) => loss.field === 'XX');
    expect(unknown?.value).toBe('a tag nothing understands');
  });

  it('reports an unknown reference type instead of guessing silently', () => {
    const { losses: bad } = importRis('TY  - ZZZZ\nTI  - X\nER  -\n');
    expect(bad.find((loss) => loss.field === 'TY')?.reason).toContain('ZZZZ');
  });

  it('recognises an ISBN in SN when it is not an ISSN', () => {
    const { records: one } = importRis('TY  - BOOK\nTI  - X\nSN  - 978-0-262-03561-3\nER  -\n');
    expect(one[0]?.bibliographic?.isbn).toBe('9780262035613');
  });
});
