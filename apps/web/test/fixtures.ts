/**
 * Fixture records, built to the contract.
 *
 * Every fixture here is typed as the schema type it stands for, so a change to `@recueil/schemas`
 * breaks these files at compile time rather than producing tests that pass against a shape the
 * server no longer sends. That is the point of fixtures in a repository whose contract is the
 * product (P6).
 */
import type {
  Attachment,
  Collection,
  CustomField,
  FieldValue,
  Item,
  ItemSummary,
  Note,
  Page,
  ProblemDetails,
  Tag,
} from '@recueil/schemas';

const NOW = '2026-08-22T09:15:00.000Z';

export const id = (suffix: string): string => `01J8F3Z9K4${suffix.toUpperCase().padEnd(16, '0')}`.slice(0, 26);

export const itemSummary = (overrides: Partial<ItemSummary> & { id: string }): ItemSummary => ({
  publicId: 'A1B2C3D4',
  itemType: 'article',
  title: 'An untitled work',
  creatorSummary: 'Ravaud et al.',
  issuedYear: 2019,
  containerTitle: 'BMJ',
  attachmentCount: 1,
  dateModified: NOW,
  ...overrides,
});

export const page = <TValue>(data: TValue[], nextCursor: string | null = null, total?: number): Page<TValue> => ({
  data,
  page: {
    nextCursor,
    hasMore: nextCursor !== null,
    limit: 25,
    ...(total === undefined ? {} : { total }),
  },
});

export const ITEM_ID = id('ITEM01');
export const ATTACHMENT_ID = id('ATT001');

/**
 * One item, expanded, with a locked DOI.
 *
 * The DOI carries `source: 'manual'` and `locked: true` — the provenance row a hand edit writes
 * (P4-1) — and `title` carries a resolver's unlocked row beside it, so the two states are both on
 * screen in the same pane.
 */
export const expandedItem = (overrides: Partial<Item> = {}): Item => ({
  id: ITEM_ID,
  publicId: 'A1B2C3D4',
  ownerUserId: id('USER01'),
  libraryState: 'normal',
  version: 7,
  dateAdded: '2026-01-04T10:00:00.000Z',
  dateModified: NOW,
  itemType: 'article',
  title: 'Attrition bias in randomised trials',
  bibliographic: {
    title: 'Attrition bias in randomised trials',
    containerTitle: 'BMJ',
    doi: '10.1136/bmj.n71',
    issuedDate: '2019',
    issuedYear: 2019,
    volume: '365',
    retractionStatus: 'none',
    verificationStatus: 'verified',
    createdAt: '2026-01-04T10:00:00.000Z',
    updatedAt: NOW,
    lockedFields: ['doi'],
    provenance: {
      doi: {
        source: 'manual',
        fetchedAt: NOW,
        appliedAt: NOW,
        locked: true,
        lockedAt: NOW,
      },
      title: {
        source: 'crossref',
        confidence: 0.98,
        fetchedAt: '2026-01-04T10:00:00.000Z',
        appliedAt: '2026-01-04T10:00:00.000Z',
        locked: false,
      },
    },
  },
  creators: [
    {
      ordinal: 0,
      creatorId: id('CRE001'),
      role: 'author',
      rawName: 'Ravaud, Philippe',
      affiliationRaw: 'Université Paris Cité',
      createdAt: NOW,
    },
  ],
  tags: [
    {
      tagId: id('TAG001'),
      name: 'methods',
      colour: '#ffd400',
      source: 'manual',
      addedAt: NOW,
    },
  ],
  collectionIds: [id('COL001')],
  attachments: [attachment()],
  noteIds: [],
  ...overrides,
});

export const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: ATTACHMENT_ID,
  itemId: ITEM_ID,
  documentId: id('DOC001'),
  role: 'primary',
  linkMode: 'stored',
  title: 'Ravaud 2019.pdf',
  hasAnnotations: false,
  annotationCount: 0,
  position: 0,
  source: 'manual',
  addedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const collection = (overrides: Partial<Collection> & { id: string; name: string }): Collection => ({
  publicId: 'C1C2C3C4',
  nameNormalised: overrides.name.toLowerCase(),
  ownerUserId: id('USER01'),
  depth: 0,
  createdAt: NOW,
  updatedAt: NOW,
  kind: 'manual',
  position: 0,
  ...overrides,
});

export const tag = (overrides: Partial<Tag> & { id: string; name: string }): Tag => ({
  nameNormalised: overrides.name.toLowerCase(),
  ownerUserId: id('USER01'),
  createdAt: NOW,
  updatedAt: NOW,
  scheme: 'manual',
  position: 0,
  ...overrides,
});

export const note = (overrides: Partial<Note> & { id: string }): Note => ({
  publicId: 'N1N2N3N4',
  ownerUserId: id('USER01'),
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  contentMarkdown: 'A note about the trial.',
  sourceFormat: 'markdown',
  noteKind: 'note',
  ...overrides,
});

export const customField = (overrides: Partial<CustomField> & { id: string; fieldKey: string; name: string }): CustomField => ({
  dataType: 'text',
  createdAt: NOW,
  updatedAt: NOW,
  config: {},
  isRequired: false,
  isRepeatable: false,
  scope: 'library',
  position: 0,
  ...overrides,
});

export const fieldValue = (overrides: Partial<FieldValue> & { id: string; fieldId: string }): FieldValue => ({
  itemId: ITEM_ID,
  createdAt: NOW,
  updatedAt: NOW,
  ordinal: 0,
  isBlank: false,
  content: { type: 'text', value: 'recorded' },
  ...overrides,
});

/** The problem document the error-state test asserts is rendered in full. */
export const problem = (overrides: Partial<ProblemDetails> = {}): ProblemDetails => ({
  type: 'https://recueil.org/problems/unavailable',
  title: 'Service unavailable',
  status: 503,
  detail: 'The content-addressed store at /var/lib/recueil/storage is not writable.',
  instance: '/api/v1/items',
  traceId: 'req-8f2c11',
  ...overrides,
});
