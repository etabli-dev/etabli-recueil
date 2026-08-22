/**
 * The documented limitations and the loss reports must agree.
 *
 * `FORMAT_LIMITATIONS` is a promise made to a user before an export runs: "this is what will not
 * survive". A promise that the exporters do not keep is worse than no promise, so every reportable
 * entry in the table is probed here with a record that has exactly that field set, and the export
 * has to name it.
 *
 * Fields marked `reportable: false` are the ones no exporter can name because the projection from
 * `Item` to `FormatRecord` has already dropped them; they are documented but not probed.
 */
import { describe, expect, it } from 'vitest';

import {
  FORMAT_LIMITATIONS,
  FORMAT_NAMES,
  exportBiblatex,
  exportBibtex,
  exportCslJson,
  exportRis,
} from '../src/index.js';
import type { ExportResult, FormatName, FormatRecord } from '../src/index.js';

const write: Readonly<Record<FormatName, (records: readonly FormatRecord[]) => ExportResult>> = {
  bibtex: (records) => exportBibtex(records),
  biblatex: (records) => exportBiblatex(records),
  ris: (records) => exportRis(records),
  'csl-json': (records) => exportCslJson(records),
};

const base: FormatRecord = {
  id: 'probe',
  itemType: 'article',
  createdAt: '2026-01-01T00:00:00.000Z',
  creators: [{ role: 'author', familyName: 'Smith', givenName: 'Jane' }],
  bibliographic: { title: 'A Probe', issuedDate: '2019' },
};

const withBib = (fields: Record<string, unknown>): FormatRecord => ({
  ...base,
  bibliographic: { ...base.bibliographic, ...fields },
});

/** A record that sets exactly the field under test. Keyed `format:field`, falling back to `field`. */
const PROBES: Readonly<Record<string, FormatRecord>> = {
  itemType: { ...base, itemType: 'invoice' },
  subtitle: withBib({ subtitle: 'And a Subtitle' }),
  'bibtex:issuedDate': withBib({ issuedDate: '2019-04-01' }),
  'ris:issuedDate': withBib({ issuedDate: '2019/2020' }),
  'csl-json:issuedDate': withBib({ issuedDate: '2019/..' }),
  availableDate: withBib({ availableDate: '2019-03' }),
  collectionNumber: withBib({ collectionNumber: '4', issue: '2' }),
  versionLabel: withBib({ versionLabel: 'v2' }),
  licence: withBib({ licence: 'CC-BY-4.0' }),
  eissn: withBib({ issn: '0140-6736', eissn: '1476-4687' }),
  isbn: withBib({ issn: '0140-6736', isbn: '9780262035613' }),
  cslType: withBib({ cslType: 'article-magazine' }),
  numberOfPages: withBib({ numberOfPages: 320 }),
  pmid: withBib({ pmid: '33782057' }),
  pmcid: withBib({ pmcid: 'PMC8005924' }),
  arxivId: withBib({ arxivId: '2103.00020v2' }),
  openalexId: withBib({ openalexId: 'W2741809807' }),
  semanticScholarId: withBib({ semanticScholarId: '0'.repeat(40) }),
  issnL: withBib({ issnL: '0140-6736' }),
  dataciteDoi: withBib({ dataciteDoi: '10.5061/dryad.1' }),
  handle: withBib({ handle: '20.500.12345/678' }),
  oaStatus: withBib({ oaStatus: 'gold' }),
  oaUrl: withBib({ url: 'https://example.org/a', oaUrl: 'https://example.org/oa' }),
  publishedVersionDoi: withBib({ publishedVersionDoi: '10.1136/bmj.n72' }),
  retractionNoticeDoi: withBib({ retractionNoticeDoi: '10.1136/bmj.n73' }),
  citationKeyFormula: withBib({ citationKeyFormula: 'auth + year' }),
  accessedAt: withBib({ accessedAt: '2024-05-01T13:45:00.000Z' }),
  notes: { ...base, notes: ['a note with nowhere to go'] },
  attachments: { ...base, attachments: [{ path: 'files/1/x.pdf', title: 'PDF', role: 'primary' }] },
  'attachments.role': { ...base, attachments: [{ path: 'files/1/x.pdf', role: 'supplement' }] },
  'attachments.title': { ...base, attachments: [{ path: 'files/1/x.pdf', title: 'Full Text PDF' }] },
  'creators.other': {
    ...base,
    creators: [...(base.creators ?? []), { role: 'recipient', familyName: 'Boutron' }],
  },
  'creators.translator': {
    ...base,
    creators: [...(base.creators ?? []), { role: 'translator', familyName: 'Nowak' }],
  },
  'creators.namePrefix': {
    ...base,
    creators: [{ role: 'author', familyName: 'Beethoven', givenName: 'Ludwig', namePrefix: 'van' }],
  },
};

/** Where the loss entry's field name differs from the limitation's, because a role is concrete. */
const REPORTED_AS: Readonly<Record<string, string>> = {
  'creators.other': 'creators.recipient',
  'creators.translator': 'creators.translator',
};

describe('the limitations table', () => {
  it('covers every format', () => {
    expect(Object.keys(FORMAT_LIMITATIONS).sort()).toEqual([...FORMAT_NAMES].sort());
  });

  it('gives every entry a field, a disposition and a note', () => {
    for (const [format, limitations] of Object.entries(FORMAT_LIMITATIONS)) {
      expect(limitations.length).toBeGreaterThan(0);
      for (const limitation of limitations) {
        expect({ format, field: limitation.field }).toEqual({ format, field: expect.any(String) });
        expect(limitation.field.length).toBeGreaterThan(0);
        expect(limitation.note.length).toBeGreaterThan(0);
        expect(['dropped', 'merged', 'approximated']).toContain(limitation.disposition);
      }
    }
  });

  it('lists no field twice for the same format', () => {
    for (const [format, limitations] of Object.entries(FORMAT_LIMITATIONS)) {
      const fields = limitations.map((limitation) => limitation.field);
      expect({ format, duplicates: fields.length - new Set(fields).size }).toEqual({ format, duplicates: 0 });
    }
  });
});

const probeCases = FORMAT_NAMES.flatMap((format) =>
  FORMAT_LIMITATIONS[format]
    .filter((limitation) => limitation.reportable !== false)
    .map((limitation) => [format, limitation.field] as const),
);

describe('every documented limitation is reported by the exporter', () => {
  it.each(probeCases)('%s loses %s', (format, field) => {
    const probe = PROBES[`${format}:${field}`] ?? PROBES[field];
    expect({ field, hasProbe: probe !== undefined }).toEqual({ field, hasProbe: true });
    const { losses } = write[format]([probe as FormatRecord]);
    const expected = REPORTED_AS[field] ?? field;
    const reported = losses.map((loss) => loss.field);
    expect({ field, reported: reported.includes(expected) }).toEqual({ field, reported: true });
  });
});

describe('a record with nothing unusual on it loses nothing', () => {
  it.each(FORMAT_NAMES.map((format) => [format] as const))('%s', (format) => {
    const plain: FormatRecord = {
      id: 'plain',
      itemType: 'article',
      createdAt: '2026-01-01T00:00:00.000Z',
      creators: [{ role: 'author', familyName: 'Smith', givenName: 'Jane' }],
      bibliographic: {
        title: 'A Plain Article',
        containerTitle: 'A Journal',
        volume: '1',
        issue: '2',
        pages: '3-4',
        issuedDate: '2019',
        doi: '10.1136/bmj.n71',
      },
    };
    expect(write[format]([plain]).losses).toEqual([]);
  });
});
