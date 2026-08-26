/**
 * A small Paperless-ngx library, built to be awkward.
 *
 * Ten documents is not a load test and is not meant to be. Every one of them is here because it
 * exercises a decision the importer has to get right, and the awkward cases outnumber the ordinary
 * ones on purpose:
 *
 * | # | What it is there for |
 * |---|---|
 * | 1 | The ordinary case: recognised type, correspondent, ASN, money, reference number, a note |
 * | 2 | A contract with a period, a `select` value and a `documentlink` to document 1 |
 * | 3 | No correspondent, no document type, and a hostile `original_file_name` |
 * | 4 | A document type Recueil has no item type for, and money with no currency anywhere |
 * | 5 | An original the server 404s: the item must still be there, with a review entry |
 * | 6 | An ASN Paperless already used on document 1 |
 * | 7 | An original whose bytes do not hash to the MD5 Paperless recorded |
 * | 8 | A `select` value whose option id is not in the field |
 * | 9 | A `documentlink` to a document outside this library |
 * | 10 | Byte-for-byte the same original as document 1 |
 *
 * One awkward case is deliberately **not** here: a document carrying a tag id `/api/tags/` never
 * defined. It used to be, on document 8, and it made this library one whose verification report can
 * never be clean — because a tag the source will not name cannot be carried under any name, and
 * `tag_references_resolvable` is blocking for that reason (ADR-0021 §2: an exclusion is a finding,
 * not a subtraction from both sides). A fixture whose correct answer is FAIL cannot also be the
 * fixture every other test asserts a clean import against, so the dangling reference has its own
 * adversarial test in `test/report-checks.test.ts`, where the assertion is that the report fails.
 *
 * The names are German because the install this importer was written for is, and because a
 * bilingual recognition table that is only ever tested in English is a table nobody has tested.
 */
import { Buffer } from 'node:buffer';

import type { PaperlessCustomField } from '../client/types.js';
import type { FakeLibrary, FakeOriginal } from './fake-server.js';

/** A deterministic pseudo-PDF: real enough to be sniffed as one, cheap enough to keep inline. */
export const fakePdf = (marker: string): Buffer =>
  Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer\n%%EOF\n`, 'utf8');

/** A one-pixel PNG, so the MIME sniffing has something that is genuinely not a PDF. */
export const fakePng = (): Buffer =>
  Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
      '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );

export const FIXTURE_TOKEN = 'fixture-token';

/** The custom fields, in Paperless id order. */
export const fixtureCustomFields = (): PaperlessCustomField[] => [
  {
    id: 1,
    name: 'Betrag',
    data_type: 'monetary',
    // No `default_currency`: document 4's legacy value then has no currency anywhere, which is the
    // case `ck_item_office_amount` refuses and the report has to explain rather than guess past.
    extra_data: { default_currency: null },
    document_count: 3,
  },
  { id: 2, name: 'Rechnungsnummer', data_type: 'string', document_count: 2 },
  { id: 3, name: 'Zeitraum von', data_type: 'date', document_count: 1 },
  { id: 4, name: 'Zeitraum bis', data_type: 'date', document_count: 1 },
  {
    id: 5,
    name: 'Status',
    data_type: 'select',
    extra_data: {
      select_options: [
        { id: 'aBcD1234aBcD1234', label: 'offen' },
        { id: 'eFgH5678eFgH5678', label: 'bezahlt' },
      ],
    },
    document_count: 2,
  },
  { id: 6, name: 'Verknüpfte Dokumente', data_type: 'documentlink', document_count: 2 },
  { id: 7, name: 'Bemerkung', data_type: 'longtext', document_count: 1 },
  { id: 8, name: 'Bezahlt', data_type: 'boolean', document_count: 1 },
  { id: 9, name: 'Seitenzahl', data_type: 'integer', document_count: 1 },
  { id: 10, name: 'Bewertung', data_type: 'float', document_count: 1 },
  { id: 11, name: 'Webseite', data_type: 'url', document_count: 1 },
  { id: 12, name: 'Fälligkeit', data_type: 'date', document_count: 1 },
  // A data type this importer has never heard of. Paperless would not send one today; a future
  // release will, and the importer must skip its values rather than put them in a `text` column.
  {
    id: 13,
    name: 'Zukunftsfeld',
    data_type: 'quantum' as PaperlessCustomField['data_type'],
    document_count: 1,
  },
];

/** The whole fixture library, freshly constructed so a test may mutate it. */
export const fixtureLibrary = (): FakeLibrary => {
  const sharedOriginal = fakePdf('stadtwerke-2024-03');

  const originals = new Map<number, FakeOriginal>([
    [1, { bytes: sharedOriginal, filename: 'Stadtwerke_2024-03.pdf' }],
    [2, { bytes: fakePdf('mietvertrag'), filename: 'Mietvertrag.pdf' }],
    [
      3,
      {
        bytes: fakePng(),
        contentType: 'image/png',
        // Hostile on purpose: the filename is a string a person typed into Paperless, and nothing
        // downstream may open a file by it.
        filename: '../../../etc/passwd',
      },
    ],
    [4, { bytes: fakePdf('kontoauszug-2024-02'), filename: 'Kontoauszug.pdf' }],
    /* 5 is deliberately absent: the server 404s its original. */
    [6, { bytes: fakePdf('doppelte-asn'), filename: 'Doppelt.pdf' }],
    [
      7,
      {
        bytes: fakePdf('geaenderte-datei'),
        filename: 'Geaendert.pdf',
        // Paperless computed this when it consumed the file; the bytes on disk have changed since.
        reportedMd5: '00000000000000000000000000000000',
      },
    ],
    [8, { bytes: fakePdf('unbekannte-option'), filename: 'Status.pdf' }],
    [9, { bytes: fakePdf('verknuepfung'), filename: 'Verknuepfung.pdf' }],
    // Byte-for-byte document 1: one blob, two attachments (ADR-0004).
    [10, { bytes: sharedOriginal, filename: 'Stadtwerke_2024-03_Kopie.pdf' }],
  ]);

  return {
    correspondents: [
      { id: 1, name: 'Stadtwerke Ulm', slug: 'stadtwerke-ulm', document_count: 3 },
      { id: 2, name: 'Hausverwaltung Müller', slug: 'hausverwaltung-muller', document_count: 1 },
      { id: 3, name: 'Sparkasse', slug: 'sparkasse', document_count: 1 },
      // Listed but never used: the report counts it as unused rather than as missing.
      { id: 4, name: 'Finanzamt', slug: 'finanzamt', document_count: 0 },
    ],
    documentTypes: [
      { id: 1, name: 'Rechnung', slug: 'rechnung', document_count: 3 },
      { id: 2, name: 'Vertrag', slug: 'vertrag', document_count: 1 },
      // Recueil has no `statement` item type, so this one is carried in `office_document_type`.
      { id: 3, name: 'Kontoauszug', slug: 'kontoauszug', document_count: 1 },
      { id: 4, name: 'Foto', slug: 'foto', document_count: 0 },
    ],
    tags: [
      { id: 1, name: 'Wohnung', color: '#FF0000', document_count: 4 },
      { id: 2, name: 'Energie', color: '#00ff00', parent: 1, document_count: 2 },
      { id: 3, name: 'Posteingang', color: '#0000ff', is_inbox_tag: true, document_count: 1 },
      { id: 4, name: 'Steuer', document_count: 1 },
    ],
    storagePaths: [{ id: 1, name: 'Wohnung', path: 'Wohnung/{{ created_year }}', document_count: 2 }],
    customFields: fixtureCustomFields(),
    originals,
    documents: [
      {
        id: 1,
        correspondent: 1,
        document_type: 1,
        storage_path: 1,
        title: 'Stadtwerke Rechnung März 2024',
        content: 'Rechnungsbetrag 89,90 EUR',
        tags: [1, 2],
        created: '2024-03-01',
        modified: '2024-03-04T11:02:33.000000+01:00',
        added: '2024-03-02T08:15:00.000000+01:00',
        deleted_at: null,
        archive_serial_number: 1001,
        original_file_name: 'Stadtwerke_2024-03.pdf',
        mime_type: 'application/pdf',
        notes: [{ id: 1, note: 'Per Lastschrift bezahlt.', created: '2024-03-05T09:00:00.000000Z' }],
        custom_fields: [
          { field: 1, value: 'EUR89.90' },
          { field: 2, value: 'RE-2024-0031' },
          { field: 5, value: 'eFgH5678eFgH5678' },
          { field: 8, value: true },
          { field: 9, value: 2 },
          { field: 10, value: 4.5 },
          { field: 11, value: 'https://stadtwerke.example/rechnungen/2024-03' },
          { field: 12, value: '2024-03-20' },
        ],
      },
      {
        id: 2,
        correspondent: 2,
        document_type: 2,
        storage_path: 1,
        title: 'Mietvertrag Bahnhofstraße',
        tags: [1],
        created: '2023-09-15',
        modified: '2023-09-16T09:00:00.000000+02:00',
        added: '2023-09-15T18:44:10.000000+02:00',
        deleted_at: null,
        archive_serial_number: 1002,
        original_file_name: 'Mietvertrag.pdf',
        mime_type: 'application/pdf',
        notes: [
          { id: 2, note: 'Kündigungsfrist drei Monate.', created: '2023-09-16T10:00:00.000000Z' },
          { id: 3, note: 'Kaution überwiesen.', created: '2023-09-17T10:00:00.000000Z' },
        ],
        custom_fields: [
          { field: 3, value: '2023-10-01' },
          { field: 4, value: '2026-09-30' },
          { field: 5, value: 'aBcD1234aBcD1234' },
          { field: 6, value: [1] },
          { field: 7, value: 'Der Vertrag verlängert sich stillschweigend um je ein Jahr.' },
        ],
      },
      {
        id: 3,
        // No correspondent: the facet needs one, so the placeholder is used and counted.
        correspondent: null,
        document_type: null,
        title: 'Wasserschaden Küche',
        tags: [1, 3],
        created: '2024-05-11',
        modified: '2024-05-11T20:00:00.000000+02:00',
        added: '2024-05-11T19:58:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: null,
        original_file_name: '../../../etc/passwd',
        mime_type: 'image/png',
        notes: [],
        custom_fields: [],
      },
      {
        id: 4,
        correspondent: 3,
        document_type: 3,
        title: 'Kontoauszug Februar 2024',
        tags: [4],
        created: '2024-02-29',
        modified: '2024-03-01T07:00:00.000000+01:00',
        added: '2024-03-01T06:59:00.000000+01:00',
        deleted_at: null,
        archive_serial_number: 1003,
        original_file_name: 'Kontoauszug.pdf',
        mime_type: 'application/pdf',
        notes: [],
        // The legacy monetary form: a bare decimal with no currency code at all.
        custom_fields: [{ field: 1, value: '123.45' }],
      },
      {
        id: 5,
        correspondent: 1,
        document_type: 1,
        title: 'Rechnung ohne Datei',
        tags: [],
        created: '2024-06-01',
        modified: '2024-06-01T12:00:00.000000+02:00',
        added: '2024-06-01T12:00:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: 1004,
        original_file_name: 'Weg.pdf',
        mime_type: 'application/pdf',
        notes: [],
        custom_fields: [{ field: 2, value: 'RE-2024-0099' }],
      },
      {
        id: 6,
        correspondent: 1,
        document_type: 1,
        title: 'Rechnung mit doppelter ASN',
        tags: [2],
        created: '2024-04-01',
        modified: '2024-04-02T12:00:00.000000+02:00',
        added: '2024-04-01T12:00:00.000000+02:00',
        deleted_at: null,
        // Already on document 1. Paperless enforces uniqueness, so this is a database that has been
        // edited behind its back — and `ux_item_office_asn` would fail the whole run if written.
        archive_serial_number: 1001,
        original_file_name: 'Doppelt.pdf',
        mime_type: 'application/pdf',
        notes: [],
        custom_fields: [],
      },
      {
        id: 7,
        correspondent: 3,
        document_type: null,
        title: 'Datei seit dem Einlesen geändert',
        tags: [],
        created: '2024-07-07',
        modified: '2024-07-08T12:00:00.000000+02:00',
        added: '2024-07-07T12:00:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: null,
        original_file_name: 'Geaendert.pdf',
        mime_type: 'application/pdf',
        notes: [],
        custom_fields: [],
      },
      {
        id: 8,
        correspondent: 1,
        document_type: null,
        title: 'Unbekannte Auswahl',
        tags: [3],
        created: '2024-08-01',
        modified: '2024-08-01T12:00:00.000000+02:00',
        added: '2024-08-01T12:00:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: null,
        original_file_name: 'Status.pdf',
        mime_type: 'application/pdf',
        notes: [],
        custom_fields: [
          { field: 5, value: 'zZzZ0000zZzZ0000' },
          { field: 13, value: 'irgendetwas' },
        ],
      },
      {
        id: 9,
        correspondent: 2,
        document_type: null,
        title: 'Verknüpfung ins Leere',
        tags: [],
        created: '2024-09-09',
        modified: '2024-09-09T12:00:00.000000+02:00',
        added: '2024-09-09T12:00:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: null,
        original_file_name: 'Verknuepfung.pdf',
        mime_type: 'application/pdf',
        notes: [],
        // 2 exists; 999 does not.
        custom_fields: [{ field: 6, value: [2, 999] }],
      },
      {
        id: 10,
        correspondent: 1,
        document_type: 1,
        title: 'Stadtwerke Rechnung März 2024 (Kopie)',
        tags: [2],
        created: '2024-03-01',
        modified: '2024-03-04T11:02:33.000000+01:00',
        added: '2024-10-01T09:00:00.000000+02:00',
        deleted_at: null,
        archive_serial_number: 1005,
        original_file_name: 'Stadtwerke_2024-03_Kopie.pdf',
        mime_type: 'application/pdf',
        notes: [],
        custom_fields: [{ field: 1, value: 'EUR89.90' }],
      },
    ],
  };
};

/** What a correct import of `fixtureLibrary()` produces. Asserted directly by the tests. */
export const FIXTURE_EXPECTATIONS = {
  documents: 10,
  /** Document 5's original is not served. */
  originalsStored: 9,
  originalsMissing: 1,
  /** Documents 1 and 10 share their bytes. */
  distinctDocuments: 8,
  checksumMismatches: 1,
  tags: 4,
  correspondents: 4,
  documentTypes: 4,
  /** Field 13 has a data type this importer does not know. */
  supportedCustomFields: 12,
  /** 1001 is on documents 1 and 6; 1002–1005 are on 2, 4, 5 and 10. */
  documentsWithAsn: 6,
  asnWrittenToFacet: 5,
  notes: 3,
} as const;
