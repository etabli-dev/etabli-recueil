/**
 * Database rows to contract shapes, and back.
 *
 * `packages/core` speaks rows: `lower_snake_case` columns mapped to camelCase properties by
 * Drizzle, with JSON columns still text and mirrored columns (`item_trashed_at`, `parent_key`,
 * `group_scope_key`) still present. `@recueil/schemas` speaks the wire: strict objects with no
 * mirrors and JSON as JSON. This module is the whole of the translation, and it is a module rather
 * than a scattering of object literals for two reasons.
 *
 * First, the schemas are **strict**: one stray key and `parse` throws. Putting every mapping in one
 * place means a column added to `packages/core` fails here, loudly, in one file, rather than in
 * whichever route happened to select it.
 *
 * Second, every response on this surface is parsed through its published schema before it is sent
 * (see `routes/*.ts`). That is not belt and braces — it is the mechanism that keeps the served
 * OpenAPI document and the served bytes the same thing (P6), and it costs microseconds on documents
 * this size.
 */
import type { DecodedFieldValue, ItemCreatorRecord, ItemRecord } from '@recueil/core';
import type { schema } from '@recueil/core';
import type {
  Attachment,
  CustomField,
  BibliographicFacet,
  Collection,
  Creator,
  Document,
  FieldProvenance,
  FieldProvenanceEntry,
  FieldProvenanceMap,
  FieldValue,
  FieldValueContent,
  Item,
  ItemCreator,
  ItemTag,
  Note,
  OfficeFacet,
  Tag,
} from '@recueil/schemas';

/** One observed spelling of a name, as `creators.name_variants` stores it (CONCEPT.md §5.2). */
type NameVariant = NonNullable<Creator['nameVariants']>[number];

/** Parse a JSON column, falling back rather than throwing: a response must not 500 on bad data. */
const parseJson = <TValue>(raw: string | null | undefined, fallback: TValue): TValue => {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as TValue;
  } catch {
    /* c8 ignore next */
    return fallback;
  }
};

/* -------------------------------------------------------------------------------------------- */
/* Provenance                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export const provenanceEntryToWire = (row: schema.FieldProvenanceRow): FieldProvenanceEntry => ({
  source: row.source,
  sourceRecordId: row.sourceRecordId,
  sourceVersion: row.sourceVersion,
  confidence: row.confidence,
  fetchedAt: row.fetchedAt,
  appliedAt: row.appliedAt,
  locked: row.locked,
  lockedAt: row.lockedAt,
  lockedByUserId: row.lockedByUserId,
  previousValue: row.previousValue,
});

export const provenanceToWire = (row: schema.FieldProvenanceRow): FieldProvenance => ({
  id: row.id,
  entityType: row.entityType,
  entityId: row.entityId,
  fieldPath: row.fieldPath,
  ...provenanceEntryToWire(row),
});

export const provenanceMapToWire = (
  rows: Record<string, schema.FieldProvenanceRow>,
): FieldProvenanceMap =>
  Object.fromEntries(
    Object.entries(rows).map(([fieldPath, row]) => [fieldPath, provenanceEntryToWire(row)]),
  );

/* -------------------------------------------------------------------------------------------- */
/* Facets                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export interface FacetContext {
  readonly provenance?: Record<string, schema.FieldProvenanceRow>;
  readonly lockedFields?: readonly string[];
}

export const bibliographicToWire = (
  row: schema.ItemBibliographicRow,
  context: FacetContext = {},
): BibliographicFacet => {
  // `itemId` and `itemTrashedAt` are storage mechanics — the key and the mirror that lets "unique
  // among live items" be a partial index (§1.1) — and have no business on the wire.
  const { itemId: _itemId, itemTrashedAt: _itemTrashedAt, ...facet } = row;
  return {
    ...facet,
    ...(context.provenance === undefined ? {} : { provenance: provenanceMapToWire(context.provenance) }),
    ...(context.lockedFields === undefined ? {} : { lockedFields: [...context.lockedFields] }),
  };
};

export const officeToWire = (row: schema.ItemOfficeRow, context: FacetContext = {}): OfficeFacet => {
  const { itemId: _itemId, itemTrashedAt: _itemTrashedAt, ...facet } = row;
  return {
    ...facet,
    ...(context.provenance === undefined ? {} : { provenance: provenanceMapToWire(context.provenance) }),
    ...(context.lockedFields === undefined ? {} : { lockedFields: [...context.lockedFields] }),
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Item                                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** Everything the API may expand into an item response, each optional and each asked for. */
export interface ItemExpansions {
  readonly creators?: readonly ItemCreatorRecord[];
  readonly tags?: readonly ItemTag[];
  readonly collectionIds?: readonly string[];
  readonly attachments?: readonly schema.AttachmentRow[];
  readonly noteIds?: readonly string[];
  readonly bibliographicContext?: FacetContext;
  readonly officeContext?: FacetContext;
}

export const itemToWire = (record: ItemRecord, expansions: ItemExpansions = {}): Item => {
  const { item } = record;
  return {
    id: item.id,
    publicId: item.publicId,
    ownerUserId: item.ownerUserId,
    libraryState: item.libraryState,
    mergedIntoItemId: item.mergedIntoItemId,
    version: item.version,
    dateAdded: item.dateAdded,
    dateModified: item.dateModified,
    trashedAt: item.trashedAt,
    itemType: item.itemType,
    title: item.title,
    extra: item.extra,
    sourceSystem: item.sourceSystem,
    sourceId: item.sourceId,
    bibliographic:
      record.bibliographic === null
        ? null
        : bibliographicToWire(record.bibliographic, expansions.bibliographicContext ?? {}),
    office: record.office === null ? null : officeToWire(record.office, expansions.officeContext ?? {}),
    ...(expansions.creators === undefined
      ? {}
      : { creators: expansions.creators.map(itemCreatorToWire) }),
    ...(expansions.tags === undefined ? {} : { tags: [...expansions.tags] }),
    ...(expansions.collectionIds === undefined ? {} : { collectionIds: [...expansions.collectionIds] }),
    ...(expansions.attachments === undefined
      ? {}
      : { attachments: expansions.attachments.map(attachmentToWire) }),
    ...(expansions.noteIds === undefined ? {} : { noteIds: [...expansions.noteIds] }),
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Attachments and documents                                                                       */
/* -------------------------------------------------------------------------------------------- */

export const attachmentToWire = (row: schema.AttachmentRow): Attachment => ({
  id: row.id,
  itemId: row.itemId,
  documentId: row.documentId,
  role: row.role,
  linkMode: row.linkMode,
  title: row.title,
  url: row.url,
  linkedPath: row.linkedPath,
  contentTypeHint: row.contentTypeHint,
  hasAnnotations: row.hasAnnotations,
  annotationCount: row.annotationCount,
  position: row.position,
  source: row.source,
  addedAt: row.addedAt,
  addedByUserId: row.addedByUserId,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
});

export const documentToWire = (row: schema.DocumentRow): Document => ({
  id: row.id,
  sha256: row.sha256,
  byteSize: row.byteSize,
  mimeType: row.mimeType,
  mimeSource: row.mimeSource,
  originalFilename: row.originalFilename,
  storageBackend: row.storageBackend,
  storageKey: row.storageKey,
  storageVerifiedAt: row.storageVerifiedAt,
  storageOk: row.storageOk,
  pageCount: row.pageCount,
  hasTextLayer: row.hasTextLayer,
  textExtractedAt: row.textExtractedAt,
  textCharCount: row.textCharCount,
  ocrStatus: row.ocrStatus,
  simhash: row.simhash,
  sourceKind: row.sourceKind,
  sourceRef: row.sourceRef,
  sourceDetail: parseJson<Record<string, never>>(row.sourceDetail, {}),
  parentDocumentId: row.parentDocumentId,
  ingestedAt: row.ingestedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
});

/* -------------------------------------------------------------------------------------------- */
/* Organisation                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export const collectionToWire = (
  row: schema.CollectionRow,
  extra: { itemCount?: number } = {},
): Collection => ({
  id: row.id,
  publicId: row.publicId,
  name: row.name,
  nameNormalised: row.nameNormalised,
  parentId: row.parentId,
  ownerUserId: row.ownerUserId,
  kind: row.kind,
  query: row.query === null ? null : parseJson<Record<string, never>>(row.query, {}),
  queryBackend: row.queryBackend,
  description: row.description,
  colour: row.colour,
  depth: row.depth,
  position: row.position,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
  ...(extra.itemCount === undefined ? {} : { itemCount: extra.itemCount }),
});

export const tagToWire = (row: schema.TagRow): Tag => ({
  id: row.id,
  name: row.name,
  nameNormalised: row.nameNormalised,
  colour: row.colour,
  scheme: row.scheme,
  ownerUserId: row.ownerUserId,
  position: row.position,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
});

export const noteToWire = (row: schema.NoteRow): Note => ({
  id: row.id,
  publicId: row.publicId,
  ownerUserId: row.ownerUserId,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
  itemId: row.itemId,
  parentAnnotationId: row.parentAnnotationId,
  title: row.title,
  contentMarkdown: row.contentMarkdown,
  sourceFormat: row.sourceFormat,
  contentOriginal: row.contentOriginal,
  noteKind: row.noteKind,
});

/* -------------------------------------------------------------------------------------------- */
/* Creators                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export const creatorToWire = (row: schema.CreatorRow): Creator => ({
  id: row.id,
  kind: row.kind,
  familyName: row.familyName,
  givenName: row.givenName,
  namePrefix: row.namePrefix,
  nameSuffix: row.nameSuffix,
  literalName: row.literalName,
  displayName: row.displayName,
  sortName: row.sortName,
  initials: row.initials,
  nameVariants: parseJson<NameVariant[]>(row.nameVariants, []),
  orcid: row.orcid,
  openalexAuthorId: row.openalexAuthorId,
  semanticScholarAuthorId: row.semanticScholarAuthorId,
  scopusAuthorId: row.scopusAuthorId,
  researcherId: row.researcherId,
  isni: row.isni,
  viaf: row.viaf,
  ror: row.ror,
  wikidataId: row.wikidataId,
  disambiguationStatus: row.disambiguationStatus,
  mergedIntoCreatorId: row.mergedIntoCreatorId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  trashedAt: row.trashedAt,
});

export const itemCreatorToWire = (record: ItemCreatorRecord): ItemCreator => {
  const { appearance } = record;
  return {
    ordinal: appearance.ordinal,
    creatorId: appearance.creatorId,
    role: appearance.role,
    rawName: appearance.rawName,
    affiliationRaw: appearance.affiliationRaw,
    affiliationRor: appearance.affiliationRor,
    affiliationCreatorId: appearance.affiliationCreatorId,
    countryCode: appearance.countryCode,
    isCorresponding: appearance.isCorresponding,
    contributionRoles: parseJson<string[] | null>(appearance.contributionRoles, null),
    createdAt: appearance.createdAt,
    creator: creatorToWire(record.creator),
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Custom fields                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export const customFieldToWire = (row: schema.CustomFieldRow): CustomField => ({
  id: row.id,
  fieldKey: row.fieldKey,
  name: row.name,
  description: row.description,
  dataType: row.dataType,
  config: parseJson<Record<string, never>>(row.config, {}),
  appliesToItemTypes: parseJson<string[] | null>(row.appliesToItemTypes, null),
  isRequired: row.isRequired,
  isRepeatable: row.isRepeatable,
  scope: row.scope,
  position: row.position,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const fieldValueToWire = (decoded: DecodedFieldValue): FieldValue => ({
  id: decoded.row.id,
  fieldId: decoded.row.fieldId,
  fieldKey: decoded.field.fieldKey,
  itemId: decoded.row.itemId,
  groupKey: decoded.row.groupKey,
  ordinal: decoded.row.ordinal,
  content: decoded.content as FieldValueContent | null,
  isBlank: decoded.row.isBlank,
  createdAt: decoded.row.createdAt,
  updatedAt: decoded.row.updatedAt,
  createdByUserId: decoded.row.createdByUserId,
});
