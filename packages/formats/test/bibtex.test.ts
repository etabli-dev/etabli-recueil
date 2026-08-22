/**
 * BibTeX and BibLaTeX, out and back.
 *
 * The fixture in `fixtures.ts` is a `.bib` file with the four features that separate a real parser
 * from a regular expression: `@string` macros, `#` concatenation, `crossref` inheritance and a
 * `file` field with a Windows-hostile colon separator.
 */
import { describe, expect, it } from 'vitest';

import {
  BIBTEX_FIELD_ORDER,
  exportBiblatex,
  exportBibtex,
  formatFileField,
  importBibtex,
  parseBibtexFile,
  parseBibtexName,
  parseFileField,
  resolveCrossReferences,
} from '../src/index.js';
import type { FormatRecord } from '../src/index.js';
import { BIBTEX_FIXTURE, awkward, chapter, ravaud } from './fixtures.js';

const fieldsOf = (entry: string): string[] =>
  entry
    .split('\n')
    .map((line) => /^\s{2}([a-z]+) = /u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

describe('entry type mapping', () => {
  const cases: Array<[string, string, string]> = [
    ['article', 'article', 'article'],
    ['book', 'book', 'book'],
    ['chapter', 'incollection', 'incollection'],
    ['report', 'techreport', 'report'],
    ['thesis', 'phdthesis', 'thesis'],
    ['conference_paper', 'inproceedings', 'inproceedings'],
    ['dataset', 'misc', 'dataset'],
    ['webpage', 'misc', 'online'],
    ['software', 'misc', 'software'],
    ['patent', 'misc', 'patent'],
    ['invoice', 'misc', 'misc'],
  ];

  it.each(cases)('%s → @%s / @%s', (itemType, bibtex, biblatex) => {
    const record: FormatRecord = { id: 't', itemType, bibliographic: { title: 'X' } };
    expect(exportBibtex([record]).text).toContain(`@${bibtex}{`);
    expect(exportBiblatex([record]).text).toContain(`@${biblatex}{`);
  });

  it('reports the collapse to @misc', () => {
    const { losses } = exportBibtex([{ id: 't', itemType: 'webpage', bibliographic: { title: 'X' } }]);
    expect(losses.some((loss) => loss.field === 'itemType')).toBe(true);
  });
});

describe('export', () => {
  it('writes the key ADR-0016 specifies', () => {
    expect(exportBibtex([ravaud]).text).toContain('@article{ravaudEffPreSys2019,');
  });

  it('escapes braces, ampersands, percent signs, accents and leaves maths alone', () => {
    const { text } = exportBibtex([awkward]);
    expect(text).toContain('title = {On \\{DNA\\} \\& 100\\% Efficiency: A $p < 0.05$ Study of {pH} in \\r{A}ngstr\\"{o}m Scales},');
    expect(text).toContain('author = {M\\"{u}ller, J\\"{o}rg and van Beethoven, Ludwig and Kennedy, Jr, John F.},');
  });

  it('passes UTF-8 through for BibLaTeX', () => {
    const { text } = exportBiblatex([awkward]);
    expect(text).toContain('author = {Müller, Jörg and van Beethoven, Ludwig and Kennedy, Jr, John F.},');
    expect(text).toContain('Ångström');
  });

  it('braces a corporate name so the name grammar leaves it alone', () => {
    expect(exportBibtex([awkward]).text).toContain('editor = {{World Health Organization}},');
  });

  it('emits fields in the canonical order, always', () => {
    const order = fieldsOf(exportBibtex([awkward]).text);
    const expected = order.map((name) => BIBTEX_FIELD_ORDER.indexOf(name));
    expect(expected).toEqual([...expected].sort((left, right) => left - right));
    expect(expected).not.toContain(-1);
  });

  it('is byte-identical on a second run, so the diff is empty', () => {
    expect(exportBibtex([awkward, chapter, ravaud]).text).toBe(exportBibtex([awkward, chapter, ravaud]).text);
  });

  it('writes a classic year/month pair and a BibLaTeX date', () => {
    expect(exportBibtex([chapter]).text).toContain('year = {2021},\n  month = sep,');
    expect(exportBiblatex([chapter]).text).toContain('date = {2021-09-15},');
  });

  it('uses school for a thesis and institution for a report', () => {
    const thesis: FormatRecord = { id: 't', itemType: 'thesis', bibliographic: { title: 'X', publisher: 'Universität Ulm' } };
    const report: FormatRecord = { id: 'r', itemType: 'report', bibliographic: { title: 'X', publisher: 'WHO' } };
    expect(exportBibtex([thesis]).text).toContain('school = {Universit\\"{a}t Ulm},');
    expect(exportBibtex([report]).text).toContain('institution = {WHO},');
  });

  it('writes booktitle for a chapter and journal for an article', () => {
    expect(exportBibtex([chapter]).text).toContain('booktitle = {Handbook of Methods},');
    expect(exportBibtex([awkward]).text).toContain('journal = {Journal of Awkward Results},');
    expect(exportBiblatex([awkward]).text).toContain('journaltitle = {Journal of Awkward Results},');
  });

  it('writes the file field for attachments', () => {
    expect(exportBibtex([awkward]).text).toContain('file = {Full Text PDF:files/1/paper.pdf:application/pdf},');
  });

  it('renders an empty batch as an empty file', () => {
    expect(exportBibtex([]).text).toBe('');
  });
});

describe('the file field', () => {
  const cases: Array<[string, string]> = [
    ['plain', 'Full Text PDF:files/1/paper.pdf:application/pdf'],
    ['windows path', 'Scan:C\\:\\\\lib\\\\x.pdf:application/pdf'],
  ];

  it.each(cases)('round-trips a %s', (_name, encoded) => {
    expect(formatFileField(parseFileField(encoded))).toBe(encoded);
  });

  it('reads the two-part spelling older tools write', () => {
    expect(parseFileField(':files/1/paper.pdf:application/pdf')).toEqual([
      { title: undefined, path: 'files/1/paper.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('reads several entries', () => {
    expect(parseFileField('A:a.pdf:application/pdf;B:b.pdf:application/pdf')).toHaveLength(2);
  });
});

describe('BibTeX names', () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ['Ravaud, Philippe', { familyName: 'Ravaud', givenName: 'Philippe' }],
    ['Philippe Ravaud', { familyName: 'Ravaud', givenName: 'Philippe' }],
    ['van Beethoven, Ludwig', { familyName: 'Beethoven', givenName: 'Ludwig', namePrefix: 'van' }],
    ['Ludwig van Beethoven', { familyName: 'Beethoven', givenName: 'Ludwig', namePrefix: 'van' }],
    ['Kennedy, Jr, John F.', { familyName: 'Kennedy', givenName: 'John F.', nameSuffix: 'Jr' }],
    ['de la Cruz, Ana', { familyName: 'Cruz', givenName: 'Ana', namePrefix: 'de la' }],
    ['{World Health Organization}', { literalName: 'World Health Organization' }],
    ['Ravaud', { familyName: 'Ravaud' }],
  ];

  it.each(cases)('parses %s', (input, expected) => {
    const parts = parseBibtexName(input);
    for (const [field, value] of Object.entries(expected)) {
      expect(parts[field as keyof typeof parts]).toBe(value);
    }
  });

  it('treats a braced Van as part of the family name, not a particle', () => {
    expect(parseBibtexName('{Van} Dijk, Jan').familyName).toBe('Van Dijk');
  });
});

describe('parsing a real .bib file', () => {
  const parsed = resolveCrossReferences(parseBibtexFile(BIBTEX_FIXTURE));

  it('collects the @string macros and expands them', () => {
    expect(parsed.strings.get('jaw')).toBe('Journal of Awkward Results');
    const article = parsed.entries.find((entry) => entry.key === 'muellerDNA100Eff2019');
    expect(article?.fields.get('journal')).toBe('Journal of Awkward Results');
  });

  it('concatenates with #', () => {
    const proceedings = parsed.entries.find((entry) => entry.key === 'handbook2021');
    expect(proceedings?.fields.get('publisher')).toBe('Cambridge University Press and Friends');
  });

  it('keeps @preamble and @comment out of the entry list', () => {
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.preambles).toHaveLength(1);
    expect(parsed.comments).toHaveLength(1);
  });

  it('inherits cross-referenced fields, renaming title to booktitle', () => {
    const child = parsed.entries.find((entry) => entry.key === 'szucsSta2021');
    expect(child?.fields.get('booktitle')).toBe('Handbook of Methods');
    expect(child?.fields.get('publisher')).toBe('Cambridge University Press and Friends');
    expect(child?.fields.get('address')).toBe('Cambridge');
    expect(child?.fields.get('title')).toBe('Statistical Power in Cognitive Neuroscience');
  });
});

describe('import', () => {
  const { records, losses } = importBibtex(BIBTEX_FIXTURE);

  it('builds one record per entry', () => {
    expect(records).toHaveLength(3);
  });

  it('decodes the accents and unwraps the protective braces', () => {
    const article = records[0];
    expect(article?.bibliographic?.title).toBe(
      'On {DNA} & 100% Efficiency: A $p < 0.05$ Study of pH in Ångström Scales',
    );
    expect(article?.creators?.[0]).toMatchObject({ familyName: 'Müller', givenName: 'Jörg' });
    expect(article?.creators?.[1]).toMatchObject({ familyName: 'Beethoven', namePrefix: 'van' });
    expect(article?.creators?.[2]).toMatchObject({ familyName: 'Kennedy', nameSuffix: 'Jr' });
    expect(article?.creators?.[3]).toMatchObject({ role: 'editor', literalName: 'World Health Organization' });
  });

  it('pins every imported key, so migration cannot rewrite a manuscript', () => {
    for (const record of records) {
      expect(record.bibliographic?.citationKeyLocked).toBe(true);
      expect(record.bibliographic?.citationKey).toBe(record.id);
    }
  });

  it('normalises the identifiers to the shape invariant B1 requires', () => {
    expect(records[0]?.bibliographic?.doi).toBe('10.1136/bmj.n71');
    expect(records[0]?.bibliographic?.issn).toBe('0140-6736');
  });

  it('reads the file field into attachments', () => {
    expect(records[0]?.attachments).toEqual([
      { path: 'files/1/paper.pdf', title: 'Full Text PDF', mimeType: 'application/pdf', role: 'primary' },
    ]);
  });

  it('splits the keywords', () => {
    expect(records[0]?.keywords).toEqual(['DNA repair', 'p53']);
  });

  it('reports the preamble rather than swallowing it', () => {
    expect(losses.some((loss) => loss.field === '@preamble')).toBe(true);
  });

  it('reports a field it has no home for, with its value', () => {
    const unknown = losses.find((loss) => loss.field === 'unheardof');
    expect(unknown?.value).toBe('something this importer has no field for');
    expect(unknown?.recordKey).toBe('szucsSta2021');
  });

  it('rejects an identifier the contract would refuse, and says why', () => {
    const { losses: bad } = importBibtex('@article{k, title = {X}, doi = {not-a-doi}}');
    expect(bad.find((loss) => loss.field === 'doi')?.reason).toContain('DOI');
  });

  it('survives a malformed entry and keeps the rest', () => {
    const { records: some } = importBibtex('@article{good, title = {Fine}}\n@article\n@book{also, title = {Fine}}');
    expect(some.map((record) => record.id)).toContain('good');
    expect(some.map((record) => record.id)).toContain('also');
  });

  it('converts an ISBN-10 to the stored ISBN-13', () => {
    const { records: one } = importBibtex('@book{k, title = {X}, isbn = {0-262-03561-8}}');
    expect(one[0]?.bibliographic?.isbn).toBe('9780262035613');
  });
});
