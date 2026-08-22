/**
 * Shared fixtures.
 *
 * The records here are deliberately awkward — an umlaut, a particle, a corporate editor, an
 * acronym, an ampersand, a percent sign, a set of braces and a piece of maths in one title — because
 * a fixture that only exercises `Smith, J. (2019). A Paper.` proves nothing about the parts of these
 * formats that actually break.
 */
import type { FormatRecord } from '../src/record.js';

/** ADR-0016's own worked example: Ravaud, P. (2019) → `ravaudEffPreSys2019`. */
export const ravaud: FormatRecord = {
  id: '01JB000000000000000000RAVA',
  itemType: 'article',
  createdAt: '2026-01-02T09:00:00.000Z',
  creators: [{ role: 'author', kind: 'person', familyName: 'Ravaud', givenName: 'Philippe' }],
  bibliographic: {
    title: 'The Effect of Preprints on Systematic Review Timeliness',
    issuedDate: '2019',
    issuedYear: 2019,
  },
};

/** Everything a `.bib` file can hold, and a title designed to break an escaper. */
export const awkward: FormatRecord = {
  id: '01JB000000000000000000AWKW',
  itemType: 'article',
  createdAt: '2026-01-03T09:00:00.000Z',
  creators: [
    { role: 'author', kind: 'person', familyName: 'Müller', givenName: 'Jörg' },
    { role: 'author', kind: 'person', familyName: 'Beethoven', givenName: 'Ludwig', namePrefix: 'van' },
    { role: 'author', kind: 'person', familyName: 'Kennedy', givenName: 'John F.', nameSuffix: 'Jr' },
    { role: 'editor', kind: 'organisation', literalName: 'World Health Organization' },
  ],
  keywords: ['DNA repair', 'p53'],
  attachments: [
    { path: 'files/1/paper.pdf', title: 'Full Text PDF', mimeType: 'application/pdf', role: 'primary' },
  ],
  extra: 'Citation Key: mueller2019',
  bibliographic: {
    title: 'On {DNA} & 100% Efficiency: A $p < 0.05$ Study of pH in Ångström Scales',
    containerTitle: 'Journal of Awkward Results',
    containerShort: 'J. Awk. Res.',
    volume: '12',
    issue: '3',
    pages: '123-145',
    pageFirst: 123,
    pageLast: 145,
    issuedDate: '2019-04',
    issuedYear: 2019,
    issuedMonth: 4,
    accessedAt: '2024-05-01T00:00:00.000Z',
    doi: '10.1136/bmj.n71',
    issn: '0140-6736',
    languageCode: 'en-GB',
    abstract: 'A study of everything that breaks a bibliographic exporter.',
    citationKey: 'muellerDNA100Eff2019',
    citationKeyLocked: true,
  },
};

/** A book chapter with an editor, a publisher and a place — the `@incollection` path. */
export const chapter: FormatRecord = {
  id: '01JB000000000000000000CHAP',
  itemType: 'chapter',
  createdAt: '2026-01-04T09:00:00.000Z',
  creators: [
    { role: 'author', kind: 'person', familyName: 'Szűcs', givenName: 'Dénes' },
    { role: 'editor', kind: 'person', familyName: 'Nowak', givenName: 'Agnieszka' },
  ],
  bibliographic: {
    title: 'Statistical Power in Cognitive Neuroscience',
    containerTitle: 'Handbook of Methods',
    collectionTitle: 'Methods in Mind',
    collectionNumber: '4',
    publisher: 'Cambridge University Press',
    publisherPlace: 'Cambridge',
    edition: '2nd',
    pages: '55-88',
    pageFirst: 55,
    pageLast: 88,
    issuedDate: '2021-09-15',
    issuedYear: 2021,
    issuedMonth: 9,
    isbn: '9780262035613',
  },
};

/** A classic `.bib` file: `@string`, concatenation, a cross-reference and a `file` field. */
export const BIBTEX_FIXTURE = String.raw`
@string{jaw = "Journal of Awkward Results"}
@string{cup = "Cambridge University Press"}

@preamble{"\newcommand{\noopsort}[1]{}"}

@comment{Exported by something else entirely.}

@article{muellerDNA100Eff2019,
  author       = {M\"{u}ller, J\"{o}rg and van Beethoven, Ludwig and Kennedy, Jr, John F.},
  editor       = {{World Health Organization}},
  title        = {On \{DNA\} \& 100\% Efficiency: A $p < 0.05$ Study of {pH} in \r{A}ngstr\"{o}m Scales},
  journal      = jaw,
  volume       = {12},
  number       = {3},
  pages        = {123--145},
  year         = 2019,
  month        = apr,
  doi          = {10.1136/bmj.n71},
  issn         = {0140-6736},
  keywords     = {DNA repair, p53},
  language     = {en-GB},
  file         = {Full Text PDF:files/1/paper.pdf:application/pdf},
}

@proceedings{handbook2021,
  title        = {Handbook of Methods},
  editor       = {Nowak, Agnieszka},
  publisher    = cup # { and Friends},
  address      = {Cambridge},
  year         = {2021},
}

@incollection{szucsSta2021,
  crossref     = {handbook2021},
  author       = {Sz\H{u}cs, D\'{e}nes},
  title        = {Statistical Power in Cognitive Neuroscience},
  pages        = {55--88},
  unheardof    = {something this importer has no field for},
}
`;

/** A RIS file with a continuation line, repeated keywords and a `Y2` access date. */
export const RIS_FIXTURE = [
  'TY  - JOUR',
  'ID  - ravaudEffPreSys2019',
  'AU  - Ravaud, Philippe',
  'AU  - Créquit, Perrine',
  'TI  - The Effect of Preprints on Systematic',
  '      Review Timeliness',
  'T2  - Journal of Awkward Results',
  'VL  - 12',
  'IS  - 3',
  'SP  - 123',
  'EP  - 145',
  'PY  - 2019',
  'DA  - 2019/04//',
  'Y2  - 2024/05/01/',
  'SN  - 0140-6736',
  'DO  - 10.1136/bmj.n71',
  'KW  - preprints',
  'KW  - systematic reviews',
  'LA  - en',
  'N1  - Imported from a real database.',
  'L1  - files/1/paper.pdf',
  'XX  - a tag nothing understands',
  'ER  - ',
  '',
].join('\r\n');

/** A CSL-JSON fixture with a structured name, a date range and a variable Recueil has no field for. */
export const CSL_FIXTURE = JSON.stringify(
  [
    {
      id: 'nowakHan2021',
      type: 'chapter',
      'citation-key': 'nowakHan2021',
      author: [{ family: 'Szűcs', given: 'Dénes' }],
      editor: [{ family: 'Nowak', given: 'Agnieszka' }],
      title: 'Statistical Power in Cognitive Neuroscience',
      'container-title': 'Handbook of Methods',
      publisher: 'Cambridge University Press',
      'publisher-place': 'Cambridge',
      page: '55-88',
      issued: { 'date-parts': [[2021, 9, 15]] },
      ISBN: '978-0-262-03561-3',
      'original-title': 'A variable the contract has no column for',
    },
  ],
  null,
  2,
);
