/**
 * Round trips.
 *
 * P10 says exports mirror importers. Two assertions make that testable rather than rhetorical:
 *
 * 1. **Re-export identity.** Exporting a record, importing the result and exporting again must
 *    produce byte-identical text. Anything the importer misreads shows up as a diff, and anything
 *    the exporter writes non-deterministically shows up as the same diff.
 * 2. **Field survival.** For each format, the fields it can express must come back equal. The ones
 *    it cannot must appear in the loss report — asserted here, not assumed.
 */
import { describe, expect, it } from 'vitest';

import {
  exportBiblatex,
  exportBibtex,
  exportCslJson,
  exportRis,
  importBiblatex,
  importBibtex,
  importCslJson,
  importRis,
} from '../src/index.js';
import type { ExportResult, FormatName, FormatRecord, ImportResult } from '../src/index.js';
import { awkward, chapter, ravaud } from './fixtures.js';

interface FormatUnderTest {
  readonly name: FormatName;
  readonly write: (records: readonly FormatRecord[]) => ExportResult;
  readonly read: (text: string) => ImportResult;
  /** Bibliographic fields this format can carry unchanged. */
  readonly survives: readonly string[];
  /** `true` where the format has no particle field, so `van` comes back inside the family name. */
  readonly mergesParticle?: boolean;
}

const formats: readonly FormatUnderTest[] = [
  {
    name: 'bibtex',
    write: (records) => exportBibtex(records),
    read: (text) => importBibtex(text),
    survives: [
      'title', 'containerTitle', 'containerShort', 'collectionTitle', 'volume', 'issue', 'pages',
      'pageFirst', 'pageLast', 'publisher', 'publisherPlace', 'edition', 'doi', 'isbn', 'issn',
      'languageCode', 'abstract', 'accessedAt', 'citationKey',
    ],
  },
  {
    name: 'biblatex',
    write: (records) => exportBiblatex(records),
    read: (text) => importBiblatex(text),
    survives: [
      'title', 'subtitle', 'containerTitle', 'containerShort', 'collectionTitle', 'volume', 'issue',
      'pages', 'pageFirst', 'pageLast', 'publisher', 'publisherPlace', 'edition', 'issuedDate',
      'issuedYear', 'issuedMonth', 'doi', 'isbn', 'issn', 'languageCode', 'abstract', 'accessedAt',
      'citationKey', 'versionLabel',
    ],
  },
  {
    name: 'ris',
    write: (records) => exportRis(records),
    read: (text) => importRis(text),
    mergesParticle: true,
    survives: [
      'title', 'containerTitle', 'containerShort', 'collectionTitle', 'volume', 'issue', 'pages',
      'pageFirst', 'pageLast', 'publisher', 'publisherPlace', 'edition', 'issuedDate', 'issuedYear',
      'issuedMonth', 'doi', 'isbn', 'issn', 'languageCode', 'abstract', 'accessedAt', 'citationKey',
    ],
  },
  {
    name: 'csl-json',
    write: (records) => exportCslJson(records),
    read: (text) => importCslJson(text),
    survives: [
      'title', 'containerTitle', 'containerShort', 'collectionTitle', 'collectionNumber', 'volume',
      'issue', 'pages', 'pageFirst', 'pageLast', 'publisher', 'publisherPlace', 'edition',
      'issuedDate', 'issuedYear', 'issuedMonth', 'doi', 'isbn', 'issn', 'pmid', 'pmcid',
      'languageCode', 'abstract', 'accessedAt', 'citationKey', 'versionLabel',
    ],
  },
];

const fixtures: readonly (readonly [string, FormatRecord])[] = [
  ['the ADR-0016 example', ravaud],
  ['a title full of hazards', awkward],
  ['a book chapter', chapter],
];

for (const format of formats) {
  describe(`${format.name} round trip`, () => {
    it.each(fixtures)('re-exports %s byte for byte', (_name, record) => {
      const once = format.write([record]).text;
      const back = format.read(once).records;
      expect(back).toHaveLength(1);
      const twice = format.write(back).text;
      expect(twice).toBe(once);
    });

    it.each(fixtures)('brings back the fields it can express, for %s', (_name, record) => {
      const back = format.read(format.write([record]).text).records[0];
      const source = record.bibliographic ?? {};
      const target = back?.bibliographic ?? {};
      for (const field of format.survives) {
        const original = (source as Record<string, unknown>)[field];
        if (original === undefined || original === null) continue;
        expect({ field, value: (target as Record<string, unknown>)[field] }).toEqual({ field, value: original });
      }
    });

    it.each(fixtures)('brings back the creators of %s', (_name, record) => {
      const back = format.read(format.write([record]).text).records[0];
      const expected = (record.creators ?? []).map((creator) => {
        const particle = format.mergesParticle === true ? creator.namePrefix : undefined;
        return {
          role: creator.role,
          familyName:
            particle === undefined || creator.familyName === undefined
              ? creator.familyName
              : `${particle} ${creator.familyName}`,
          givenName: creator.givenName,
          namePrefix: format.mergesParticle === true ? undefined : creator.namePrefix,
          nameSuffix: creator.nameSuffix,
          literalName: creator.literalName,
        };
      });
      const actual = (back?.creators ?? []).map((creator) => ({
        role: creator.role,
        familyName: creator.familyName,
        givenName: creator.givenName,
        namePrefix: creator.namePrefix,
        nameSuffix: creator.nameSuffix,
        literalName: creator.literalName,
      }));
      expect(actual).toEqual(expected);
    });

    it('imports the key pinned, so a re-export cannot rename it', () => {
      const first = format.write([ravaud]).text;
      const back = format.read(first).records[0];
      expect(back?.bibliographic?.citationKeyLocked).toBe(true);
      expect(back?.bibliographic?.citationKey).toBe('ravaudEffPreSys2019');
    });
  });
}

describe('what does not survive is reported', () => {
  const lossy: FormatRecord = {
    id: 'L',
    itemType: 'article',
    createdAt: '2026-01-01T00:00:00.000Z',
    creators: [
      { role: 'author', familyName: 'Ravaud' },
      { role: 'recipient', familyName: 'Boutron' },
    ],
    notes: ['a note that has nowhere to go'],
    attachments: [{ path: 'files/1/x.pdf', title: 'Full Text PDF', mimeType: 'application/pdf', role: 'supplement' }],
    bibliographic: {
      title: 'A Study',
      subtitle: 'And a Subtitle',
      openalexId: 'W2741809807',
      semanticScholarId: '0'.repeat(40),
      handle: '20.500.12345/678',
      licence: 'CC-BY-4.0',
      oaStatus: 'gold',
      eissn: '1476-4687',
      issn: '0140-6736',
      retractionNoticeDoi: '10.1136/bmj.n72',
      accessedAt: '2024-05-01T13:45:00.000Z',
    },
  };

  const cases: Array<[FormatName, ExportResult, readonly string[]]> = [
    ['bibtex', exportBibtex([lossy]), ['subtitle', 'openalexId', 'semanticScholarId', 'handle', 'licence', 'oaStatus', 'eissn', 'retractionNoticeDoi', 'notes', 'creators.recipient', 'accessedAt']],
    ['biblatex', exportBiblatex([lossy]), ['openalexId', 'semanticScholarId', 'handle', 'licence', 'oaStatus', 'eissn', 'retractionNoticeDoi', 'creators.recipient', 'accessedAt']],
    ['ris', exportRis([lossy]), ['subtitle', 'openalexId', 'semanticScholarId', 'handle', 'licence', 'oaStatus', 'eissn', 'retractionNoticeDoi', 'creators.recipient', 'attachments.title', 'accessedAt']],
    ['csl-json', exportCslJson([lossy]), ['subtitle', 'openalexId', 'semanticScholarId', 'handle', 'licence', 'oaStatus', 'eissn', 'retractionNoticeDoi', 'attachments', 'creators.recipient', 'accessedAt']],
  ];

  it.each(cases)('%s names every field it dropped', (name, result, expected) => {
    const reported = new Set(result.losses.map((loss) => loss.field));
    for (const field of expected) {
      expect({ format: name, field, reported: reported.has(field) }).toEqual({ format: name, field, reported: true });
    }
    for (const loss of result.losses) {
      expect(loss.direction).toBe('export');
      expect(loss.format).toBe(name);
      expect(loss.reason.length).toBeGreaterThan(0);
    }
  });

  it('drops the subtitle into the title in the formats that have no field for it', () => {
    const bibtex = importBibtex(exportBibtex([lossy]).text).records[0];
    expect(bibtex?.bibliographic?.title).toBe('A Study: And a Subtitle');
    expect(bibtex?.bibliographic?.subtitle).toBeUndefined();
    const biblatex = importBiblatex(exportBiblatex([lossy]).text).records[0];
    expect(biblatex?.bibliographic?.title).toBe('A Study');
    expect(biblatex?.bibliographic?.subtitle).toBe('And a Subtitle');
  });

  it('loses the electronic ISSN when a print one is present, and says so', () => {
    const back = importBibtex(exportBibtex([lossy]).text).records[0];
    expect(back?.bibliographic?.issn).toBe('0140-6736');
    expect(back?.bibliographic?.eissn).toBeUndefined();
  });
});

describe('a batch keeps its keys apart', () => {
  const twin = (id: string, createdAt: string): FormatRecord => ({
    id,
    itemType: 'article',
    createdAt,
    creators: [{ role: 'author', familyName: 'Smith' }],
    bibliographic: { title: 'A Repeated Title', issuedDate: '2019' },
  });

  it.each(formats.map((format) => [format.name, format] as const))('%s', (_name, format) => {
    const text = format.write([twin('A', '2026-01-01T00:00:00.000Z'), twin('B', '2026-02-01T00:00:00.000Z')]).text;
    const keys = format.read(text).records.map((record) => record.bibliographic?.citationKey);
    expect(keys).toEqual(['smithRepTit2019', 'smithRepTit2019a']);
  });
});
