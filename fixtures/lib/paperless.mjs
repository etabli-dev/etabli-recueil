/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `fixtures/paperless/` — a captured-shape Paperless-ngx API export, for CONCEPT §6: "API export of
 * documents, tags, correspondents, document types, custom fields, ASN + originals → Office facet."
 *
 * **What this fixture claims, and what it does not.** It reproduces the *shapes* Paperless-ngx 2.x
 * serialises — the `count`/`next`/`previous`/`all`/`results` envelope, the `matching_algorithm`
 * integers, `custom_fields` as `{value, field}` pairs, monetary values as `"EUR471.50"` strings,
 * `archive_serial_number`, `deleted_at`, the separate `/api/trash/` collection. It is written from
 * the documented API and is therefore a *model*, not a capture: nobody here has a Paperless instance
 * to record. The Phase 1 review's rule applies — a compatibility claim needs a captured fixture from
 * the real thing — so the honest statement is that this corpus proves the importer handles these
 * shapes, and does **not** prove they are the shapes a given Paperless build emits. Confirming that
 * needs one recorded session against the user's own instance before it is decommissioned, and
 * `paperless/index.json` records the version this was modelled on so the two can be compared.
 *
 * **The route table.** `index.json` maps method + path + query to a response, which is what lets a
 * test stand up an in-process fake and drive the real importer through the real HTTP client. No
 * container, no network, and the importer under test is not given a special code path.
 *
 * **The awkward cases**, in the same spirit as the Zotero fixture:
 *
 *   - Document 1007's original is **unfetchable**: `/api/documents/1007/download/` answers 500 and
 *     no file is shipped for it. The verification report must name it, and must arrive at that name
 *     by comparing the documents it fetched against the documents the dump lists — not by counting
 *     its own failure log.
 *   - Document 1008 is in the **trash**, so it is in `/api/trash/` and not in `/api/documents/`. An
 *     importer that reaches for the trash resurrects a document the user deleted.
 *   - Documents 1001 and 1009 have **byte-identical originals** — a re-scan filed twice. One
 *     Document, two Items.
 *   - Document 1010's `original_file_name` is `../../../../etc/paperless-pwn.pdf`. A filename in a
 *     manifest is hostile until it has been resolved and checked to be inside its root. The file
 *     shipped for it is named after its id, never after the field.
 *   - Document 1006 has no correspondent and no document type, and document 1003 has empty
 *     `content` — nothing has OCRed it yet, so ingestion must.
 *   - Correspondents 1 and 6 differ only in case and spacing, which is what
 *     `correspondent_normalised` exists for.
 *   - Document 1012 has a 303-character title and an `original_file_name` containing characters
 *     that are illegal in a Windows filename.
 */

/** The Paperless-ngx release these shapes are modelled on. */
export const PAPERLESS_VERSION = '2.14.7';
export const PAPERLESS_API_VERSION = 6;

const BASE_URL = 'http://paperless.invalid';
const PAGE_SIZE = 8;

/** Paperless's `MATCH_*` constants. 6 is `MATCH_AUTO`, the default; 4 is `MATCH_REGEX`. */
const MATCH_ANY = 1;
const MATCH_LITERAL = 3;
const MATCH_REGEX = 4;
const MATCH_AUTO = 6;

const TAGS = [
  { id: 1, name: 'Rechnung', colour: '#a6cee3', match: '', algorithm: MATCH_AUTO, documents: 3 },
  { id: 2, name: 'Vertrag', colour: '#1f78b4', match: '', algorithm: MATCH_AUTO, documents: 1 },
  {
    id: 3,
    name: 'Steuer',
    colour: '#b2df8a',
    match: 'finanzamt,steuerbescheid',
    algorithm: MATCH_ANY,
    documents: 1,
  },
  {
    id: 4,
    name: 'Posteingang',
    colour: '#ff7f00',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 2,
    inbox: true,
  },
  { id: 5, name: 'Gescannt', colour: '#cab2d6', match: '', algorithm: MATCH_AUTO, documents: 4 },
  { id: 6, name: 'Wichtig', colour: '#e31a1c', match: '', algorithm: MATCH_AUTO, documents: 2 },
  {
    id: 7,
    name: 'Storno',
    colour: '#fdbf6f',
    match: '\\bstorno(rechnung)?\\b',
    algorithm: MATCH_REGEX,
    documents: 0,
  },
  { id: 8, name: 'Behörde', colour: '#33a02c', match: '', algorithm: MATCH_AUTO, documents: 1 },
  { id: 9, name: 'Δεδομένα', colour: '#6a3d9a', match: '', algorithm: MATCH_AUTO, documents: 1 },
];

const CORRESPONDENTS = [
  {
    id: 1,
    name: 'Stadtwerke Ulm',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 4,
    last: '2023-04-04T06:30:11+02:00',
  },
  {
    id: 2,
    name: 'Buchhandlung Jastram',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 1,
    last: '2023-09-12T00:00:00+02:00',
  },
  {
    id: 3,
    name: 'Hausverwaltung Kessler GmbH',
    match: 'kessler',
    algorithm: MATCH_LITERAL,
    documents: 1,
    last: '2021-09-21T00:00:00+02:00',
  },
  {
    id: 4,
    name: 'Finanzamt Ulm',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 1,
    last: '2022-11-08T00:00:00+01:00',
  },
  {
    id: 5,
    name: 'Universität Ulm',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 2,
    last: '2023-03-13T00:00:00+01:00',
  },
  /* Differs from correspondent 1 only in case and in the run of spaces. Paperless allows it;
     `correspondent_normalised` in spec/data-model.md §3.7 is what has to notice. */
  {
    id: 6,
    name: 'stadtwerke  ulm',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 1,
    last: '2023-05-02T00:00:00+02:00',
  },
];

const DOCUMENT_TYPES = [
  { id: 1, name: 'Rechnung', match: '', algorithm: MATCH_AUTO, documents: 4 },
  { id: 2, name: 'Vertrag', match: '', algorithm: MATCH_AUTO, documents: 1 },
  /* Not in the closed vocabulary of `item_office.office_document_type`. §3.7 says the list is open
     and "the Paperless importer carries user-defined types across", so this is the one that proves
     it: an importer that maps onto the closed list and drops the rest loses this. */
  { id: 3, name: 'Bescheid', match: 'bescheid', algorithm: MATCH_LITERAL, documents: 1 },
  { id: 4, name: 'Beleg', match: '', algorithm: MATCH_AUTO, documents: 1 },
  { id: 5, name: 'Protokoll', match: '', algorithm: MATCH_AUTO, documents: 2 },
];

const STORAGE_PATHS = [
  {
    id: 1,
    name: 'Nach Jahr und Korrespondent',
    path: '{created_year}/{correspondent}',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 5,
  },
  {
    id: 2,
    name: 'Steuerunterlagen',
    path: 'steuer/{created_year}',
    match: '',
    algorithm: MATCH_AUTO,
    documents: 1,
  },
];

const CUSTOM_FIELDS = [
  { id: 1, name: 'Betrag', data_type: 'monetary', extra_data: { default_currency: 'EUR' } },
  { id: 2, name: 'Fälligkeit', data_type: 'date', extra_data: {} },
  { id: 3, name: 'Aktenzeichen', data_type: 'string', extra_data: {} },
  { id: 4, name: 'Geprüft', data_type: 'boolean', extra_data: {} },
  {
    id: 5,
    name: 'Kategorie',
    data_type: 'select',
    extra_data: {
      select_options: [
        { id: 'kNRq1sYb', label: 'privat' },
        { id: 'Zt7pW0ce', label: 'dienstlich' },
      ],
    },
  },
  { id: 6, name: 'Gehört zu', data_type: 'documentlink', extra_data: {} },
];

/**
 * The documents, in the order the API returns them (`-created`, newest first, is Paperless's
 * default; this dump is ordered by id so the pagination is easy to read).
 *
 * `asset` names the shared document in `assets.mjs` whose bytes the original is, or `generated`
 * for one built here. `fetchable: false` means the download route answers 500 and no file ships.
 */
const DOCUMENTS = [
  {
    id: 1001,
    title: 'Stromrechnung März 2023',
    correspondent: 1,
    document_type: 1,
    storage_path: 1,
    tags: [1, 5],
    asn: 42,
    created: '2023-03-14',
    added: '2023-03-16T20:04:11.612344+01:00',
    modified: '2023-03-16T20:05:02.118902+01:00',
    original_file_name: 'Rechnung_2023-004417.pdf',
    archived_file_name: '2023-03-14 Stadtwerke Ulm Rechnung.pdf',
    mime: 'application/pdf',
    pages: 1,
    asset: 'invoicePdf',
    content: [
      'Stadtwerke Ulm GmbH',
      'Karlstraße 1, 89073 Ulm',
      'RECHNUNG',
      'Rechnungsnummer: 2023-004417',
      'Kundennummer: 88-201934',
      'Rechnungsdatum: 14.03.2023',
      'Fällig am: 28.03.2023',
      'Gesamtbetrag 471,50 €',
    ].join('\n'),
    custom_fields: [
      { field: 1, value: 'EUR471.50' },
      { field: 2, value: '2023-03-28' },
      { field: 3, value: '2023-004417' },
      { field: 5, value: 'kNRq1sYb' },
    ],
  },
  {
    id: 1002,
    title: 'Mietvertrag Lagerraum Nr. 14',
    correspondent: 3,
    document_type: 2,
    storage_path: 1,
    tags: [2, 6],
    asn: 17,
    created: '2021-09-21',
    added: '2021-09-24T09:12:00.000000+02:00',
    modified: '2021-09-24T09:12:00.000000+02:00',
    original_file_name: 'Mietvertrag-Lagerraum-14.pdf',
    archived_file_name: '2021-09-21 Hausverwaltung Kessler GmbH Vertrag.pdf',
    mime: 'application/pdf',
    pages: 1,
    asset: 'contractPdf',
    content: 'Mietvertrag über einen Lagerraum\nMietzins: 62,00 € monatlich',
    custom_fields: [
      { field: 4, value: true },
      { field: 5, value: 'kNRq1sYb' },
    ],
  },
  {
    id: 1003,
    title: 'Beleg Buchhandlung Jastram',
    correspondent: 2,
    document_type: 4,
    storage_path: null,
    tags: [4],
    asn: null,
    created: '2023-09-12',
    added: '2023-09-13T07:41:29.004417+02:00',
    modified: '2023-09-13T07:41:29.004417+02:00',
    original_file_name: 'Beleg-2023-0912.png',
    archived_file_name: null,
    mime: 'image/png',
    /* Paperless leaves `page_count` null for images. */
    pages: null,
    asset: 'receiptPng',
    /* Nothing has read this yet. Ingestion has to. */
    content: '',
    custom_fields: [{ field: 1, value: 'EUR51.90' }],
  },
  {
    id: 1004,
    title: 'Protokoll der Sitzung vom 13. März 2023',
    correspondent: 5,
    document_type: 5,
    storage_path: 1,
    tags: [6],
    asn: 8,
    created: '2023-03-13',
    added: '2023-03-15T18:02:44.881000+01:00',
    modified: '2023-06-19T11:00:03.229100+02:00',
    original_file_name: 'Protokoll 2023-03-13.pdf',
    archived_file_name: '2023-03-13 Universität Ulm Protokoll.pdf',
    mime: 'application/pdf',
    pages: 2,
    asset: 'minutesPdf',
    content:
      'Arbeitskreis Gewässergüte — Protokoll\nSitzung vom 13. März 2023\nTOP 3 Beschaffung',
    custom_fields: [],
    notes: [
      {
        id: 3,
        note: 'Beschluss zu TOP 3 wurde in der Sitzung vom 19.06. aufgehoben.',
        created: '2023-06-19T11:00:03.229100+02:00',
        user: 1,
      },
    ],
  },
  {
    id: 1005,
    title: 'Einkommensteuerbescheid 2021',
    correspondent: 4,
    document_type: 3,
    storage_path: 2,
    tags: [3, 6, 8],
    asn: 101,
    created: '2022-11-08',
    added: '2022-11-14T19:33:07.400000+01:00',
    modified: '2022-11-14T19:33:07.400000+01:00',
    original_file_name: 'ESt-Bescheid-2021.pdf',
    archived_file_name: '2022-11-08 Finanzamt Ulm Bescheid.pdf',
    mime: 'application/pdf',
    pages: 3,
    asset: 'generated',
    generated: {
      title: 'Einkommensteuerbescheid 2021',
      lines: [
        'Finanzamt Ulm',
        '',
        'Bescheid für 2021 über Einkommensteuer',
        'Steuernummer 88/201/93456',
        '',
        'Festgesetzt wird ein Erstattungsbetrag von 1.240,00 EUR.',
        'Der Bescheid ergeht nach § 165 Abs. 1 Satz 2 AO teilweise vorläufig.',
      ],
      pages: 3,
    },
    content: 'Finanzamt Ulm\nBescheid für 2021 über Einkommensteuer\nErstattung 1.240,00 EUR',
    custom_fields: [
      /* Negative monetary values are a string with the sign after the currency code. */
      { field: 1, value: 'EUR-1240.00' },
      { field: 3, value: '88/201/93456' },
      { field: 6, value: [1002] },
    ],
  },
  {
    id: 1006,
    title: 'Unbekanntes Dokument',
    correspondent: null,
    document_type: null,
    storage_path: null,
    tags: [4, 5],
    asn: null,
    created: '2024-01-19',
    added: '2024-01-19T23:58:12.000000+01:00',
    modified: '2024-01-19T23:58:12.000000+01:00',
    original_file_name: 'scan_0041.pdf',
    archived_file_name: null,
    mime: 'application/pdf',
    pages: 1,
    asset: 'generated',
    generated: { title: 'scan_0041', lines: ['(unleserlicher Scan)'], pages: 1 },
    content: '',
    custom_fields: [],
  },
  {
    id: 1007,
    title: 'Kontoauszug 04/2023',
    correspondent: 1,
    document_type: null,
    storage_path: 1,
    tags: [5],
    asn: 55,
    created: '2023-05-02',
    added: '2023-05-04T08:15:00.000000+02:00',
    modified: '2023-05-04T08:15:00.000000+02:00',
    original_file_name: 'Kontoauszug-2023-04.pdf',
    archived_file_name: '2023-05-02 Stadtwerke Ulm.pdf',
    mime: 'application/pdf',
    pages: 2,
    /* The row is in the database; the file is not on the media volume. This is the failure a
       verification report exists for, and the only way to find it is to compare what was fetched
       against what the dump lists. */
    fetchable: false,
    content: 'Kontoauszug 04/2023',
    custom_fields: [],
  },
  {
    id: 1008,
    title: 'Doppelte Stromrechnung März 2023 (gelöscht)',
    correspondent: 6,
    document_type: 1,
    storage_path: null,
    tags: [1],
    asn: null,
    created: '2023-03-14',
    added: '2023-05-02T10:00:00.000000+02:00',
    modified: '2023-05-02T10:04:00.000000+02:00',
    deleted_at: '2023-05-02T10:04:00.000000+02:00',
    original_file_name: 'Rechnung_2023-004417 (1).pdf',
    archived_file_name: null,
    mime: 'application/pdf',
    pages: 1,
    asset: 'generated',
    generated: {
      title: 'Doppelte Stromrechnung (Papierkorb)',
      lines: [
        'Stadtwerke Ulm GmbH',
        'Rechnung 2023-004417 — versehentlich zweimal eingescannt.',
        'Dieses Dokument liegt im Papierkorb und darf nicht importiert werden.',
      ],
      pages: 1,
    },
    content: 'Rechnung 2023-004417',
    custom_fields: [],
    trashed: true,
  },
  {
    id: 1009,
    title: 'Stromrechnung März 2023 (Zweitscan)',
    correspondent: 1,
    document_type: 1,
    storage_path: 1,
    tags: [1, 5],
    asn: 43,
    created: '2023-03-14',
    added: '2023-04-02T13:22:47.000000+02:00',
    modified: '2023-04-02T13:22:47.000000+02:00',
    original_file_name: 'Rechnung_2023-004417_scan2.pdf',
    archived_file_name: '2023-03-14 Stadtwerke Ulm Rechnung_01.pdf',
    mime: 'application/pdf',
    pages: 1,
    /* Byte for byte the same file as 1001. */
    asset: 'invoicePdf',
    content: 'Stadtwerke Ulm GmbH\nRechnungsnummer: 2023-004417\nGesamtbetrag 471,50 €',
    custom_fields: [{ field: 1, value: 'EUR471.50' }],
  },
  {
    id: 1010,
    title: 'Anlage zum Bescheid',
    correspondent: 4,
    document_type: 3,
    storage_path: 2,
    tags: [3, 8],
    asn: 63,
    created: '2022-11-08',
    added: '2022-11-14T19:33:41.000000+01:00',
    modified: '2022-11-14T19:33:41.000000+01:00',
    /* Hostile. The file shipped for this document is named after its id; nothing in this repository
       is ever written to a path derived from this string. */
    original_file_name: '../../../../etc/paperless-pwn.pdf',
    archived_file_name: null,
    mime: 'application/pdf',
    pages: 1,
    asset: 'generated',
    generated: {
      title: 'Anlage zum Bescheid',
      lines: [
        'Anlage zum Einkommensteuerbescheid 2021',
        '',
        'Der Dateiname dieses Dokuments ist in der Paperless-Datenbank',
        'ein Pfadausbruch. Er darf niemals einen Ablageort bestimmen.',
      ],
      pages: 1,
    },
    content: 'Anlage zum Einkommensteuerbescheid 2021',
    custom_fields: [],
  },
  {
    id: 1011,
    title: 'Μελέτη υδρολογίας Αττικής',
    correspondent: 5,
    document_type: 5,
    storage_path: null,
    tags: [9],
    asn: null,
    created: '2020-06-30',
    added: '2020-07-02T11:15:00.000000+03:00',
    modified: '2020-07-02T11:15:00.000000+03:00',
    original_file_name: 'μελέτη-υδρολογίας.pdf',
    archived_file_name: null,
    mime: 'application/pdf',
    pages: 1,
    asset: 'generated',
    generated: {
      title: 'Meleti ydrologias Attikis',
      lines: [
        'Study of the hydrology of Attica (title and filename are Greek;',
        'the page itself is Latin because the fixture PDFs carry no',
        'embedded font).',
      ],
      pages: 1,
    },
    content: 'Μελέτη υδρολογίας Αττικής\nΕθνικό Μετσόβιο Πολυτεχνείο',
    custom_fields: [],
  },
  {
    id: 1012,
    title:
      'Vereinbarung über die gemeinsame Nutzung der Messstelle Sigmaringen zwischen der ' +
      'Landesanstalt für Umwelt Baden-Württemberg, dem Landratsamt Sigmaringen und der ' +
      'Universität Ulm, Institut für Geowissenschaften, geschlossen am 3. Februar 2020 und ' +
      'gültig bis zum Widerruf durch eine der beteiligten Stellen',
    correspondent: 5,
    document_type: 2,
    storage_path: null,
    tags: [2],
    asn: null,
    created: '2020-02-03',
    added: '2020-02-10T16:44:00.000000+01:00',
    modified: '2020-02-10T16:44:00.000000+01:00',
    /* Colons, an asterisk, a question mark and a trailing dot: none of these may appear in a
       Windows filename, and a trailing dot is silently stripped by the filesystem there. */
    original_file_name: 'Vereinbarung: Messstelle Sigmaringen *Entwurf?*.pdf.',
    archived_file_name: null,
    mime: 'application/pdf',
    pages: 1,
    asset: 'generated',
    generated: {
      title: 'Vereinbarung Messstelle Sigmaringen',
      lines: [
        'Vereinbarung über die gemeinsame Nutzung der Messstelle',
        'Sigmaringen, geschlossen am 3. Februar 2020.',
      ],
      pages: 1,
    },
    content: 'Vereinbarung über die gemeinsame Nutzung der Messstelle Sigmaringen',
    custom_fields: [],
  },
];

/**
 * Build the dump.
 *
 * @param {Record<string, Buffer>} assets  the shared documents, by name
 * @param {(spec: { title: string, lines: string[], pages: number }) => Buffer} generate
 *        builds the one-off PDFs; injected so this module does not depend on the PDF writer
 * @returns {{ files: Array<{ path: string, bytes: Buffer, note: string }>, summary: object }}
 */
export function buildPaperless(assets, generate) {
  /** @type {Array<{ path: string, bytes: Buffer, note: string }>} */
  const files = [];
  const add = (path, bytes, note) => files.push({ path, bytes, note });
  const json = (path, value, note) =>
    add(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), note);

  /* -- the originals ------------------------------------------------------------------------ */

  /** @type {Array<object>} */
  const originals = [];
  for (const document of DOCUMENTS) {
    if (document.fetchable === false) continue;
    const bytes =
      document.asset === 'generated' ? generate(document.generated) : assets[document.asset];
    if (!bytes) throw new Error(`document ${document.id} names no source for its original`);
    /* Named after the id, never after `original_file_name`. Document 1010's field is a path
       traversal, and a generator that derived the on-disk name from it would write outside the
       repository — which is the whole failure the fixture is warning about. */
    const path = `paperless/originals/${document.id}${extensionFor(document.mime)}`;
    add(path, bytes, `original of Paperless document ${document.id}`);
    originals.push({ id: document.id, path, bytes: bytes.length, mime: document.mime });
  }

  /* -- the API responses -------------------------------------------------------------------- */

  json(
    'paperless/api/status.json',
    {
      pngx_version: PAPERLESS_VERSION,
      server_os: 'Linux-6.8.0-generic-x86_64-with-glibc2.36',
      install_type: 'docker',
      storage: { total: 511123124224, available: 402118459392 },
      database: {
        type: 'postgresql',
        url: 'paperless',
        status: 'OK',
        error: null,
        migration_status: { latest_migration: '1061_alter_document_options', unapplied_migrations: [] },
      },
      tasks: {
        redis_url: 'redis://broker:6379',
        redis_status: 'OK',
        redis_error: null,
        celery_status: 'OK',
        index_status: 'OK',
        index_last_modified: '2024-01-19T23:58:20.000000+01:00',
        index_error: null,
        classifier_status: 'OK',
        classifier_error: null,
        classifier_last_trained: '2024-01-19T04:00:00.000000+01:00',
      },
    },
    'GET /api/status/ — the version the importer must record in its provenance',
  );

  json(
    'paperless/api/tags.json',
    envelope(
      TAGS.map((tag) => ({
        id: tag.id,
        slug: slug(tag.name),
        name: tag.name,
        colour: tag.colour,
        color: tag.colour,
        text_color: '#000000',
        match: tag.match,
        matching_algorithm: tag.algorithm,
        is_insensitive: true,
        is_inbox_tag: Boolean(tag.inbox),
        document_count: tag.documents,
        owner: 1,
        user_can_change: true,
      })),
    ),
    'GET /api/tags/ — note that Paperless serialises the colour twice, under both spellings',
  );

  json(
    'paperless/api/correspondents.json',
    envelope(
      CORRESPONDENTS.map((c) => ({
        id: c.id,
        slug: slug(c.name),
        name: c.name,
        match: c.match,
        matching_algorithm: c.algorithm,
        is_insensitive: true,
        document_count: c.documents,
        last_correspondence: c.last,
        owner: 1,
        user_can_change: true,
      })),
    ),
    'GET /api/correspondents/ — 1 and 6 differ only in case and spacing',
  );

  json(
    'paperless/api/document_types.json',
    envelope(
      DOCUMENT_TYPES.map((t) => ({
        id: t.id,
        slug: slug(t.name),
        name: t.name,
        match: t.match,
        matching_algorithm: t.algorithm,
        is_insensitive: true,
        document_count: t.documents,
        owner: 1,
        user_can_change: true,
      })),
    ),
    'GET /api/document_types/ — "Bescheid" is outside the Office facet vocabulary on purpose',
  );

  json(
    'paperless/api/storage_paths.json',
    envelope(
      STORAGE_PATHS.map((p) => ({
        id: p.id,
        slug: slug(p.name),
        name: p.name,
        path: p.path,
        match: p.match,
        matching_algorithm: p.algorithm,
        is_insensitive: true,
        document_count: p.documents,
        owner: 1,
        user_can_change: true,
      })),
    ),
    'GET /api/storage_paths/',
  );

  json(
    'paperless/api/custom_fields.json',
    envelope(
      CUSTOM_FIELDS.map((f) => ({
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        extra_data: { default_currency: null, select_options: null, ...f.extra_data },
        document_count: DOCUMENTS.filter((d) =>
          (d.custom_fields ?? []).some((v) => v.field === f.id),
        ).length,
      })),
    ),
    'GET /api/custom_fields/ — six data types including monetary, select and documentlink',
  );

  const live = DOCUMENTS.filter((d) => !d.trashed);
  const trashed = DOCUMENTS.filter((d) => d.trashed);
  const pages = [];
  for (let at = 0; at < live.length; at += PAGE_SIZE) pages.push(live.slice(at, at + PAGE_SIZE));

  pages.forEach((page, index) => {
    const number = index + 1;
    json(
      `paperless/api/documents-page-${number}.json`,
      {
        count: live.length,
        next:
          number < pages.length
            ? `${BASE_URL}/api/documents/?page=${number + 1}&page_size=${PAGE_SIZE}`
            : null,
        previous:
          number > 1
            ? `${BASE_URL}/api/documents/?page=${number - 1}&page_size=${PAGE_SIZE}`
            : null,
        all: live.map((d) => d.id),
        results: page.map(serialiseDocument),
      },
      `GET /api/documents/?page=${number} — ${page.length} of ${live.length}`,
    );
  });

  json(
    'paperless/api/trash.json',
    {
      count: trashed.length,
      next: null,
      previous: null,
      all: trashed.map((d) => d.id),
      results: trashed.map((d) => ({
        id: d.id,
        title: d.title,
        created: `${d.created}T00:00:00+01:00`,
        deleted_at: d.deleted_at,
        /* Paperless counts down to the day the trash is emptied. */
        remaining_days: 21,
      })),
    },
    'GET /api/trash/ — document 1008, which must not be imported',
  );

  json(
    'paperless/api/documents-1007-download-error.json',
    {
      detail:
        'Error occurred while retrieving the file. The source file may be missing from the media volume.',
    },
    'the body /api/documents/1007/download/ answers with, under HTTP 500',
  );

  /* -- the route table ---------------------------------------------------------------------- */

  /** @type {Array<object>} */
  const routes = [
    route('/api/status/', {}, 'api/status.json'),
    route('/api/tags/', { page: '1', page_size: '100' }, 'api/tags.json'),
    route('/api/correspondents/', { page: '1', page_size: '100' }, 'api/correspondents.json'),
    route('/api/document_types/', { page: '1', page_size: '100' }, 'api/document_types.json'),
    route('/api/storage_paths/', { page: '1', page_size: '100' }, 'api/storage_paths.json'),
    route('/api/custom_fields/', { page: '1', page_size: '100' }, 'api/custom_fields.json'),
    route('/api/trash/', { page: '1', page_size: '100' }, 'api/trash.json'),
  ];
  pages.forEach((_, index) => {
    routes.push(
      route(
        '/api/documents/',
        { page: String(index + 1), page_size: String(PAGE_SIZE) },
        `api/documents-page-${index + 1}.json`,
      ),
    );
  });
  for (const document of DOCUMENTS) {
    if (document.fetchable === false) {
      routes.push({
        method: 'GET',
        path: `/api/documents/${document.id}/download/`,
        query: {},
        status: 500,
        contentType: 'application/json',
        file: 'api/documents-1007-download-error.json',
        note: 'the deliberately unfetchable original',
      });
      continue;
    }
    routes.push({
      method: 'GET',
      path: `/api/documents/${document.id}/download/`,
      query: {},
      status: 200,
      contentType: document.mime,
      file: `originals/${document.id}${extensionFor(document.mime)}`,
      /* The name Paperless sets in Content-Disposition is the document's own, hostile or not. */
      contentDisposition: `attachment; filename="${document.original_file_name.replace(/"/g, '\\"')}"`,
    });
  }

  json(
    'paperless/index.json',
    {
      $schema: 'https://recueil.invalid/fixtures/paperless-route-table',
      description:
        'A route table over the files in this directory, so that a test can stand up an ' +
        'in-process fake Paperless-ngx and drive the real importer through the real HTTP client. ' +
        'Modelled on the documented Paperless-ngx API; see fixtures/README.md for what that does ' +
        'and does not prove.',
      baseUrl: BASE_URL,
      paperlessVersion: PAPERLESS_VERSION,
      apiVersion: PAPERLESS_API_VERSION,
      pageSize: PAGE_SIZE,
      defaultHeaders: {
        'x-version': PAPERLESS_VERSION,
        'x-api-version': String(PAPERLESS_API_VERSION),
      },
      routes,
    },
    'the route table a fake server serves this directory from',
  );

  return {
    files,
    summary: {
      paperlessVersion: PAPERLESS_VERSION,
      apiVersion: PAPERLESS_API_VERSION,
      pageSize: PAGE_SIZE,
      documents: {
        live: live.length,
        trashed: trashed.length,
        pages: pages.length,
        withAsn: live.filter((d) => d.asn !== null).length,
        withoutCorrespondent: live.filter((d) => d.correspondent === null).length,
        withoutDocumentType: live.filter((d) => d.document_type === null).length,
        withEmptyContent: live.filter((d) => d.content === '').length,
        withNotes: live.filter((d) => (d.notes ?? []).length > 0).length,
        longestTitle: Math.max(...live.map((d) => [...d.title].length)),
        unfetchable: DOCUMENTS.filter((d) => d.fetchable === false).map((d) => ({
          id: d.id,
          title: d.title,
          reason: 'download returns HTTP 500; the file is missing from the media volume',
        })),
        hostileFilenames: DOCUMENTS.filter((d) => /(^|[\\/])\.\.([\\/]|$)|^[\\/]/.test(d.original_file_name)).map(
          (d) => ({ id: d.id, originalFileName: d.original_file_name }),
        ),
      },
      tags: { total: TAGS.length, inbox: TAGS.filter((t) => t.inbox).length },
      correspondents: { total: CORRESPONDENTS.length },
      documentTypes: { total: DOCUMENT_TYPES.length },
      storagePaths: { total: STORAGE_PATHS.length },
      customFields: {
        total: CUSTOM_FIELDS.length,
        byDataType: CUSTOM_FIELDS.reduce(
          (counts, field) => ({ ...counts, [field.data_type]: (counts[field.data_type] ?? 0) + 1 }),
          {},
        ),
      },
      originals: { files: originals.length, contents: originals },
      routes: routes.length,
    },
  };
}

/** The Paperless list envelope. Every collection endpoint answers in this shape. */
function envelope(results) {
  return {
    count: results.length,
    next: null,
    previous: null,
    all: results.map((row) => row.id),
    results,
  };
}

function route(path, query, file) {
  return { method: 'GET', path, query, status: 200, contentType: 'application/json', file };
}

function serialiseDocument(document) {
  return {
    id: document.id,
    correspondent: document.correspondent,
    document_type: document.document_type,
    storage_path: document.storage_path,
    title: document.title,
    content: document.content,
    tags: document.tags,
    created: `${document.created}T00:00:00+01:00`,
    created_date: document.created,
    modified: document.modified,
    added: document.added,
    deleted_at: document.deleted_at ?? null,
    archive_serial_number: document.asn,
    original_file_name: document.original_file_name,
    archived_file_name: document.archived_file_name,
    owner: 1,
    user_can_change: true,
    is_shared_by_requester: false,
    notes: document.notes ?? [],
    custom_fields: document.custom_fields ?? [],
    page_count: document.pages,
    mime_type: document.mime,
  };
}

function extensionFor(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'image/png') return '.png';
  throw new Error(`no extension mapped for ${mime}`);
}

/**
 * Django's `slugify()`, which is what Paperless names its objects with: NFKD, drop the combining
 * marks, lower case, non-alphanumeric runs to hyphens, trim. It has no opinion about scripts it
 * cannot transliterate, so the Greek tag's slug is the empty string — which is what Paperless
 * stores and what an importer keying on the slug has to survive.
 */
function slug(name) {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
