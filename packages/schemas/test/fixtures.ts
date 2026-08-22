/**
 * Fixtures shared by the tests.
 *
 * These are written by hand rather than generated, because a generated fixture only ever proves
 * the generator agrees with itself. Everything here is shaped like a record the server would
 * really produce or a client would really send.
 */
import type {
  Annotation,
  Attachment,
  Collection,
  Creator,
  CustomField,
  Document,
  FieldValue,
  HealthResponse,
  Item,
  ItemCreate,
  Note,
  Tag,
} from '../src/index.js';

export const ULID_A = '01J8F3Z9K4ABCDEFGHJKMNPQRS';
export const ULID_B = '01J8F3Z9K5BCDEFGHJKMNPQRST';
export const ULID_C = '01J8F3Z9K6CDEFGHJKMNPQRSTV';
export const ULID_USER = '01J8F3Z9K7DEFGHJKMNPQRSTVW';

export const SHA256_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const NOW = '2026-08-22T09:15:00.000Z';

export const validDocument: Document = {
  id: ULID_A,
  sha256: SHA256_A,
  byteSize: 1_048_576,
  mimeType: 'application/pdf',
  mimeSource: 'sniffed',
  originalFilename: 'ravaud-2019-preprints.pdf',
  storageBackend: 'local',
  storageKey: 'e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  storageOk: true,
  pageCount: 12,
  hasTextLayer: true,
  ocrStatus: 'not_needed',
  simhash: '9f2c1a0b7d4e6a33',
  sourceKind: 'connector',
  sourceRef: 'https://www.bmj.com/content/372/bmj.n71',
  sourceDetail: { pageTitle: 'The PRISMA 2020 statement' },
  ingestedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validItem: Item = {
  id: ULID_B,
  publicId: 'A1B2C3D4',
  itemType: 'article',
  title: 'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews',
  ownerUserId: ULID_USER,
  libraryState: 'normal',
  version: 3,
  dateAdded: NOW,
  dateModified: NOW,
  sourceSystem: 'zotero',
  sourceId: 'ABCD2345',
  bibliographic: {
    title: 'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews',
    containerTitle: 'BMJ',
    volume: '372',
    pages: 'n71',
    pageFirst: 71,
    issuedDate: '2021-03-29',
    issuedYear: 2021,
    issuedMonth: 3,
    doi: '10.1136/bmj.n71',
    pmid: '33782057',
    isbn: null,
    issn: '0959-8138',
    openalexId: 'W3135361538',
    abstract: 'The PRISMA statement was published in 2009 …',
    languageCode: 'en-GB',
    citationKey: 'pageProSta2021',
    citationKeyLocked: true,
    oaStatus: 'gold',
    isPreprint: false,
    retractionStatus: 'none',
    verificationStatus: 'verified',
    createdAt: NOW,
    updatedAt: NOW,
    provenance: {
      doi: {
        source: 'crossref',
        sourceRecordId: '10.1136/bmj.n71',
        confidence: 1,
        fetchedAt: NOW,
        appliedAt: NOW,
        locked: false,
      },
      citationKey: {
        source: 'manual',
        fetchedAt: NOW,
        appliedAt: NOW,
        locked: true,
        lockedAt: NOW,
        lockedByUserId: ULID_USER,
      },
    },
    lockedFields: ['citationKey'],
  },
};

export const validItemCreate: ItemCreate = {
  itemType: 'preprint',
  title: 'A preprint with nothing but a title',
  bibliographic: {
    title: 'A preprint with nothing but a title',
    arxivId: '2103.00020v2',
    isPreprint: true,
  },
  creators: [
    { creatorId: ULID_C, role: 'author', rawName: 'Ravaud, Philippe' },
  ],
  tagNames: ['methodology', 'to-read'],
};

export const validAttachment: Attachment = {
  id: ULID_C,
  itemId: ULID_B,
  documentId: ULID_A,
  role: 'primary',
  linkMode: 'stored',
  title: 'Full text (PDF)',
  hasAnnotations: true,
  annotationCount: 4,
  position: 0,
  source: 'connector',
  addedAt: NOW,
  updatedAt: NOW,
};

export const validCollection: Collection = {
  id: ULID_A,
  publicId: 'PHD00001',
  name: 'Systematic review methodology',
  nameNormalised: 'systematic review methodology',
  ownerUserId: ULID_USER,
  kind: 'manual',
  depth: 1,
  parentId: ULID_B,
  position: 2,
  colour: '#1e88e5',
  createdAt: NOW,
  updatedAt: NOW,
};

export const validTag: Tag = {
  id: ULID_A,
  name: 'to-read',
  nameNormalised: 'to-read',
  scheme: 'manual',
  ownerUserId: ULID_USER,
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validNote: Note = {
  id: ULID_A,
  publicId: 'N0TE0001',
  itemId: ULID_B,
  ownerUserId: ULID_USER,
  title: 'Why this matters for the review',
  contentMarkdown: '# Why this matters\n\nThe flow diagram counts come from live data.',
  sourceFormat: 'markdown',
  noteKind: 'note',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validAnnotation: Annotation = {
  id: ULID_A,
  publicId: 'ANN00001',
  documentId: ULID_A,
  itemId: ULID_B,
  attachmentId: ULID_C,
  annotationType: 'highlight',
  motivation: 'highlighting',
  selector: [
    { type: 'TextQuoteSelector', exact: 'reporting systematic reviews', prefix: 'guideline for ' },
    { type: 'TextPositionSelector', start: 1024, end: 1052 },
    { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: 'page=3' },
  ],
  quotedText: 'reporting systematic reviews',
  prefixText: 'guideline for ',
  bodyText: 'This is the sentence to quote in the methods section.',
  bodyFormat: 'markdown',
  colour: '#ffd400',
  pageIndex: 2,
  pageLabel: '3',
  positionSortKey: '00002|0000512|0000180',
  authorUserId: ULID_USER,
  isExternal: false,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validCreator: Creator = {
  id: ULID_C,
  kind: 'person',
  familyName: 'Ravaud',
  givenName: 'Philippe',
  displayName: 'Philippe Ravaud',
  sortName: 'ravaud, philippe',
  initials: 'P',
  orcid: '0000-0002-1825-0097',
  disambiguationStatus: 'confirmed',
  createdAt: NOW,
  updatedAt: NOW,
};

export const validCustomField: CustomField = {
  id: ULID_A,
  fieldKey: 'sample_size',
  name: 'Sample size',
  description: 'Number of participants analysed.',
  dataType: 'integer',
  config: { min: 0 },
  appliesToItemTypes: ['article', 'preprint'],
  isRequired: false,
  isRepeatable: false,
  scope: 'review',
  position: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validFieldValue: FieldValue = {
  id: ULID_B,
  fieldId: ULID_A,
  fieldKey: 'sample_size',
  itemId: ULID_B,
  reviewId: ULID_C,
  groupKey: 'arm:intervention',
  ordinal: 0,
  content: { type: 'integer', value: 412 },
  isBlank: false,
  createdAt: NOW,
  updatedAt: NOW,
};

export const validHealth: HealthResponse = {
  status: 'ok',
  name: 'recueil',
  version: '0.1.0',
  apiVersion: 'v1',
  checkedAt: NOW,
  startedAt: '2026-08-22T09:00:00.000Z',
  uptimeSeconds: 900,
  mode: 'server',
  components: [
    { name: 'database', status: 'ok', required: true, latencyMs: 0.4, checkedAt: NOW },
    { name: 'storage', status: 'ok', required: true, checkedAt: NOW },
    { name: 'search', status: 'degraded', required: false, detail: 'Meilisearch sidecar unreachable; FTS5 in use.' },
  ],
  library: { items: 0, documents: 0, attachments: 0, collections: 0, countedAt: NOW },
};
