/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The fixture library, as data.
 *
 * Nothing here is random and nothing is filler. Every record exists because it makes some part of
 * the Zotero importer's job harder, and `../../README.md` says which part. The builder
 * (`build.mjs`) refuses to write a record whose fields are not valid for its item type according to
 * Zotero's own global schema, so this file cannot drift into shapes Zotero would never produce.
 *
 * Conventions
 * -----------
 * - `slug` is the fixture's stable handle. Zotero keys are derived from it, so a test may hard-code
 *   a key and keep it across regenerations.
 * - `creators` entries are `{ type, last, first }` for a two-field name and `{ type, name }` for a
 *   single-field (institutional) name — Zotero's `creators.fieldMode` 0 and 1.
 * - `date` values go through `d()`, which writes Zotero's multipart form: a sortable
 *   `YYYY-MM-DD` prefix that Zotero computed, then the string the user actually typed.
 * - `tags` entries are `[name, type]` with type 0 manual, 1 automatic.
 */

import { multipartDate, LINK_MODE, ANNOTATION_TYPE, TAG_TYPE, PREDICATE } from './zotero-values.mjs';

const d = multipartDate;

/** The eight-character key Zotero puts in `settings` for a library that has never synced. */
export const LOCAL_USER_KEY = 'v3aG8nQf';

/** A group library the user once belonged to; only its URIs survive, in `itemRelations`. */
export const FORMER_GROUP_ID = 2417362;

/* ================================================================================================ */
/* Collections                                                                                      */
/* ================================================================================================ */

/**
 * Three levels deep, with a Greek name, an empty collection, an item filed in three collections at
 * once, and one collection in the trash.
 */
export const collections = [
  { slug: 'diss', name: 'Dissertation', parent: null },
  { slug: 'diss-k1', name: 'Kapitel 1 — Theorie', parent: 'diss' },
  { slug: 'diss-k2', name: 'Kapitel 2 — Methoden', parent: 'diss' },
  { slug: 'diss-k2-inst', name: 'Instrumente', parent: 'diss-k2' },
  { slug: 'theoria', name: 'Θεωρία', parent: null },
  { slug: 'reading', name: 'Reading list', parent: null },
  { slug: 'data-code', name: 'Datasets & code', parent: null },
  { slug: 'unsorted', name: 'Zu sortieren', parent: null },
  { slug: 'archiv', name: 'Archiv (aufgelöst)', parent: null, trashed: '2024-02-11T09:12:44Z' },
];

/* ================================================================================================ */
/* Items                                                                                            */
/* ================================================================================================ */

/**
 * The 67 regular items — everything that is not a note, an attachment or an annotation. Three of
 * them are in the trash, so a library view shows 64.
 *
 * @type {Array<object>}
 */
export const items = [
  /* ---- journalArticle (21, one trashed) ---------------------------------------------------- */
  {
    slug: 'ja-donau-niederschlag',
    type: 'journalArticle',
    added: '2019-09-02T07:41:19Z',
    modified: '2023-11-14T18:03:52Z',
    fields: {
      title: 'Niederschlagsvariabilität im Einzugsgebiet der oberen Donau, 1961–2015',
      publicationTitle: 'Hydrologie und Wasserbewirtschaftung',
      volume: '63',
      issue: '4',
      pages: '218–233',
      date: d('August 2019', { year: 2019, month: 8 }),
      DOI: '10.5675/HyWa_2019.4_2',
      ISSN: '1439-1783',
      language: 'de-DE',
      journalAbbreviation: 'HyWa',
      libraryCatalog: 'DOI.org (Crossref)',
      abstractNote:
        'Für 214 Niederschlagsstationen im Einzugsgebiet der oberen Donau werden Trends der ' +
        'Jahres- und Saisonsummen für den Zeitraum 1961–2015 bestimmt. Die Ergebnisse zeigen ' +
        'eine signifikante Zunahme der Winterniederschläge bei gleichzeitig abnehmender ' +
        'Sommerniederschlagsmenge im südlichen Teilgebiet.',
    },
    creators: [
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
      { type: 'author', last: 'van der Berg', first: 'Willem J.' },
      { type: 'author', last: 'Weiß', first: 'Jürgen' },
    ],
    tags: [
      ['Hydrologie', TAG_TYPE.manual],
      ['wichtig', TAG_TYPE.manual],
      ['Water Resources', TAG_TYPE.automatic],
      ['Precipitation', TAG_TYPE.automatic],
    ],
    collections: ['diss', 'diss-k1', 'theoria'],
  },
  {
    slug: 'ja-interop-jis',
    type: 'journalArticle',
    added: '2021-05-18T14:22:03Z',
    modified: '2021-05-18T14:22:03Z',
    fields: {
      title: 'Interoperability',
      publicationTitle: 'Journal of Information Science',
      volume: '47',
      issue: '2',
      pages: '155-170',
      date: d('2021', { year: 2021 }),
      DOI: '10.1177/0165551520917000',
      ISSN: '0165-5515',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Okonkwo', first: 'Chidinma' }],
    tags: [['to-read', TAG_TYPE.manual]],
    collections: ['reading'],
  },
  {
    slug: 'ja-interop-dap',
    type: 'journalArticle',
    added: '2019-01-30T11:07:55Z',
    modified: '2022-06-01T08:14:02Z',
    fields: {
      // Same title as ja-interop-jis, different authors, different journal, different year, and a
      // different DOI. A deduplicator that keys on the title alone merges two unrelated works.
      title: 'Interoperability',
      publicationTitle: 'Data & Policy',
      volume: '1',
      pages: 'e4',
      date: d('2018-11-06', { year: 2018, month: 11, day: 6 }),
      DOI: '10.1017/dap.2018.4',
      ISSN: '2632-3249',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Szűcs', first: 'Márton' },
      { type: 'author', last: 'Nováková', first: 'Petra' },
    ],
    tags: [['to-read', TAG_TYPE.manual]],
    collections: ['reading'],
  },
  {
    slug: 'ja-dedup-published',
    type: 'journalArticle',
    added: '2023-08-04T06:55:31Z',
    modified: '2024-03-19T20:41:07Z',
    fields: {
      title: 'Graph-based deduplication of bibliographic records at scale',
      publicationTitle: 'Journal of Data and Information Science',
      volume: '8',
      issue: '3',
      pages: '41-68',
      date: d('2023-08-01', { year: 2023, month: 8, day: 1 }),
      DOI: '10.2478/jdis-2023-0014',
      ISSN: '2096-157X',
      language: 'en',
      citationKey: 'bianchi2023graph',
      abstractNote:
        'We present a deduplication pipeline that treats a bibliographic corpus as a graph of ' +
        'candidate identities and resolves it with a constrained clustering step.',
    },
    creators: [
      { type: 'author', last: 'Bianchi', first: 'Lorenzo' },
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
    ],
    tags: [
      ['Deduplication', TAG_TYPE.automatic],
      ['wichtig', TAG_TYPE.manual],
    ],
    collections: ['diss-k2', 'data-code'],
  },
  {
    slug: 'ja-volga-ru',
    type: 'journalArticle',
    added: '2020-10-11T13:30:00Z',
    modified: '2020-10-11T13:30:00Z',
    fields: {
      title: 'Оценка качества поверхностных вод в бассейне Волги',
      publicationTitle: 'Водные ресурсы',
      volume: '47',
      issue: '3',
      pages: '312–325',
      date: d('2020', { year: 2020 }),
      language: 'ru',
      shortTitle: 'Оценка качества поверхностных вод',
    },
    creators: [
      { type: 'author', last: 'Иванова', first: 'Екатерина Сергеевна' },
      { type: 'author', last: 'Петров', first: 'Дмитрий Алексеевич' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['theoria'],
  },
  {
    slug: 'ja-athens-el',
    type: 'journalArticle',
    added: '2017-04-22T09:18:41Z',
    modified: '2019-02-03T15:00:12Z',
    fields: {
      title: 'Μελέτη της ατμοσφαιρικής ρύπανσης στο λεκανοπέδιο Αττικής',
      publicationTitle: 'Περιβάλλον και Επιστήμη',
      volume: '12',
      issue: '1',
      pages: '44–61',
      date: d('2017', { year: 2017 }),
      language: 'el',
    },
    creators: [
      { type: 'author', last: 'Παπαδόπουλος', first: 'Γεώργιος' },
      // Single-field creator, in Greek: fieldMode 1, lastName carries the whole name.
      { type: 'contributor', name: 'Ελληνική Στατιστική Αρχή' },
    ],
    tags: [['Δεδομένα', TAG_TYPE.manual]],
    collections: ['theoria'],
  },
  {
    slug: 'ja-paca-fr',
    type: 'journalArticle',
    added: '2016-11-08T16:44:20Z',
    modified: '2016-11-08T16:44:20Z',
    fields: {
      title: "L'évaluation des politiques publiques de l'eau en région Provence-Alpes-Côte d'Azur",
      publicationTitle: "Revue d'Économie Régionale & Urbaine",
      volume: '2016',
      issue: '3',
      pages: '507–534',
      date: d('2016', { year: 2016 }),
      DOI: '10.3917/reru.163.0507',
      language: 'fr',
      shortTitle: "L'évaluation des politiques publiques de l'eau",
    },
    creators: [
      { type: 'author', last: 'Lefèvre', first: 'Élodie' },
      { type: 'author', last: 'Chauveau', first: 'François-Xavier' },
    ],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'ja-long-title',
    type: 'journalArticle',
    added: '2022-02-14T10:02:00Z',
    modified: '2022-02-14T10:02:00Z',
    fields: {
      title:
        'A systematic comparison of distributed, semi-distributed and lumped rainfall–runoff ' +
        'model structures across 431 mesoscale catchments in central Europe, with particular ' +
        'attention to the treatment of snowmelt, soil-moisture accounting and the parameter ' +
        'identifiability problems that arise when calibration is restricted to a single ' +
        'streamflow gauge',
      shortTitle: 'A systematic comparison of rainfall–runoff model structures',
      publicationTitle: 'Hydrology and Earth System Sciences',
      volume: '26',
      issue: '2',
      pages: '389-417',
      date: d('2022-02-14', { year: 2022, month: 2, day: 14 }),
      DOI: '10.5194/hess-26-389-2022',
      ISSN: '1607-7938',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Ng', first: 'K. W.' },
      { type: 'author', last: 'Prasetyo', first: 'B.' },
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
    ],
    tags: [['Modellierung', TAG_TYPE.manual]],
    collections: ['diss-k2', 'diss-k2-inst'],
  },
  {
    slug: 'ja-editorial-nocreator',
    type: 'journalArticle',
    added: '2021-07-01T08:00:00Z',
    modified: '2021-07-01T08:00:00Z',
    fields: {
      // No creator at all — an unsigned editorial. Anything that assumes a first author breaks.
      title: 'Editorial: what counts as a reproducible workflow?',
      publicationTitle: 'Journal of Open Research Software',
      volume: '9',
      issue: '1',
      date: d('2021-07', { year: 2021, month: 7 }),
      DOI: '10.5334/jors.361',
      language: 'en',
    },
    creators: [],
    tags: [],
    collections: ['reading'],
  },
  {
    slug: 'ja-title-only',
    type: 'journalArticle',
    added: '2024-01-07T21:15:33Z',
    modified: '2024-01-07T21:15:33Z',
    fields: {
      // The record a user creates by hand and never finishes. One field, no creator, no date.
      title: 'Ein vorläufiger Titel',
    },
    creators: [],
    tags: [['to-read', TAG_TYPE.manual]],
    collections: [],
  },
  {
    slug: 'ja-extra-citekey',
    type: 'journalArticle',
    added: '2017-03-19T12:41:08Z',
    modified: '2023-05-02T07:22:15Z',
    fields: {
      title: 'Soil moisture memory in regional climate simulations over the Alpine foreland',
      publicationTitle: 'Climate Dynamics',
      volume: '48',
      issue: '9-10',
      pages: '3197-3215',
      date: d('2017-05', { year: 2017, month: 5 }),
      DOI: '10.1007/s00382-016-3260-y',
      ISSN: '1432-0894',
      language: 'en',
      // The pre-Zotero-8 way of pinning a citation key: a line in Extra. Two more lines that are
      // not citation keys sit around it, because that is what Extra actually looks like.
      extra: 'Citation Key: schmidt2017soil\nPMID: 28123456\ntex.keywords: soil moisture, memory',
    },
    creators: [
      { type: 'author', last: 'Schmidt', first: 'Hanna' },
      { type: 'author', last: 'Rossi', first: 'Giulia' },
    ],
    tags: [['Modellierung', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'ja-native-citekey',
    type: 'journalArticle',
    added: '2024-04-11T05:59:00Z',
    modified: '2024-04-11T05:59:00Z',
    fields: {
      title: 'Citation networks as evidence: a critical appraisal',
      publicationTitle: 'Quantitative Science Studies',
      volume: '5',
      issue: '1',
      pages: '112-140',
      date: d('2024', { year: 2024 }),
      DOI: '10.1162/qss_a_00281',
      language: 'en',
      // Zotero 8 and later store the citation key in a real field rather than in Extra.
      citationKey: 'bianchi2024networks',
    },
    creators: [{ type: 'author', last: 'Bianchi', first: 'Lorenzo' }],
    tags: [['Bibliometrie', TAG_TYPE.manual]],
    collections: ['reading'],
  },
  {
    slug: 'ja-conflicting-keys',
    type: 'journalArticle',
    added: '2020-06-23T19:04:47Z',
    modified: '2024-05-30T11:11:11Z',
    fields: {
      title: 'Trace elements as conservative tracers in karst aquifers',
      publicationTitle: 'Journal of Hydrology',
      volume: '588',
      pages: '125089',
      date: d('2020-09', { year: 2020, month: 9 }),
      DOI: '10.1016/j.jhydrol.2020.125089',
      language: 'en',
      // Three sources disagree about this item's citation key: the native field says one thing,
      // Extra says another, and better-bibtex.sqlite pins a third. The importer has to choose,
      // and the verification report has to say which it chose.
      citationKey: 'vasquez2020trace',
      extra: 'Citation Key: vasquez2020traceelements',
    },
    creators: [
      { type: 'author', last: 'Vásquez', first: 'María Fernanda' },
      { type: 'author', last: 'Ó Súilleabháin', first: 'Caoimhín' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'ja-braces-title',
    type: 'journalArticle',
    added: '2022-09-27T09:33:12Z',
    modified: '2022-09-27T09:33:12Z',
    fields: {
      // Acronyms and a chemical formula. On BibTeX export every one of them needs brace protection
      // or a style with title-casing will destroy it.
      title: 'The DNA of open infrastructure: SPARC, COAR and the CO2 cost of mirrors',
      publicationTitle: 'Insights',
      volume: '35',
      pages: '14',
      date: d('2022', { year: 2022 }),
      DOI: '10.1629/uksg.588',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Okonkwo', first: 'Chidinma' }],
    tags: [['Open Access', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'ja-endash-pages',
    type: 'journalArticle',
    added: '2018-12-05T17:28:00Z',
    modified: '2018-12-05T17:28:00Z',
    fields: {
      title: 'Uncertainty propagation in nutrient load estimation',
      publicationTitle: 'Environmental Modelling & Software',
      volume: '110',
      issue: 'S1',
      // An en dash, not a hyphen, in the page range — as Zotero stores what the publisher sent.
      pages: '1023–1041',
      date: d('December 2018', { year: 2018, month: 12 }),
      DOI: '10.1016/j.envsoft.2018.09.013',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Weiß', first: 'Jürgen' },
      { type: 'author', last: 'Nakamura', first: 'Hiroshi' },
    ],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'ja-accents-mixed',
    type: 'journalArticle',
    added: '2015-05-14T08:12:31Z',
    modified: '2015-05-14T08:12:31Z',
    fields: {
      title: 'Über die Bestimmung von Nährstoffflüssen in Fließgewässern',
      publicationTitle: 'Wasser und Abfall',
      volume: '17',
      issue: '6',
      pages: '30–35',
      date: d('2015', { year: 2015 }),
      language: 'de',
      abstractNote:
        'Die Bestimmung von Nährstoffflüssen setzt eine belastbare Abflussmessung voraus. ' +
        'Der Beitrag vergleicht drei Verfahren und diskutiert deren Unsicherheiten.',
    },
    creators: [
      { type: 'author', last: 'Weiß', first: 'Jürgen' },
      { type: 'author', last: 'Ó Súilleabháin', first: 'Caoimhín' },
      { type: 'author', last: 'Åkerlund', first: 'Ingrid' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'ja-same-lastname',
    type: 'journalArticle',
    added: '2019-08-19T22:41:00Z',
    modified: '2019-08-19T22:41:00Z',
    fields: {
      // Two authors who share a surname. Author disambiguation that keys on the surname collapses
      // them; a citation key formula that uses the surname alone produces a collision.
      title: 'Seasonal snow cover dynamics observed from Sentinel-2',
      publicationTitle: 'Remote Sensing of Environment',
      volume: '231',
      pages: '111254',
      date: d('2019', { year: 2019 }),
      DOI: '10.1016/j.rse.2019.111254',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Nakamura', first: 'Hiroshi' },
      { type: 'author', last: 'Nakamura', first: 'Haruki' },
    ],
    tags: [['Fernerkundung', TAG_TYPE.automatic]],
    collections: ['diss-k2-inst'],
  },
  {
    slug: 'ja-many-authors',
    type: 'journalArticle',
    added: '2023-01-25T13:07:44Z',
    modified: '2023-01-25T13:07:44Z',
    fields: {
      title: 'A community benchmark for large-sample hydrology',
      publicationTitle: 'Nature Water',
      volume: '1',
      pages: '77-89',
      date: d('2023-01', { year: 2023, month: 1 }),
      DOI: '10.1038/s44221-022-00013-0',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Addor', first: 'Nans' },
      { type: 'author', last: 'Bianchi', first: 'Lorenzo' },
      { type: 'author', last: 'Chauveau', first: 'François-Xavier' },
      { type: 'author', last: 'Dlamini', first: 'Nomsa' },
      { type: 'author', last: 'Eriksen', first: 'Sindre' },
      { type: 'author', last: 'Fujimoto', first: 'Kenji' },
      { type: 'author', last: 'Gonçalves', first: 'Rita' },
      { type: 'author', last: 'Haddad', first: 'Layla' },
      { type: 'author', last: 'Iversen', first: 'Tone' },
      { type: 'author', last: 'Jokinen', first: 'Ville' },
      { type: 'author', last: 'Kowalczyk', first: 'Agnieszka' },
      { type: 'author', last: 'Lefèvre', first: 'Élodie' },
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
      { type: 'author', last: 'van der Berg', first: 'Willem J.' },
    ],
    tags: [['Benchmark', TAG_TYPE.automatic]],
    collections: ['diss-k2'],
  },
  {
    slug: 'ja-date-range',
    type: 'journalArticle',
    added: '2021-11-30T07:00:00Z',
    modified: '2021-11-30T07:00:00Z',
    fields: {
      title: 'A multi-year field campaign in the Blautal karst system',
      publicationTitle: 'Hydrogeology Journal',
      volume: '29',
      pages: '2211-2229',
      // A date range, which has no single day. Zotero's parser takes the start for the sortable
      // prefix and keeps the range verbatim after it; only the verbatim part is the datum.
      date: d('2019–2021', { year: 2019 }),
      DOI: '10.1007/s10040-021-02384-2',
      language: 'en',
      // A multi-paragraph abstract: newlines survive in `itemDataValues`, and anything that pipes
      // this into a line-oriented format (RIS, BibTeX) has to decide what to do with them.
      abstractNote:
        'Between 2019 and 2021 a field campaign instrumented eleven karst springs in the ' +
        'Blautal.\n\nTracer tests, continuous electrical conductivity and event sampling were ' +
        'combined.\n\nThe results indicate two distinct flow systems with contrasting response ' +
        'times.',
    },
    creators: [
      { type: 'author', last: 'Vásquez', first: 'María Fernanda' },
      { type: 'author', last: 'Åkerlund', first: 'Ingrid' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k2', 'diss-k2-inst'],
  },
  {
    slug: 'ja-retracted',
    type: 'journalArticle',
    added: '2018-06-02T10:44:19Z',
    modified: '2022-10-08T14:55:03Z',
    retracted: true,
    fields: {
      title: 'Rapid assessment of aquifer recharge using a novel isotopic tracer',
      publicationTitle: 'Water Resources Research',
      volume: '54',
      issue: '7',
      pages: '4501-4519',
      date: d('July 2018', { year: 2018, month: 7 }),
      DOI: '10.1029/2018WR022785',
      language: 'en',
      extra: 'Retracted: 2022-09-14',
    },
    creators: [{ type: 'author', last: 'Prasetyo', first: 'Bagus' }],
    tags: [['zurückgezogen', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'ja-trashed-duplicate',
    type: 'journalArticle',
    added: '2021-05-18T14:23:44Z',
    modified: '2021-06-02T09:01:00Z',
    trashed: '2021-06-02T09:01:00Z',
    fields: {
      // A third copy of "Interoperability" that the user already binned. An importer that reads
      // `items` without excluding `deletedItems` resurrects it and reports 65 items, not 64.
      title: 'Interoperability',
      publicationTitle: 'Journal of Information Science',
      volume: '47',
      issue: '2',
      pages: '155-170',
      date: d('2021', { year: 2021 }),
      DOI: '10.1177/0165551520917000',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Okonkwo', first: 'Chidinma' }],
    tags: [['papierkorb-nur', TAG_TYPE.manual]],
    collections: [],
  },

  /* ---- book (9, one trashed) --------------------------------------------------------------- */
  {
    slug: 'bk-hydrologie-3',
    type: 'book',
    added: '2014-10-01T09:00:00Z',
    modified: '2019-01-12T11:20:00Z',
    fields: {
      title: 'Lehrbuch der Hydrologie',
      edition: '3. Auflage',
      publisher: 'Gebrüder Borntraeger',
      place: 'Stuttgart',
      date: d('2019', { year: 2019 }),
      numPages: '736',
      ISBN: '978-3-443-01067-6',
      language: 'de',
      libraryCatalog: 'K10plus ISBN',
      callNumber: 'GW 4000 B348(3)',
    },
    creators: [
      { type: 'author', last: 'Baumgartner', first: 'Albrecht' },
      { type: 'author', last: 'Liebscher', first: 'Hans-Jürgen' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'bk-hydrologie-4',
    type: 'book',
    added: '2024-03-02T16:31:10Z',
    modified: '2024-03-02T16:31:10Z',
    fields: {
      // The fourth edition of bk-hydrologie-3: same title, same authors, different year, different
      // ISBN. Two versions of one work, related in `itemRelations`, and not a duplicate.
      title: 'Lehrbuch der Hydrologie',
      edition: '4., überarbeitete Auflage',
      publisher: 'Gebrüder Borntraeger',
      place: 'Stuttgart',
      date: d('2024', { year: 2024 }),
      numPages: '812',
      ISBN: '978-3-443-01099-7',
      language: 'de',
    },
    creators: [
      { type: 'author', last: 'Baumgartner', first: 'Albrecht' },
      { type: 'author', last: 'Liebscher', first: 'Hans-Jürgen' },
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'bk-access-principle',
    type: 'book',
    added: '2013-02-19T20:05:00Z',
    modified: '2013-02-19T20:05:00Z',
    fields: {
      title: 'The Access Principle: The Case for Open Access to Research and Scholarship',
      shortTitle: 'The Access Principle',
      publisher: 'MIT Press',
      place: 'Cambridge, MA',
      date: d('2006', { year: 2006 }),
      ISBN: '978-0-262-23242-5',
      series: 'Digital Libraries and Electronic Publishing',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Willinsky', first: 'John' }],
    tags: [['Open Access', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'bk-edited-volume',
    type: 'book',
    added: '2020-11-23T07:47:00Z',
    modified: '2020-11-23T07:47:00Z',
    fields: {
      // Editors only, no author. A BibTeX exporter must emit @book with `editor` and no `author`,
      // and a citation key formula that reaches for the first author finds nothing.
      title: 'Handbuch Digitale Geisteswissenschaften',
      publisher: 'De Gruyter',
      place: 'Berlin',
      date: d('2020', { year: 2020 }),
      ISBN: '978-3-11-054356-7',
      language: 'de',
    },
    creators: [
      { type: 'editor', last: 'Schöch', first: 'Christof' },
      { type: 'editor', last: 'Jannidis', first: 'Fotis' },
    ],
    tags: [['Digital Humanities', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'bk-unesco-wwdr',
    type: 'book',
    added: '2021-03-22T06:00:00Z',
    modified: '2021-03-22T06:00:00Z',
    fields: {
      title: 'The United Nations World Water Development Report 2021: Valuing Water',
      shortTitle: 'The United Nations World Water Development Report 2021',
      publisher: 'UNESCO',
      place: 'Paris',
      date: d('2021', { year: 2021 }),
      ISBN: '978-92-3-100434-6',
      url: 'https://unesdoc.unesco.org/ark:/48223/pf0000375724',
      language: 'en',
    },
    // A single-field institutional creator: fieldMode 1, no first name at all.
    creators: [{ type: 'author', name: 'UNESCO' }],
    tags: [['Water Resources', TAG_TYPE.automatic]],
    collections: ['diss-k1'],
  },
  {
    slug: 'bk-translated',
    type: 'book',
    added: '2012-09-30T18:22:00Z',
    modified: '2018-04-04T10:10:10Z',
    fields: {
      title: 'Le Deuxième Sexe',
      publisher: 'Gallimard',
      place: 'Paris',
      date: d('1949', { year: 1949 }),
      numberOfVolumes: '2',
      language: 'fr',
      ISBN: '978-2-07-020513-5',
    },
    creators: [
      { type: 'author', last: 'de Beauvoir', first: 'Simone' },
      { type: 'translator', last: 'Parshley', first: 'H. M.' },
    ],
    tags: [],
    collections: [],
  },
  {
    slug: 'bk-usgs-methods',
    type: 'book',
    added: '2020-05-06T12:00:00Z',
    modified: '2020-05-06T12:00:00Z',
    fields: {
      title: 'Statistical Methods in Water Resources',
      series: 'Techniques and Methods',
      seriesNumber: '4-A3',
      publisher: 'U.S. Geological Survey',
      place: 'Reston, VA',
      date: d('2020', { year: 2020 }),
      DOI: '10.3133/tm4a3',
      numPages: '458',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Helsel', first: 'Dennis R.' },
      { type: 'author', last: 'Hirsch', first: 'Robert M.' },
      { type: 'seriesEditor', name: 'U.S. Geological Survey' },
    ],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: ['diss-k2', 'diss-k2-inst'],
  },
  {
    slug: 'bk-duden',
    type: 'book',
    added: '2020-08-30T14:14:14Z',
    modified: '2020-08-30T14:14:14Z',
    fields: {
      // No creator: a reference work filed under its title.
      title: 'Duden — Die deutsche Rechtschreibung',
      edition: '28., völlig neu bearbeitete und erweiterte Auflage',
      publisher: 'Dudenverlag',
      place: 'Berlin',
      date: d('2020', { year: 2020 }),
      ISBN: '978-3-411-04018-6',
      language: 'de',
    },
    creators: [],
    tags: [],
    collections: [],
  },
  {
    slug: 'bk-trashed-draft',
    type: 'book',
    added: '2023-04-18T08:08:08Z',
    modified: '2023-09-01T12:00:00Z',
    trashed: '2023-09-01T12:00:00Z',
    fields: {
      title: 'Entwurf: Methodenband (nicht erschienen)',
      publisher: 'unveröffentlicht',
      date: d('2023', { year: 2023 }),
      language: 'de',
    },
    creators: [{ type: 'author', last: 'Müller', first: 'Anna-Lena' }],
    tags: [],
    collections: [],
  },

  /* ---- bookSection (7) --------------------------------------------------------------------- */
  {
    slug: 'bs-alpine-modellierung',
    type: 'bookSection',
    added: '2019-01-20T09:41:00Z',
    modified: '2019-01-20T09:41:00Z',
    fields: {
      title: 'Wasserhaushaltsmodellierung im alpinen Raum',
      // `bookTitle` is the type-specific name for the base field `publicationTitle`. An importer
      // that reads base fields only, or type-specific fields only, loses one or the other.
      bookTitle: 'Lehrbuch der Hydrologie',
      edition: '3. Auflage',
      publisher: 'Gebrüder Borntraeger',
      place: 'Stuttgart',
      date: d('2019', { year: 2019 }),
      pages: '412–458',
      ISBN: '978-3-443-01067-6',
      language: 'de',
    },
    creators: [
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
      { type: 'bookAuthor', last: 'Baumgartner', first: 'Albrecht' },
    ],
    tags: [['Modellierung', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'bs-greek-history',
    type: 'bookSection',
    added: '2018-03-11T11:11:00Z',
    modified: '2018-03-11T11:11:00Z',
    fields: {
      title: 'Η ιστορία της υδρολογίας στην Ελλάδα',
      bookTitle: 'Υδρολογία και Κοινωνία',
      publisher: 'Πανεπιστημιακές Εκδόσεις Κρήτης',
      place: 'Ηράκλειο',
      date: d('2018', { year: 2018 }),
      pages: '17–52',
      language: 'el',
    },
    creators: [
      { type: 'author', last: 'Παπαδόπουλος', first: 'Γεώργιος' },
      { type: 'editor', last: 'Δημητρίου', first: 'Ελένη' },
    ],
    tags: [['Δεδομένα', TAG_TYPE.manual]],
    collections: ['theoria'],
  },
  {
    slug: 'bs-particle-editor',
    type: 'bookSection',
    added: '2021-10-04T15:15:15Z',
    modified: '2021-10-04T15:15:15Z',
    fields: {
      title: 'Provenance models for research data',
      bookTitle: 'Handbook of Research Data Management',
      publisher: 'Springer',
      place: 'Cham',
      date: d('2021', { year: 2021 }),
      pages: '203-228',
      ISBN: '978-3-030-73543-4',
      DOI: '10.1007/978-3-030-73544-1_9',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Dlamini', first: 'Nomsa' },
      // A surname with a particle, in the editor slot. `van der Berg, Willem J.` must not become
      // `Berg, Willem J. van der` and must not become `Willem J. van der Berg` in a sort key.
      { type: 'editor', last: 'van der Berg', first: 'Willem J.' },
    ],
    tags: [['Datenmanagement', TAG_TYPE.automatic]],
    collections: ['data-code'],
  },
  {
    slug: 'bs-no-pages',
    type: 'bookSection',
    added: '2022-05-19T13:00:00Z',
    modified: '2022-05-19T13:00:00Z',
    fields: {
      title: 'Open infrastructure and the commons',
      bookTitle: 'Reassembling Scholarly Communications',
      publisher: 'MIT Press',
      place: 'Cambridge, MA',
      date: d('2020', { year: 2020 }),
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Okonkwo', first: 'Chidinma' }],
    tags: [['Open Access', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'bs-multi-volume',
    type: 'bookSection',
    added: '2016-07-07T07:07:07Z',
    modified: '2016-07-07T07:07:07Z',
    fields: {
      title: 'Grundwasserneubildung',
      bookTitle: 'Handbuch der Wasserwirtschaft',
      volume: '2',
      numberOfVolumes: '4',
      series: 'Wasserwirtschaftliche Grundlagen',
      seriesNumber: 'II',
      publisher: 'Springer Vieweg',
      place: 'Wiesbaden',
      date: d('2016', { year: 2016 }),
      pages: '89–134',
      language: 'de',
    },
    creators: [
      { type: 'author', last: 'Weiß', first: 'Jürgen' },
      { type: 'seriesEditor', last: 'Liebscher', first: 'Hans-Jürgen' },
    ],
    tags: [],
    collections: ['diss-k1'],
  },
  {
    slug: 'bs-encyclopedia-like',
    type: 'bookSection',
    added: '2015-12-01T10:00:00Z',
    modified: '2015-12-01T10:00:00Z',
    fields: {
      title: 'Évapotranspiration',
      bookTitle: 'Dictionnaire de l’environnement',
      publisher: 'Éditions Techniques',
      place: 'Paris',
      date: d('2015', { year: 2015 }),
      pages: '331–334',
      language: 'fr',
    },
    creators: [{ type: 'author', last: 'Lefèvre', first: 'Élodie' }],
    tags: [],
    collections: [],
  },
  {
    slug: 'bs-translator-chain',
    type: 'bookSection',
    added: '2017-09-13T09:09:09Z',
    modified: '2017-09-13T09:09:09Z',
    fields: {
      title: 'О методах гидрологического районирования',
      bookTitle: 'Гидрология суши: избранные труды',
      publisher: 'Наука',
      place: 'Москва',
      date: d('2017', { year: 2017 }),
      pages: '75–98',
      language: 'ru',
    },
    creators: [
      { type: 'author', last: 'Иванова', first: 'Екатерина Сергеевна' },
      { type: 'translator', last: 'Kowalczyk', first: 'Agnieszka' },
      { type: 'editor', name: 'Институт водных проблем РАН' },
    ],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['theoria'],
  },

  /* ---- thesis (5) -------------------------------------------------------------------------- */
  {
    slug: 'th-diss-ulm',
    type: 'thesis',
    added: '2022-12-15T10:30:00Z',
    modified: '2023-02-01T08:00:00Z',
    fields: {
      title:
        'Modellgestützte Analyse des Niederschlag-Abfluss-Verhaltens kleiner Einzugsgebiete ' +
        'in Süddeutschland',
      shortTitle: 'Modellgestützte Analyse des Niederschlag-Abfluss-Verhaltens',
      // `thesisType` maps to the base field `type`; `university` maps to `publisher`.
      thesisType: 'Dissertation',
      university: 'Universität Ulm',
      place: 'Ulm',
      date: d('2022', { year: 2022 }),
      numPages: '214',
      language: 'de',
      url: 'https://oparu.uni-ulm.de/handle/123456789/45678',
    },
    creators: [{ type: 'author', last: 'Müller', first: 'Anna-Lena' }],
    tags: [
      ['Hydrologie', TAG_TYPE.manual],
      ['wichtig', TAG_TYPE.manual],
    ],
    collections: ['diss', 'diss-k2'],
  },
  {
    slug: 'th-master-fr',
    type: 'thesis',
    added: '2018-10-02T14:44:00Z',
    modified: '2018-10-02T14:44:00Z',
    fields: {
      title: "La gestion intégrée des ressources en eau dans le bassin de l'Hérault",
      thesisType: 'Mémoire de master',
      university: 'Université de Montpellier',
      place: 'Montpellier',
      date: d('2018', { year: 2018 }),
      numPages: '96',
      language: 'fr',
    },
    creators: [{ type: 'author', last: 'Chauveau', first: 'François-Xavier' }],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'th-phd-msu',
    type: 'thesis',
    added: '2015-06-18T09:00:00Z',
    modified: '2015-06-18T09:00:00Z',
    fields: {
      title: 'Гидрологический режим малых рек Поволжья в условиях изменения климата',
      thesisType: 'Кандидатская диссертация',
      university: 'Московский государственный университет имени М. В. Ломоносова',
      place: 'Москва',
      date: d('2015', { year: 2015 }),
      language: 'ru',
    },
    creators: [{ type: 'author', last: 'Петров', first: 'Дмитрий Алексеевич' }],
    tags: [],
    collections: ['theoria'],
  },
  {
    slug: 'th-no-university',
    type: 'thesis',
    added: '2021-01-11T11:11:11Z',
    modified: '2021-01-11T11:11:11Z',
    fields: {
      // No `university`, which means no `publisher` after base-field mapping. A BibTeX @phdthesis
      // without a `school` is invalid; the exporter has to decide what to do and the verification
      // report has to say so.
      title: 'Estimating groundwater recharge from satellite gravimetry',
      thesisType: 'PhD thesis',
      date: d('2021', { year: 2021 }),
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Haddad', first: 'Layla' }],
    tags: [['to-read', TAG_TYPE.manual]],
    collections: [],
  },
  {
    slug: 'th-habil',
    type: 'thesis',
    added: '2013-11-05T16:00:00Z',
    modified: '2013-11-05T16:00:00Z',
    fields: {
      title: 'Skalenübergreifende Prozessbeschreibung in der Einzugsgebietshydrologie',
      thesisType: 'Habilitationsschrift',
      university: 'Albert-Ludwigs-Universität Freiburg',
      place: 'Freiburg im Breisgau',
      date: d('2013', { year: 2013 }),
      numPages: '278',
      language: 'de',
    },
    creators: [{ type: 'author', last: 'Baumgartner', first: 'Albrecht' }],
    tags: [],
    collections: ['diss-k1'],
  },

  /* ---- report (6) -------------------------------------------------------------------------- */
  {
    slug: 'rp-ipcc-ar6',
    type: 'report',
    added: '2021-08-10T06:30:00Z',
    modified: '2021-08-10T06:30:00Z',
    fields: {
      title:
        'Climate Change 2021: The Physical Science Basis. Contribution of Working Group I to ' +
        'the Sixth Assessment Report of the Intergovernmental Panel on Climate Change',
      shortTitle: 'Climate Change 2021: The Physical Science Basis',
      // `institution` maps to `publisher`, `reportType` to `type`, `reportNumber` to `number`.
      institution: 'Cambridge University Press',
      reportType: 'Assessment Report',
      place: 'Cambridge',
      date: d('2021', { year: 2021 }),
      DOI: '10.1017/9781009157896',
      language: 'en',
      url: 'https://www.ipcc.ch/report/ar6/wg1/',
    },
    creators: [{ type: 'author', name: 'Intergovernmental Panel on Climate Change' }],
    tags: [
      ['Klimawandel', TAG_TYPE.automatic],
      ['wichtig', TAG_TYPE.manual],
    ],
    collections: ['diss-k1', 'reading'],
  },
  {
    slug: 'rp-lubw',
    type: 'report',
    added: '2019-04-09T08:15:00Z',
    modified: '2019-04-09T08:15:00Z',
    fields: {
      title: 'Grundwasserüberwachungsprogramm: Ergebnisse der Beprobung 2018',
      institution: 'Landesanstalt für Umwelt Baden-Württemberg',
      reportType: 'Fachbericht',
      reportNumber: 'LUBW-2019-04',
      place: 'Karlsruhe',
      date: d('2019-04', { year: 2019, month: 4 }),
      pages: '112',
      language: 'de',
    },
    creators: [{ type: 'author', name: 'Landesanstalt für Umwelt Baden-Württemberg' }],
    tags: [['Hydrologie', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'rp-jahresbericht',
    type: 'report',
    added: '2023-03-01T09:00:00Z',
    modified: '2023-03-01T09:00:00Z',
    fields: {
      // No creator, no report number, no place: a grey-literature record scraped from a PDF.
      title: 'Jahresbericht 2022',
      reportType: 'Jahresbericht',
      date: d('2023', { year: 2023 }),
      language: 'de',
    },
    creators: [],
    tags: [],
    collections: [],
  },
  {
    slug: 'rp-eea',
    type: 'report',
    added: '2022-07-14T10:00:00Z',
    modified: '2022-07-14T10:00:00Z',
    fields: {
      title: 'Water resources across Europe — confronting water stress: an updated assessment',
      institution: 'European Environment Agency',
      reportType: 'EEA Report',
      reportNumber: '12/2021',
      place: 'Copenhagen',
      date: d('2021-11-15', { year: 2021, month: 11, day: 15 }),
      ISBN: '978-92-9480-411-2',
      language: 'en',
      url: 'https://www.eea.europa.eu/publications/water-resources-across-europe-confronting',
      accessDate: '2022-07-14 09:58:12',
    },
    creators: [{ type: 'author', name: 'European Environment Agency' }],
    tags: [['Water Resources', TAG_TYPE.automatic]],
    collections: ['diss-k1'],
  },
  {
    slug: 'rp-technical-note',
    type: 'report',
    added: '2020-02-28T12:12:12Z',
    modified: '2020-02-28T12:12:12Z',
    fields: {
      title: 'Calibration of tipping-bucket rain gauges under low-intensity rainfall',
      institution: 'Deutscher Wetterdienst',
      reportType: 'Technical Note',
      reportNumber: 'TN-2020-03',
      place: 'Offenbach am Main',
      date: d('2020', { year: 2020 }),
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Eriksen', first: 'Sindre' },
      { type: 'contributor', last: 'Jokinen', first: 'Ville' },
    ],
    tags: [['Instrumente', TAG_TYPE.manual]],
    collections: ['diss-k2-inst'],
  },
  {
    slug: 'rp-oecd-fr',
    type: 'report',
    added: '2017-11-30T15:30:00Z',
    modified: '2017-11-30T15:30:00Z',
    fields: {
      title: "Gestion des risques liés à l'eau : investir dans la résilience",
      institution: 'Éditions OCDE',
      reportType: 'Études de l’OCDE sur l’eau',
      place: 'Paris',
      date: d('2017', { year: 2017 }),
      DOI: '10.1787/9789264280656-fr',
      language: 'fr',
    },
    creators: [{ type: 'author', name: 'OCDE' }],
    tags: [],
    collections: [],
  },

  /* ---- preprint (6) ------------------------------------------------------------------------ */
  {
    slug: 'pp-dedup-preprint',
    type: 'preprint',
    added: '2022-11-09T19:20:00Z',
    modified: '2023-08-04T06:56:02Z',
    fields: {
      // The preprint of ja-dedup-published. Same title, same authors, earlier date, different
      // identifier. Related, not duplicate.
      title: 'Graph-based deduplication of bibliographic records at scale',
      // `repository` maps to `publisher`, `archiveID` to `number`, `genre` to `type`.
      repository: 'arXiv',
      archiveID: 'arXiv:2211.04512',
      genre: 'Preprint',
      date: d('2022-11-08', { year: 2022, month: 11, day: 8 }),
      DOI: '10.48550/arXiv.2211.04512',
      url: 'https://arxiv.org/abs/2211.04512',
      language: 'en',
      abstractNote:
        'We present a deduplication pipeline that treats a bibliographic corpus as a graph of ' +
        'candidate identities and resolves it with a constrained clustering step.',
    },
    creators: [
      { type: 'author', last: 'Bianchi', first: 'Lorenzo' },
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
    ],
    tags: [['Deduplication', TAG_TYPE.automatic]],
    collections: ['diss-k2', 'data-code'],
  },
  {
    slug: 'pp-biorxiv',
    type: 'preprint',
    added: '2023-05-21T08:00:00Z',
    modified: '2023-05-21T08:00:00Z',
    fields: {
      title: 'Microbial community turnover along a headwater stream continuum',
      repository: 'bioRxiv',
      archiveID: '2023.05.19.541472',
      genre: 'Preprint',
      date: d('2023-05-19', { year: 2023, month: 5, day: 19 }),
      DOI: '10.1101/2023.05.19.541472',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Gonçalves', first: 'Rita' },
      { type: 'author', last: 'Fujimoto', first: 'Kenji' },
    ],
    tags: [['Ökologie', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'pp-eartharxiv-de',
    type: 'preprint',
    added: '2024-02-06T11:45:00Z',
    modified: '2024-02-06T11:45:00Z',
    fields: {
      title: 'Zur Übertragbarkeit hydrologischer Modellparameter zwischen Einzugsgebieten',
      repository: 'EarthArXiv',
      archiveID: 'X5RH2M',
      genre: 'Preprint',
      date: d('2024-02-05', { year: 2024, month: 2, day: 5 }),
      DOI: '10.31223/X5RH2M',
      language: 'de',
    },
    creators: [
      { type: 'author', last: 'Müller', first: 'Anna-Lena' },
      { type: 'author', last: 'Weiß', first: 'Jürgen' },
    ],
    tags: [['Modellierung', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'pp-ssrn',
    type: 'preprint',
    added: '2021-09-15T13:13:13Z',
    modified: '2021-09-15T13:13:13Z',
    fields: {
      title: 'Water pricing and household demand elasticity: evidence from a natural experiment',
      repository: 'SSRN',
      archiveID: '3921004',
      genre: 'Working Paper',
      date: d('2021-09', { year: 2021, month: 9 }),
      url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3921004',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Kowalczyk', first: 'Agnieszka' }],
    tags: [],
    collections: [],
  },
  {
    slug: 'pp-osf-nodoi',
    type: 'preprint',
    added: '2022-04-01T07:07:00Z',
    modified: '2022-04-01T07:07:00Z',
    fields: {
      // No DOI, no archiveID: identifier resolution has nothing to work with but the URL.
      title: 'Preregistration in hydrological modelling: a proposal',
      repository: 'OSF Preprints',
      genre: 'Preprint',
      date: d('n.d.'),
      url: 'https://osf.io/preprints/xk4qm',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Iversen', first: 'Tone' }],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: ['diss-k2'],
  },
  {
    slug: 'pp-zenodo',
    type: 'preprint',
    added: '2020-12-24T18:00:00Z',
    modified: '2020-12-24T18:00:00Z',
    fields: {
      title: 'Αξιολόγηση μεθόδων παρεμβολής βροχόπτωσης σε ορεινές λεκάνες',
      repository: 'Zenodo',
      genre: 'Preprint',
      date: d('2020-12-24', { year: 2020, month: 12, day: 24 }),
      DOI: '10.5281/zenodo.4383299',
      language: 'el',
    },
    creators: [{ type: 'author', last: 'Δημητρίου', first: 'Ελένη' }],
    tags: [['Δεδομένα', TAG_TYPE.manual]],
    collections: ['theoria'],
  },

  /* ---- webpage (7, one trashed) ------------------------------------------------------------ */
  {
    slug: 'wp-nationale-wasserstrategie',
    type: 'webpage',
    added: '2023-03-16T09:20:00Z',
    modified: '2023-03-16T09:20:00Z',
    fields: {
      title: 'Nationale Wasserstrategie',
      // `websiteTitle` maps to `publicationTitle`, `websiteType` to `type`.
      websiteTitle: 'Bundesministerium für Umwelt, Naturschutz, nukleare Sicherheit und Verbraucherschutz',
      websiteType: 'Behördenseite',
      url: 'https://www.bmuv.de/themen/wasser-ressourcen-abfall/nationale-wasserstrategie',
      accessDate: '2023-03-16 09:19:41',
      date: d('2023-03-15', { year: 2023, month: 3, day: 15 }),
      language: 'de',
    },
    creators: [],
    tags: [['Politik', TAG_TYPE.manual]],
    collections: ['diss-k1'],
  },
  {
    slug: 'wp-blog-fr',
    type: 'webpage',
    added: '2021-06-08T20:00:00Z',
    modified: '2021-06-08T20:00:00Z',
    fields: {
      title: "Pourquoi l'open access n'est pas qu'une question de coûts",
      websiteTitle: 'Carnet de recherche « Sciences ouvertes »',
      websiteType: 'Blog',
      url: 'https://sciencesouvertes.hypotheses.org/1234',
      accessDate: '2021-06-08 19:58:03',
      date: d('8 juin 2021', { year: 2021, month: 6, day: 8 }),
      language: 'fr',
    },
    creators: [{ type: 'author', last: 'Lefèvre', first: 'Élodie' }],
    tags: [['Open Access', TAG_TYPE.automatic]],
    collections: ['reading'],
  },
  {
    slug: 'wp-no-creator',
    type: 'webpage',
    added: '2019-11-02T11:00:00Z',
    modified: '2019-11-02T11:00:00Z',
    fields: {
      title: 'Pegelstände und Abflüsse in Baden-Württemberg',
      websiteTitle: 'Hochwasservorhersagezentrale',
      url: 'https://www.hvz.baden-wuerttemberg.de/',
      accessDate: '2019-11-02 10:59:12',
      language: 'de',
    },
    creators: [],
    tags: [['Instrumente', TAG_TYPE.manual]],
    collections: ['diss-k2-inst'],
  },
  {
    slug: 'wp-wikipedia-el',
    type: 'webpage',
    added: '2018-08-21T15:00:00Z',
    modified: '2018-08-21T15:00:00Z',
    fields: {
      title: 'Υδρολογικός κύκλος',
      websiteTitle: 'Βικιπαίδεια',
      url: 'https://el.wikipedia.org/wiki/Υδρολογικός_κύκλος',
      accessDate: '2018-08-21 14:58:44',
      language: 'el',
    },
    creators: [],
    tags: [],
    collections: ['theoria'],
  },
  {
    slug: 'wp-long-url',
    type: 'webpage',
    added: '2022-01-19T17:30:00Z',
    modified: '2022-01-19T17:30:00Z',
    fields: {
      title: 'Search results: rainfall–runoff AND calibration',
      websiteTitle: 'Web of Science',
      // Percent-encoding, a query string and an ampersand-heavy tail: everything that goes wrong
      // when a URL is written into a BibTeX field without protection.
      url:
        'https://www.webofscience.com/wos/woscc/summary/1a2b3c4d-5e6f-7890-abcd-ef1234567890-' +
        '01a2b3c4/relevance/1?query=rainfall%E2%80%93runoff%20AND%20calibration&sortBy=date&page=1',
      accessDate: '2022-01-19 17:28:55',
      language: 'en',
    },
    creators: [],
    tags: [['méthodes', TAG_TYPE.manual]],
    collections: [],
  },
  {
    slug: 'wp-github',
    type: 'webpage',
    added: '2024-05-12T08:44:00Z',
    modified: '2024-05-12T08:44:00Z',
    fields: {
      title: 'etabli/recueil: self-hosted, API-first document and reference manager',
      shortTitle: 'etabli/recueil',
      websiteTitle: 'GitHub',
      websiteType: 'Software repository',
      url: 'https://github.com/etabli/recueil',
      accessDate: '2024-05-12 08:43:02',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Heller', first: 'Raban' }],
    tags: [['Software', TAG_TYPE.manual]],
    collections: ['data-code'],
  },
  {
    slug: 'wp-dead-link',
    type: 'webpage',
    added: '2016-02-29T12:00:00Z',
    modified: '2022-03-03T13:00:00Z',
    trashed: '2022-03-03T13:00:00Z',
    fields: {
      title: 'Wasserportal (Seite nicht mehr erreichbar)',
      websiteTitle: 'Landesumweltamt',
      url: 'http://www.wasserportal.example.org/alt/index.php?id=17',
      accessDate: '2016-02-29 11:58:00',
      language: 'de',
    },
    creators: [],
    tags: [['papierkorb-nur', TAG_TYPE.manual]],
    collections: [],
  },

  /* ---- dataset (4) ------------------------------------------------------------------------- */
  {
    slug: 'ds-era5',
    type: 'dataset',
    added: '2021-02-08T10:00:00Z',
    modified: '2023-06-30T09:00:00Z',
    fields: {
      title: 'ERA5 hourly data on single levels from 1940 to present',
      // `repository` maps to `publisher`, `repositoryLocation` to `place`, `identifier` to `number`.
      repository: 'Copernicus Climate Change Service (C3S) Climate Data Store',
      repositoryLocation: 'Reading',
      versionNumber: '2023-06',
      type: 'Reanalysis dataset',
      date: d('2023', { year: 2023 }),
      DOI: '10.24381/cds.adbb2d47',
      language: 'en',
      accessDate: '2023-06-30 08:59:31',
    },
    creators: [
      { type: 'author', name: 'Copernicus Climate Change Service' },
      { type: 'contributor', last: 'Hersbach', first: 'Hans' },
    ],
    tags: [
      ['Open Data', TAG_TYPE.automatic],
      ['Δεδομένα', TAG_TYPE.manual],
    ],
    collections: ['data-code', 'diss-k2-inst'],
  },
  {
    slug: 'ds-pangaea',
    type: 'dataset',
    added: '2020-09-14T14:00:00Z',
    modified: '2020-09-14T14:00:00Z',
    fields: {
      title: 'Abflussmessungen an der Iller bei Wiblingen, 2015–2019',
      repository: 'PANGAEA',
      repositoryLocation: 'Bremerhaven',
      date: d('2020', { year: 2020 }),
      DOI: '10.1594/PANGAEA.921456',
      format: 'text/tab-separated-values',
      language: 'de',
    },
    creators: [{ type: 'author', last: 'Müller', first: 'Anna-Lena' }],
    tags: [['Open Data', TAG_TYPE.automatic]],
    collections: ['data-code'],
  },
  {
    slug: 'ds-replication',
    type: 'dataset',
    added: '2023-08-04T07:02:00Z',
    modified: '2023-08-04T07:02:00Z',
    fields: {
      title: 'Replication data for: Graph-based deduplication of bibliographic records at scale',
      shortTitle: 'Replication data for: Graph-based deduplication',
      repository: 'Zenodo',
      versionNumber: 'v1.2.0',
      date: d('2023-08-04', { year: 2023, month: 8, day: 4 }),
      DOI: '10.5281/zenodo.8213377',
      language: 'en',
    },
    creators: [{ type: 'author', last: 'Bianchi', first: 'Lorenzo' }],
    tags: [['Open Data', TAG_TYPE.automatic]],
    collections: ['data-code'],
  },
  {
    slug: 'ds-no-doi',
    type: 'dataset',
    added: '2019-05-30T16:16:16Z',
    modified: '2019-05-30T16:16:16Z',
    fields: {
      // No DOI: only a local accession number in the `identifier` field.
      title: 'Bodenfeuchtemessnetz Schwäbische Alb — Rohdaten',
      identifier: 'SMN-ALB-2019-001',
      repository: 'Universität Ulm, Institut für Geographie',
      date: d('2019', { year: 2019 }),
      language: 'de',
    },
    creators: [{ type: 'author', last: 'Weiß', first: 'Jürgen' }],
    tags: [['Instrumente', TAG_TYPE.manual]],
    collections: ['diss-k2-inst'],
  },

  /* ---- conferencePaper (2) ----------------------------------------------------------------- */
  {
    slug: 'cp-jcdl',
    type: 'conferencePaper',
    added: '2022-06-22T09:00:00Z',
    modified: '2022-06-22T09:00:00Z',
    fields: {
      title: 'Reference extraction from born-digital theses: a shared task report',
      // `proceedingsTitle` maps to `publicationTitle`.
      proceedingsTitle: 'Proceedings of the 22nd ACM/IEEE Joint Conference on Digital Libraries',
      conferenceName: 'JCDL 2022',
      publisher: 'ACM',
      place: 'New York, NY',
      eventPlace: 'Cologne, Germany',
      pages: '1-10',
      date: d('2022-06-20', { year: 2022, month: 6, day: 20 }),
      DOI: '10.1145/3529372.3530933',
      ISBN: '978-1-4503-9345-4',
      language: 'en',
    },
    creators: [
      { type: 'author', last: 'Bianchi', first: 'Lorenzo' },
      { type: 'author', last: 'Dlamini', first: 'Nomsa' },
    ],
    tags: [['Bibliometrie', TAG_TYPE.manual]],
    collections: ['data-code'],
  },
  {
    slug: 'cp-ecir-de',
    type: 'conferencePaper',
    added: '2017-04-12T10:00:00Z',
    modified: '2017-04-12T10:00:00Z',
    fields: {
      title: 'Automatische Zuordnung von Fachvokabular in hydrologischen Volltexten',
      proceedingsTitle: 'Tagungsband der 39. Jahrestagung der Gesellschaft für Informatik',
      conferenceName: 'GI-Jahrestagung 2017',
      publisher: 'Gesellschaft für Informatik',
      place: 'Bonn',
      eventPlace: 'Chemnitz',
      pages: '245–256',
      date: d('2017', { year: 2017 }),
      language: 'de',
    },
    creators: [{ type: 'author', last: 'Schmidt', first: 'Hanna' }],
    tags: [],
    collections: ['diss-k2'],
  },
];

/* ================================================================================================ */
/* Notes                                                                                            */
/* ================================================================================================ */

/**
 * Zotero stores note bodies as HTML in `itemNotes.note`, with a `title` column that Zotero derives
 * from the first line and keeps denormalised.
 *
 * @type {Array<object>}
 */
export const notes = [
  {
    slug: 'nt-donau-1',
    parent: 'ja-donau-niederschlag',
    added: '2019-09-02T07:50:11Z',
    modified: '2019-09-02T07:50:11Z',
    title: 'Kernaussage',
    html:
      '<div data-schema-version="9"><p><strong>Kernaussage:</strong> Winterniederschläge ' +
      'nehmen signifikant zu (p &lt; 0,01), Sommerniederschläge nur im Südteil ab.</p>' +
      '<p>Vergleich mit <em>Weiß &amp; Ó Súilleabháin (2015)</em> anstellen.</p></div>',
  },
  {
    slug: 'nt-donau-2',
    parent: 'ja-donau-niederschlag',
    added: '2023-11-14T18:03:52Z',
    modified: '2023-11-14T18:03:52Z',
    title: 'Zitat S. 224',
    html:
      '<div data-schema-version="9"><blockquote><p>„Die Trendanalyse ist gegenüber der Wahl ' +
      'des Referenzzeitraums robust.“</p></blockquote><p>(S. 224)</p></div>',
  },
  {
    slug: 'nt-dedup',
    parent: 'ja-dedup-published',
    added: '2023-08-04T07:00:00Z',
    modified: '2024-03-19T20:41:07Z',
    title: 'Vergleich mit dem Preprint',
    html:
      '<div data-schema-version="9"><p>Gegenüber dem Preprint (arXiv:2211.04512) ist Abschnitt 4 ' +
      'neu. Tabelle 3 wurde korrigiert.</p></div>',
  },
  {
    slug: 'nt-th-diss',
    parent: 'th-diss-ulm',
    added: '2023-02-01T08:05:00Z',
    modified: '2023-02-01T08:05:00Z',
    title: 'Kapitelübersicht',
    html:
      '<div data-schema-version="9"><ul><li>Kap. 2 — Stand der Forschung</li>' +
      '<li>Kap. 4 — Modellaufbau</li><li>Kap. 6 — Diskussion</li></ul></div>',
  },
  {
    slug: 'nt-ipcc',
    parent: 'rp-ipcc-ar6',
    added: '2021-08-10T06:40:00Z',
    modified: '2021-08-10T06:40:00Z',
    title: 'SPM-Verweise',
    html: '<div data-schema-version="9"><p>SPM.A.1, SPM.B.3 und Box TS.4 sind einschlägig.</p></div>',
  },
  {
    slug: 'nt-greek',
    parent: 'ja-athens-el',
    added: '2019-02-03T15:00:12Z',
    modified: '2019-02-03T15:00:12Z',
    title: 'Σημείωση',
    html:
      '<div data-schema-version="9"><p>Τα δεδομένα προέρχονται από την ΕΛΣΤΑΤ· χρειάζεται ' +
      'έλεγχος της μεθοδολογίας δειγματοληψίας.</p></div>',
  },
  {
    slug: 'nt-entities',
    parent: 'ja-braces-title',
    added: '2022-09-27T09:40:00Z',
    modified: '2022-09-27T09:40:00Z',
    title: 'HTML-Entities im Notentext',
    html:
      '<div data-schema-version="9"><p>Achtung: &amp;amp;, &amp;lt;, &amp;gt; und ' +
      '&amp;nbsp; kommen im Fließtext vor &mdash; beim Import nicht doppelt dekodieren.</p>' +
      '<p>Ein Link: <a href="https://doi.org/10.1629/uksg.588">10.1629/uksg.588</a></p></div>',
  },
  {
    slug: 'nt-on-trashed-parent',
    // The parent is in the trash but this note is not. Zotero does not write child rows into
    // `deletedItems` when a parent is trashed; the child is hidden because its parent is.
    parent: 'ja-trashed-duplicate',
    added: '2021-05-18T14:24:00Z',
    modified: '2021-05-18T14:24:00Z',
    title: 'Doppelt — löschen',
    html: '<div data-schema-version="9"><p>Doppelt erfasst, kann weg.</p></div>',
  },
  {
    slug: 'nt-trashed-itself',
    parent: 'ja-donau-niederschlag',
    added: '2019-09-02T07:55:00Z',
    modified: '2020-01-04T10:00:00Z',
    trashed: '2020-01-04T10:00:00Z',
    title: 'Verworfene Notiz',
    html: '<div data-schema-version="9"><p>Diese Notiz war ein Irrtum.</p></div>',
  },
  {
    slug: 'nt-standalone-reading',
    parent: null,
    added: '2022-01-03T09:00:00Z',
    modified: '2024-01-02T08:30:00Z',
    title: 'Leseplan 2024',
    html:
      '<div data-schema-version="9"><h1>Leseplan 2024</h1><ol><li>Willinsky (2006)</li>' +
      '<li>Okonkwo (2021)</li><li>Szűcs &amp; Nováková (2018)</li></ol></div>',
    collections: ['reading'],
    tags: [['to-read', TAG_TYPE.manual]],
  },
  {
    slug: 'nt-standalone-method',
    parent: null,
    added: '2020-03-17T21:00:00Z',
    modified: '2020-03-17T21:00:00Z',
    title: 'Methodennotiz — Unsicherheiten',
    html:
      '<div data-schema-version="9"><p>Fehlerfortpflanzung nach GUM; Monte-Carlo mit 10<sup>4</sup> ' +
      'Realisierungen. Vgl. Weiß &amp; Nakamura (2018).</p></div>',
    collections: ['diss-k2'],
    tags: [['méthodes', TAG_TYPE.manual]],
  },
];

/* ================================================================================================ */
/* Attachments                                                                                      */
/* ================================================================================================ */

/**
 * All five things an attachment can be, plus the one that matters most for the verification report:
 * a stored file that is not on disk.
 *
 * `file` describes what the generator writes to `storage/<key>/`; `null` means write nothing, which
 * is either correct (a linked URL has no file) or deliberately wrong (`at-missing-file`).
 *
 * @type {Array<object>}
 */
export const attachments = [
  {
    slug: 'at-donau-pdf',
    parent: 'ja-donau-niederschlag',
    linkMode: LINK_MODE.imported_file,
    title: 'Müller et al. - 2019 - Niederschlagsvariabilität im Einzugsgebiet der obe.pdf',
    contentType: 'application/pdf',
    filename: 'Müller et al. - 2019 - Niederschlagsvariabilität im Einzugsgebiet der obe.pdf',
    added: '2019-09-02T07:41:22Z',
    modified: '2019-09-02T07:41:22Z',
    file: { kind: 'pdf', title: 'Niederschlagsvariabilitaet im Einzugsgebiet der oberen Donau' },
    annotations: [
      'an-highlight',
      'an-note',
      'an-image',
      'an-ink',
      'an-underline',
      'an-text',
    ],
  },
  {
    slug: 'at-dedup-pdf',
    parent: 'ja-dedup-published',
    linkMode: LINK_MODE.imported_file,
    title: 'Full Text PDF',
    contentType: 'application/pdf',
    filename: 'Bianchi and Müller - 2023 - Graph-based deduplication.pdf',
    added: '2023-08-04T06:55:40Z',
    modified: '2023-08-04T06:55:40Z',
    file: { kind: 'pdf', title: 'Graph-based deduplication of bibliographic records at scale' },
    annotations: ['an-dedup-1', 'an-dedup-2'],
  },
  {
    slug: 'at-thesis-pdf',
    parent: 'th-diss-ulm',
    linkMode: LINK_MODE.imported_file,
    title: 'Dissertation (Volltext)',
    contentType: 'application/pdf',
    filename: 'mueller-2022-dissertation.pdf',
    added: '2022-12-15T10:31:00Z',
    modified: '2022-12-15T10:31:00Z',
    file: { kind: 'pdf', title: 'Modellgestuetzte Analyse des Niederschlag-Abfluss-Verhaltens' },
  },
  {
    slug: 'at-ipcc-pdf',
    parent: 'rp-ipcc-ar6',
    linkMode: LINK_MODE.imported_file,
    title: 'IPCC_AR6_WGI_SPM.pdf',
    contentType: 'application/pdf',
    filename: 'IPCC_AR6_WGI_SPM.pdf',
    added: '2021-08-10T06:31:00Z',
    modified: '2021-08-10T06:31:00Z',
    file: { kind: 'pdf', title: 'Climate Change 2021: Summary for Policymakers' },
  },
  {
    slug: 'at-interop-jis-pdf',
    parent: 'ja-interop-jis',
    linkMode: LINK_MODE.imported_file,
    title: 'Full Text PDF',
    contentType: 'application/pdf',
    filename: 'Okonkwo - 2021 - Interoperability.pdf',
    added: '2021-05-18T14:22:10Z',
    modified: '2021-05-18T14:22:10Z',
    file: { kind: 'pdf', title: 'Interoperability (Journal of Information Science)' },
  },
  {
    slug: 'at-interop-dap-pdf',
    parent: 'ja-interop-dap',
    linkMode: LINK_MODE.imported_file,
    // Same title and same filename as at-interop-jis-pdf, different bytes and a different parent.
    // Deduplicating attachments on filename alone loses one of them.
    title: 'Full Text PDF',
    contentType: 'application/pdf',
    filename: 'Okonkwo - 2021 - Interoperability.pdf',
    added: '2019-01-30T11:08:02Z',
    modified: '2019-01-30T11:08:02Z',
    file: { kind: 'pdf', title: 'Interoperability (Data & Policy)' },
  },
  {
    slug: 'at-hydro-book-scan',
    parent: 'bk-hydrologie-3',
    linkMode: LINK_MODE.imported_file,
    title: 'Kapitel 12 (Scan)',
    contentType: 'application/pdf',
    filename: 'kap12-scan.pdf',
    added: '2019-01-12T11:20:00Z',
    modified: '2019-01-12T11:20:00Z',
    file: { kind: 'pdf', title: 'Lehrbuch der Hydrologie, Kapitel 12 (Scan)' },
  },
  {
    slug: 'at-preprint-pdf',
    parent: 'pp-dedup-preprint',
    linkMode: LINK_MODE.imported_file,
    title: 'arXiv Fulltext PDF',
    contentType: 'application/pdf',
    filename: '2211.04512v2.pdf',
    added: '2022-11-09T19:20:30Z',
    modified: '2022-11-09T19:20:30Z',
    file: { kind: 'pdf', title: 'arXiv:2211.04512v2' },
  },
  {
    slug: 'at-missing-file',
    parent: 'ja-accents-mixed',
    linkMode: LINK_MODE.imported_file,
    // The row says there is a stored file. There is not: no directory, no bytes. This is the
    // record the verification report exists for — CONCEPT.md §6, "missing files routed to
    // `_REVIEW/` with reasons".
    title: 'Weiß et al. - 2015 - Über die Bestimmung von Nährstoffflüssen.pdf',
    contentType: 'application/pdf',
    filename: 'Weiß et al. - 2015 - Über die Bestimmung von Nährstoffflüssen.pdf',
    added: '2015-05-14T08:13:00Z',
    modified: '2015-05-14T08:13:00Z',
    file: null,
    missingOnPurpose: true,
  },
  {
    slug: 'at-standalone-pdf',
    parent: null,
    linkMode: LINK_MODE.imported_file,
    // A stored file with no parent item, filed straight into a collection. Zotero's own trigger
    // forbids a *child* attachment from being in a collection; a standalone one may be.
    title: 'Unsortiertes Manuskript.pdf',
    contentType: 'application/pdf',
    filename: 'unsortiertes-manuskript.pdf',
    added: '2024-06-01T12:00:00Z',
    modified: '2024-06-01T12:00:00Z',
    file: { kind: 'pdf', title: 'Unsortiertes Manuskript' },
    collections: ['data-code'],
  },
  {
    slug: 'at-snapshot-bmuv',
    parent: 'wp-nationale-wasserstrategie',
    linkMode: LINK_MODE.imported_url,
    title: 'Snapshot',
    contentType: 'text/html',
    charset: 'utf-8',
    filename: 'nationale-wasserstrategie.html',
    url: 'https://www.bmuv.de/themen/wasser-ressourcen-abfall/nationale-wasserstrategie',
    accessDate: '2023-03-16 09:19:41',
    added: '2023-03-16T09:20:05Z',
    modified: '2023-03-16T09:20:05Z',
    file: {
      kind: 'html',
      title: 'Nationale Wasserstrategie',
      body:
        'Die Nationale Wasserstrategie beschreibt Ziele und Maßnahmen für einen nachhaltigen ' +
        'Umgang mit der Ressource Wasser bis 2050.',
    },
  },
  {
    slug: 'at-snapshot-github',
    parent: 'wp-github',
    linkMode: LINK_MODE.imported_url,
    title: 'Snapshot',
    contentType: 'text/html',
    charset: 'utf-8',
    filename: 'recueil.html',
    url: 'https://github.com/etabli/recueil',
    accessDate: '2024-05-12 08:43:02',
    added: '2024-05-12T08:44:10Z',
    modified: '2024-05-12T08:44:10Z',
    file: {
      kind: 'html',
      title: 'etabli/recueil',
      body: 'Self-hosted, API-first document and reference manager. AGPL-3.0-or-later.',
    },
  },
  {
    slug: 'at-linked-present',
    parent: 'ja-endash-pages',
    linkMode: LINK_MODE.linked_file,
    // A linked file whose target the generator does write, under `linked-attachments/`. The path
    // is relative to Zotero's linked-attachment base directory, which is why it is prefixed
    // `attachments:` rather than being absolute.
    title: 'Sonderdruck (verlinkt)',
    contentType: 'application/pdf',
    linkedPath: 'sonderdrucke/weiss-2018-sonderdruck.pdf',
    added: '2018-12-05T17:29:00Z',
    modified: '2018-12-05T17:29:00Z',
    file: { kind: 'pdf', title: 'Uncertainty propagation in nutrient load estimation' },
  },
  {
    slug: 'at-linked-absolute-missing',
    parent: 'bk-usgs-methods',
    linkMode: LINK_MODE.linked_file,
    // An absolute path from another machine. Zotero stores it verbatim when no base directory is
    // configured, and it is unresolvable anywhere else — the second thing the verification report
    // has to be able to say.
    title: 'Statistical Methods in Water Resources (lokale Kopie)',
    contentType: 'application/pdf',
    absolutePath: '/home/rh/Dokumente/Literatur/helsel-hirsch-2020-tm4a3.pdf',
    added: '2020-05-06T12:01:00Z',
    modified: '2020-05-06T12:01:00Z',
    file: null,
    missingOnPurpose: true,
  },
  {
    slug: 'at-link-doi',
    parent: 'ja-paca-fr',
    linkMode: LINK_MODE.linked_url,
    title: 'Cairn.info',
    contentType: 'text/html',
    url: 'https://www.cairn.info/revue-d-economie-regionale-et-urbaine-2016-3-page-507.htm',
    accessDate: '2016-11-08 16:43:11',
    added: '2016-11-08T16:44:30Z',
    modified: '2016-11-08T16:44:30Z',
    file: null,
  },
  {
    slug: 'at-link-dataset',
    parent: 'ds-era5',
    linkMode: LINK_MODE.linked_url,
    title: 'Climate Data Store entry',
    contentType: 'text/html',
    url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels',
    accessDate: '2023-06-30 08:59:31',
    added: '2021-02-08T10:01:00Z',
    modified: '2023-06-30T09:00:00Z',
    file: null,
  },
  {
    slug: 'at-link-trashed',
    parent: 'wp-dead-link',
    linkMode: LINK_MODE.linked_url,
    // In the trash in its own right, with an entry in `deletedItems`.
    title: 'Alte Startseite',
    contentType: 'text/html',
    url: 'http://www.wasserportal.example.org/alt/index.php?id=17',
    added: '2016-02-29T12:01:00Z',
    modified: '2022-03-03T13:00:00Z',
    trashed: '2022-03-03T13:00:00Z',
    file: null,
  },
];

/* ================================================================================================ */
/* Annotations                                                                                      */
/* ================================================================================================ */

/**
 * All six annotation types Zotero knows, on the two PDFs that have them. `position` and `sortIndex`
 * are stored exactly as Zotero's reader writes them: `position` is JSON, `sortIndex` is a
 * fixed-width string built for lexical ordering (`page|offset|y`).
 *
 * @type {Array<object>}
 */
export const annotations = [
  {
    slug: 'an-highlight',
    type: ANNOTATION_TYPE.highlight,
    authorName: null,
    text: 'Winterniederschläge nehmen im Untersuchungszeitraum signifikant zu',
    comment: 'Kernbefund',
    color: '#ffd400',
    pageLabel: '224',
    sortIndex: '00007|000412|00287',
    position: { pageIndex: 7, rects: [[71.2, 512.4, 480.9, 526.1]] },
    added: '2019-09-10T14:22:00Z',
    modified: '2019-09-10T14:22:00Z',
    tags: [['wichtig', TAG_TYPE.manual]],
  },
  {
    slug: 'an-note',
    type: ANNOTATION_TYPE.note,
    authorName: null,
    text: null,
    comment: 'Methodik hier mit Kapitel 4 der Dissertation abgleichen.',
    color: '#a28ae5',
    pageLabel: '225',
    sortIndex: '00008|000031|00104',
    position: { pageIndex: 8, rects: [[492.0, 688.0, 516.0, 712.0]] },
    added: '2019-09-10T14:25:00Z',
    modified: '2019-09-10T14:25:00Z',
  },
  {
    slug: 'an-image',
    type: ANNOTATION_TYPE.image,
    authorName: null,
    text: null,
    comment: 'Abbildung 3 — Trendkarte',
    color: '#5fb236',
    pageLabel: '227',
    sortIndex: '00010|000000|00062',
    position: { pageIndex: 10, rects: [[70.0, 380.0, 525.0, 700.0]], width: 910, height: 640 },
    added: '2019-09-10T14:31:00Z',
    modified: '2019-09-10T14:31:00Z',
    // Zotero caches the rendered region under `storage/<annotationKey>/image.png`. That is a
    // regenerable cache, not library data, and the fixture deliberately omits it.
  },
  {
    slug: 'an-ink',
    type: ANNOTATION_TYPE.ink,
    authorName: 'Anna-Lena Müller',
    text: null,
    comment: null,
    color: '#e56eee',
    pageLabel: '228',
    sortIndex: '00011|000000|00330',
    position: {
      pageIndex: 11,
      paths: [[112.4, 500.1, 130.8, 512.7, 149.2, 498.3]],
      width: 2,
    },
    added: '2019-09-11T08:02:00Z',
    modified: '2019-09-11T08:02:00Z',
  },
  {
    slug: 'an-underline',
    type: ANNOTATION_TYPE.underline,
    authorName: null,
    text: 'robust gegenüber der Wahl des Referenzzeitraums',
    comment: null,
    color: '#2ea8e5',
    pageLabel: '224',
    sortIndex: '00007|000598|00301',
    position: { pageIndex: 7, rects: [[71.2, 486.0, 352.7, 499.4]] },
    added: '2019-09-11T08:05:00Z',
    modified: '2019-09-11T08:05:00Z',
  },
  {
    slug: 'an-text',
    type: ANNOTATION_TYPE.text,
    authorName: null,
    text: 'Anmerkung im Text',
    comment: 'Freitextfeld direkt auf der Seite',
    color: '#ff6666',
    pageLabel: '229',
    sortIndex: '00012|000000|00080',
    position: { pageIndex: 12, rects: [[80.0, 640.0, 300.0, 664.0]], fontSize: 14, rotation: 0 },
    added: '2019-09-11T08:09:00Z',
    modified: '2019-09-11T08:09:00Z',
  },
  {
    slug: 'an-dedup-1',
    type: ANNOTATION_TYPE.highlight,
    // An annotation imported from a PDF that someone else annotated: `isExternal` is 1 and the
    // author name is not the local user.
    authorName: 'L. Bianchi',
    isExternal: true,
    text: 'constrained clustering step',
    comment: null,
    color: '#ffd400',
    pageLabel: '44',
    sortIndex: '00003|000210|00190',
    position: { pageIndex: 3, rects: [[90.0, 601.2, 288.4, 614.9]] },
    added: '2023-08-04T07:10:00Z',
    modified: '2023-08-04T07:10:00Z',
  },
  {
    slug: 'an-dedup-2',
    type: ANNOTATION_TYPE.note,
    authorName: null,
    text: null,
    comment: 'Vergleich mit unserem Ansatz: gleiche Idee, andere Kostenfunktion. Σ ≈ 0,84.',
    color: '#f19837',
    pageLabel: '52',
    sortIndex: '00011|000004|00058',
    position: { pageIndex: 11, rects: [[500.0, 700.0, 524.0, 724.0]] },
    added: '2024-03-19T20:41:07Z',
    modified: '2024-03-19T20:41:07Z',
    tags: [['méthodes', TAG_TYPE.manual]],
  },
];

/* ================================================================================================ */
/* Relations                                                                                        */
/* ================================================================================================ */

/**
 * `itemRelations` rows. `dc:relation` is what Zotero writes for "Related" and it writes both
 * directions; the fixture keeps that symmetry so an importer that assumes one direction produces
 * half the edges.
 *
 * @type {Array<{ from: string, predicate: string, to: string, external?: object }>}
 */
export const relations = [
  // The preprint and the published article: two versions of one work.
  { from: 'pp-dedup-preprint', predicate: PREDICATE.related, to: 'ja-dedup-published' },
  { from: 'ja-dedup-published', predicate: PREDICATE.related, to: 'pp-dedup-preprint' },
  // …and the replication dataset that goes with both.
  { from: 'ds-replication', predicate: PREDICATE.related, to: 'ja-dedup-published' },
  { from: 'ja-dedup-published', predicate: PREDICATE.related, to: 'ds-replication' },
  { from: 'ds-replication', predicate: PREDICATE.related, to: 'pp-dedup-preprint' },
  { from: 'pp-dedup-preprint', predicate: PREDICATE.related, to: 'ds-replication' },
  // The third and fourth editions of the same textbook.
  { from: 'bk-hydrologie-3', predicate: PREDICATE.related, to: 'bk-hydrologie-4' },
  { from: 'bk-hydrologie-4', predicate: PREDICATE.related, to: 'bk-hydrologie-3' },
  // The chapter and the book it is in.
  { from: 'bs-alpine-modellierung', predicate: PREDICATE.related, to: 'bk-hydrologie-3' },
  { from: 'bk-hydrologie-3', predicate: PREDICATE.related, to: 'bs-alpine-modellierung' },
  // A one-sided relation: the other end was deleted years ago and Zotero left this row behind.
  { from: 'ja-athens-el', predicate: PREDICATE.related, to: { danglingKey: 'QZ4V8MTR' } },
  // Copied out of a group library the user has since left.
  { from: 'rp-ipcc-ar6', predicate: PREDICATE.sameAs, to: { group: 'QK9WTP2N' } },
  // The survivor of a merge; `dc:replaces` points at the key the merged-away item had.
  { from: 'ja-interop-jis', predicate: PREDICATE.replaces, to: { danglingKey: 'H7N3XCVB' } },
];

/* ================================================================================================ */
/* Better BibTeX                                                                                    */
/* ================================================================================================ */

/**
 * Rows for `better-bibtex.sqlite`. `pinned` 1 means the user fixed the key by hand and Better
 * BibTeX must never recompute it; 0 means Better BibTeX generated it and would regenerate it.
 *
 * Two rows are stale — they name items that no longer exist. Better BibTeX's own migration filters
 * those out (`content/key-manager/migrate.ts`), and so must Recueil's importer.
 *
 * @type {Array<{ item?: string, key: string, pinned: boolean, stale?: string }>}
 */
export const betterBibtexKeys = [
  { item: 'ja-donau-niederschlag', key: 'mueller2019niederschlagsvariabilitat', pinned: true },
  { item: 'ja-interop-jis', key: 'okonkwo2021interoperability', pinned: false },
  { item: 'ja-interop-dap', key: 'szucs2018interoperability', pinned: false },
  { item: 'ja-dedup-published', key: 'bianchi2023graph', pinned: true },
  { item: 'pp-dedup-preprint', key: 'bianchi2022graph', pinned: true },
  { item: 'ja-volga-ru', key: 'ivanova2020ocenka', pinned: false },
  { item: 'ja-athens-el', key: 'papadopoulos2017meleti', pinned: false },
  { item: 'ja-paca-fr', key: 'lefevre2016evaluation', pinned: true },
  { item: 'ja-long-title', key: 'ng2022systematic', pinned: false },
  { item: 'ja-editorial-nocreator', key: 'anon2021editorial', pinned: true },
  { item: 'ja-extra-citekey', key: 'schmidt2017soil', pinned: true },
  { item: 'ja-native-citekey', key: 'bianchi2024networks', pinned: false },
  // Disagrees with both the native `citationKey` field and the Extra line on the same item.
  { item: 'ja-conflicting-keys', key: 'vasquez2020', pinned: true },
  { item: 'ja-braces-title', key: 'okonkwo2022dna', pinned: false },
  { item: 'ja-endash-pages', key: 'weiss2018uncertainty', pinned: false },
  { item: 'ja-accents-mixed', key: 'weiss2015uber', pinned: false },
  { item: 'ja-same-lastname', key: 'nakamura2019seasonal', pinned: false },
  { item: 'ja-many-authors', key: 'addor2023community', pinned: false },
  { item: 'bk-hydrologie-3', key: 'baumgartner2019lehrbuch', pinned: true },
  { item: 'bk-hydrologie-4', key: 'baumgartner2024lehrbuch', pinned: true },
  { item: 'bk-access-principle', key: 'willinsky2006access', pinned: false },
  { item: 'bk-unesco-wwdr', key: 'unesco2021united', pinned: false },
  { item: 'th-diss-ulm', key: 'mueller2022modellgestutzte', pinned: true },
  { item: 'rp-ipcc-ar6', key: 'ipcc2021climate', pinned: true },
  { item: 'ds-era5', key: 'copernicus2023era5', pinned: false },
  { item: 'cp-jcdl', key: 'bianchi2022reference', pinned: false },
  // Stale: the items these rows name were deleted from Zotero and Better BibTeX never noticed.
  { stale: 'deleted-item-8814', key: 'ghost2011orphan', pinned: true },
  { stale: 'deleted-item-9002', key: 'ghost2014orphan', pinned: false },
];

/* ================================================================================================ */
/* Tags                                                                                             */
/* ================================================================================================ */

/**
 * Colour assignments live in `syncedSettings` under `tagColors`, not in `tags`. Zotero shows these
 * tags as coloured swatches and gives them keyboard shortcuts; an importer that ignores
 * `syncedSettings` silently drops every tag colour in the library.
 */
export const tagColors = [
  { name: 'wichtig', color: '#FF6666', position: 0 },
  { name: 'to-read', color: '#2EA8E5', position: 1 },
  { name: 'Hydrologie', color: '#5FB236', position: 2 },
];
