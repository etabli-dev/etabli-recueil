/**
 * The schemas this server adds to the shared contract.
 *
 * `@recueil/schemas` owns the *entities* — an Item, a Collection, a problem document — because they
 * are the data model and every client of it needs the same shapes. What it deliberately does not
 * own is the shape of a *response*: a page of item summaries, the outcome of a facet write, the
 * body of a token-creation call. Those are properties of this HTTP surface, they arrive with the
 * routes that serve them, and they belong here.
 *
 * Every one of them is registered as an OpenAPI component through its `id` meta, so the generated
 * document names them and a generated client gets real types rather than inline anonymous objects.
 *
 * Two conventions run through the file:
 *
 * - **Pages, not arrays.** Every list response is `{ data, page }` even where the underlying list is
 *   small and unpaged, so a client has one shape to handle (`pageOf`, `http.ts` `wholeList`).
 * - **Requests are strict.** A misspelled field in a write is a silent no-op if the schema is
 *   permissive, and a silent no-op in a metadata editor is a lost afternoon.
 */
import {
  AttachmentRoleSchema,
  AttachmentSchema,
  BibliographicFacetUpdateSchema,
  CollectionSchema,
  ConfidenceSchema,
  CreatorSchema,
  CustomFieldSchema,
  DocumentSchema,
  FieldPathSchema,
  FieldProvenanceMapSchema,
  FieldValueContentSchema,
  FieldValueSchema,
  IdSchema,
  ItemCreatorSchema,
  ItemSchema,
  ItemSummarySchema,
  ItemTagSchema,
  LockedFieldsSchema,
  NoteSchema,
  OfficeFacetUpdateSchema,
  ProvenanceSourceSchema,
  PublicIdSchema,
  ShortTextSchema,
  TagSchema,
  TimestampSchema,
  pageOf,
} from '@recueil/schemas';
import * as z from 'zod';

/* -------------------------------------------------------------------------------------------- */
/* Pages                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Most pages are already in the contract.
 *
 * `@recueil/schemas` registers `ItemPage`, `CollectionPage`, `TagPage` and the rest as components
 * precisely so that the routes that serve them do not each invent one — and a second schema with
 * the same component id is a generation error, not a duplicate definition that quietly wins. They
 * are re-exported here so a route module has one import for its response shapes.
 *
 * `ItemPage` is a page of `ItemSummary`, not of `Item`: a list returns enough to render a library
 * row and a fetch returns the whole record (see `routes/items.ts`).
 */
export {
  AttachmentPageSchema,
  CollectionPageSchema,
  CreatorPageSchema,
  CustomFieldPageSchema,
  DocumentPageSchema,
  FieldValuePageSchema,
  ItemPageSchema as ItemSummaryPageSchema,
  NotePageSchema,
  TagPageSchema,
} from '@recueil/schemas';

/** The two pages this surface adds: an item's author list, and an item's tags. */
export const ItemCreatorPageSchema = pageOf(ItemCreatorSchema, { id: 'ItemCreatorPage' });
export const ItemTagPageSchema = pageOf(ItemTagSchema, { id: 'ItemTagPage' });

/* -------------------------------------------------------------------------------------------- */
/* Collections                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * A node of the collection tree.
 *
 * Recursive, and therefore declared with `z.lazy` through a single stable instance: a lazy schema
 * rebuilt on every access renders as a fresh anonymous component each time it is reached, and the
 * document ends up with a `__schema0` per level of nesting.
 */
export interface CollectionNodeShape {
  collection: z.infer<typeof CollectionSchema>;
  children: CollectionNodeShape[];
}

export const CollectionNodeSchema: z.ZodType<CollectionNodeShape> = z.lazy(() =>
  z.strictObject({ collection: CollectionSchema, children: z.array(CollectionNodeSchema) }),
).meta({
  id: 'CollectionNode',
  title: 'CollectionNode',
  description: 'A collection with its children — the shape a sidebar renders.',
});

export const CollectionTreeSchema = z
  .strictObject({ data: z.array(CollectionNodeSchema) })
  .meta({ id: 'CollectionTree', title: 'CollectionTree' });

export const CollectionMoveSchema = z
  .strictObject({
    parentId: IdSchema.nullable().meta({
      description: 'The new parent, or null to make this a root. A cycle is refused (C1).',
    }),
  })
  .meta({ id: 'CollectionMove', title: 'CollectionMove', unusedIO: 'input' });

export const CollectionMembershipChangeSchema = z
  .strictObject({
    itemIds: z.array(IdSchema).min(1).max(1000),
    source: z
      .enum(['manual', 'rule', 'import', 'connector', 'merge', 'plugin'])
      .optional()
      .meta({ description: 'Why the items are being filed. Defaults to `manual` (P4).' }),
  })
  .meta({ id: 'CollectionMembershipChange', title: 'CollectionMembershipChange', unusedIO: 'input' });

export const MembershipResultSchema = z
  .strictObject({
    collectionId: IdSchema,
    changed: z.number().int().min(0).meta({ description: 'How many memberships actually moved.' }),
  })
  .meta({ id: 'MembershipResult', title: 'MembershipResult' });

/* -------------------------------------------------------------------------------------------- */
/* Facets and provenance                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Where a write's values came from. A resolver sends this; a person editing by hand does not. */
export const ProvenanceStampSchema = z
  .strictObject({
    source: ProvenanceSourceSchema,
    sourceRecordId: z.string().max(512).nullish(),
    sourceVersion: z.string().max(128).nullish(),
    confidence: ConfidenceSchema.nullish(),
    fetchedAt: TimestampSchema.optional(),
    locked: z
      .boolean()
      .optional()
      .meta({
        description:
          'Override the default, which is "manual writes lock and automated writes do not" (P4-1).',
      }),
  })
  .meta({
    id: 'ProvenanceStamp',
    title: 'ProvenanceStamp',
    description: 'The source a facet write is attributed to. Omit it and the write is `manual` and locks (P4-1).',
    unusedIO: 'input',
  });

export const FacetWriteRequestSchema = z
  .strictObject({
    values: BibliographicFacetUpdateSchema.meta({ description: 'The fields to write. Partial.' }),
    provenance: ProvenanceStampSchema.optional(),
  })
  .meta({ id: 'BibliographicWriteRequest', title: 'BibliographicWriteRequest', unusedIO: 'input' });

export const OfficeWriteRequestSchema = z
  .strictObject({
    values: OfficeFacetUpdateSchema,
    provenance: ProvenanceStampSchema.optional(),
  })
  .meta({ id: 'OfficeWriteRequest', title: 'OfficeWriteRequest', unusedIO: 'input' });

export const SkippedFieldSchema = z
  .strictObject({
    fieldPath: FieldPathSchema,
    lockedBy: z.string().max(96).meta({ description: 'The source of the value protecting the field.' }),
    lockedAt: TimestampSchema.nullable(),
  })
  .meta({
    id: 'SkippedField',
    title: 'SkippedField',
    description: 'A field a manual lock refused to let an automated write touch (P4-2, P4-4).',
  });

export const FacetWriteResultSchema = z
  .strictObject({
    item: ItemSchema,
    applied: z.array(FieldPathSchema).max(512).meta({ description: 'The fields actually written.' }),
    skipped: z.array(SkippedFieldSchema).max(512),
  })
  .meta({
    id: 'FacetWriteResult',
    title: 'FacetWriteResult',
    description:
      'The outcome of a facet write. `skipped` is not an error: a run that overwrites nothing and ' +
      'says nothing would be the bug (P4-4).',
  });

export const ItemProvenanceSchema = z
  .strictObject({
    itemId: IdSchema,
    bibliographic: FieldProvenanceMapSchema,
    office: FieldProvenanceMapSchema,
    lockedFields: LockedFieldsSchema,
  })
  .meta({
    id: 'ItemProvenance',
    title: 'ItemProvenance',
    description: 'Per-field provenance for both facets of one item, and the locks over them (P4, §3.6).',
  });

export const FieldLockRequestSchema = z
  .strictObject({
    facet: z.enum(['bibliographic', 'office']).optional().meta({ description: 'Defaults to `bibliographic`.' }),
    fieldPath: FieldPathSchema,
  })
  .meta({ id: 'FieldLockRequest', title: 'FieldLockRequest', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* Creators, tags, field values on an item                                                         */
/* -------------------------------------------------------------------------------------------- */

export const ItemCreatorWriteSchema = z
  .strictObject({
    creators: z
      .array(
        z.strictObject({
          creatorId: IdSchema,
          role: z
            .enum([
              'author',
              'editor',
              'translator',
              'contributor',
              'series_editor',
              'recipient',
              'interviewer',
              'director',
              'reviewed_author',
              'sender',
              'correspondent',
            ])
            .optional(),
          rawName: ShortTextSchema.nullish(),
          affiliationRaw: ShortTextSchema.nullish(),
          affiliationRor: z.string().max(16).nullish(),
          affiliationCreatorId: IdSchema.nullish(),
          countryCode: z.string().length(2).nullish(),
          isCorresponding: z.boolean().optional(),
          contributionRoles: z.array(z.string().max(64)).max(32).nullish(),
        }),
      )
      .max(10_000)
      .meta({
        description:
          'The whole author list, in order. The server assigns the dense ordinal block in one ' +
          'transaction, so a client never computes positions (IC1).',
      }),
  })
  .meta({ id: 'ItemCreatorWrite', title: 'ItemCreatorWrite', unusedIO: 'input' });

export const ItemTagWriteSchema = z
  .strictObject({
    tagNames: z.array(ShortTextSchema).max(1000).meta({
      description: 'The complete tag set for this item, by name. Unknown names are created.',
    }),
    source: z
      .enum(['manual', 'rule', 'resolver', 'import', 'plugin', 'merge'])
      .optional()
      .meta({ description: 'Why the tags are being applied. Defaults to `manual` (P4).' }),
  })
  .meta({ id: 'ItemTagWrite', title: 'ItemTagWrite', unusedIO: 'input' });

export const FieldValueWriteSchema = z
  .strictObject({
    content: FieldValueContentSchema.nullish(),
    groupKey: z.string().max(128).nullish(),
    ordinal: z.number().int().min(0).optional(),
    isBlank: z
      .boolean()
      .optional()
      .meta({ description: 'An explicit "not reported", which is a different fact from "not extracted".' }),
  })
  .meta({ id: 'FieldValueWrite', title: 'FieldValueWrite', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* Attachments                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export const AttachDocumentSchema = z
  .strictObject({
    documentId: IdSchema,
    role: AttachmentRoleSchema.optional().meta({ description: 'Defaults to `primary`.' }),
    title: ShortTextSchema.nullish().meta({ description: 'Defaults to the document filename.' }),
  })
  .meta({ id: 'AttachDocument', title: 'AttachDocument', unusedIO: 'input' });

export const AttachmentOrderSchema = z
  .strictObject({
    attachmentIds: z.array(IdSchema).max(1000).meta({
      description:
        'The ids in the order wanted. Any live attachment left out keeps its relative order ' +
        'after the ones named.',
    }),
  })
  .meta({ id: 'AttachmentOrder', title: 'AttachmentOrder', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* Documents                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export const DocumentUploadResultSchema = z
  .strictObject({
    document: DocumentSchema,
    /**
     * The half of ADR-0004 a client cares about: were these bytes already here?
     */
    created: z
      .boolean()
      .meta({
        description:
          'False when the SHA-256 was already in the library: the existing document was linked and ' +
          'no second copy was stored (D1, CONCEPT.md §5.3 stage 2).',
      }),
    blobWritten: z.boolean().meta({ description: 'False when the store already held these bytes.' }),
    attachmentId: IdSchema.nullable().meta({ description: 'Set when the upload named an item to attach to.' }),
  })
  .meta({
    id: 'DocumentUploadResult',
    title: 'DocumentUploadResult',
    description:
      'The outcome of an upload. A client that sees `created: false` has learnt that its file was ' +
      'a duplicate without having to ask a second question.',
  });

/* -------------------------------------------------------------------------------------------- */
/* Search                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const SearchHitSchema = z
  .strictObject({
    entityType: z.enum(['item', 'note', 'document']),
    entityId: IdSchema,
    itemId: IdSchema.nullable().meta({ description: 'The item this hit belongs to, when it is not itself one.' }),
    score: z.number().meta({ description: 'BM25. Lower is better. A rank, not a percentage.' }),
    snippet: z
      .string()
      .max(4096)
      .nullable()
      .meta({ description: 'A fragment of the matching field, with the matched words marked by « and ».' }),
  })
  .meta({ id: 'SearchHit', title: 'SearchHit' });

export const SearchResponseSchema = z
  .strictObject({
    query: z.string().max(2048),
    expression: z
      .string()
      .max(8192)
      .meta({ description: 'The compiled FTS5 expression, so a result set can be explained (ADR-0011).' }),
    hits: z.array(SearchHitSchema).max(500),
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().min(0),
  })
  .meta({ id: 'SearchResponse', title: 'SearchResponse' });

/* -------------------------------------------------------------------------------------------- */
/* Trash                                                                                           */
/* -------------------------------------------------------------------------------------------- */

export const TrashEntrySchema = z
  .strictObject({
    id: IdSchema,
    entityType: z.enum([
      'item',
      'document',
      'attachment',
      'collection',
      'note',
      'annotation',
      'tag',
      'creator',
      'review',
      'curated_network',
    ]),
    entityId: IdSchema,
    groupId: IdSchema.nullable().meta({ description: 'Groups the rows one cascading trash wrote.' }),
    trashedAt: TimestampSchema,
    trashedByUserId: IdSchema.nullable(),
    reason: z.enum(['user', 'merge', 'import_rollback', 'cascade', 'plugin']),
    reasonDetail: z.string().max(1024).nullable(),
    mergeTargetItemId: IdSchema.nullable(),
    expiresAt: TimestampSchema.nullable(),
    restoredAt: TimestampSchema.nullable(),
    purgedAt: TimestampSchema.nullable(),
  })
  .meta({
    id: 'TrashEntry',
    title: 'TrashEntry',
    description: 'One record in the bin. Nothing is deleted; a purge is explicit and separate (P5, TR2).',
  });

export const TrashPageSchema = pageOf(TrashEntrySchema, { id: 'TrashPage' });

export const TrashSummarySchema = z
  .strictObject({ counts: z.record(z.string(), z.number().int().min(0)) })
  .meta({ id: 'TrashSummary', title: 'TrashSummary' });

/* -------------------------------------------------------------------------------------------- */
/* Trash / restore request                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const TrashRequestSchema = z
  .strictObject({
    reason: z.enum(['user', 'merge', 'import_rollback', 'cascade', 'plugin']).optional(),
    reasonDetail: z.string().max(1024).optional(),
  })
  .meta({ id: 'TrashRequest', title: 'TrashRequest', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* Tokens                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const TokenClientSchema = z
  .enum(['cli', 'mcp', 'connector', 'r', 'python', 'web_session', 'bib_feed', 'other'])
  .meta({ id: 'TokenClient' });

export const ApiTokenSchema = z
  .strictObject({
    id: IdSchema,
    userId: IdSchema,
    name: ShortTextSchema,
    tokenPrefix: z
      .string()
      .max(32)
      .meta({ description: 'The first twelve characters of the secret. Enough to identify, not to use.' }),
    scopes: z.array(z.string().max(64)).max(64),
    client: TokenClientSchema,
    createdAt: TimestampSchema,
    createdByUserId: IdSchema.nullable(),
    expiresAt: TimestampSchema.nullable(),
    lastUsedAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    note: z.string().max(1024).nullable(),
  })
  .meta({
    id: 'ApiToken',
    title: 'ApiToken',
    description: 'A scoped bearer credential. The secret is not here and cannot be recovered (§3.2).',
  });

export const ApiTokenPageSchema = pageOf(ApiTokenSchema, { id: 'ApiTokenPage' });

export const ApiTokenCreateSchema = z
  .strictObject({
    name: ShortTextSchema.meta({ description: 'How the token is identified when it is revoked.' }),
    client: TokenClientSchema.optional().meta({ description: 'Defaults to `other`.' }),
    scopes: z
      .array(z.string().max(64))
      .max(64)
      .optional()
      .meta({ description: "Defaults to `['admin:*']`. A `bib_feed` token may hold read scopes only (A2)." }),
    expiresAt: TimestampSchema.nullish(),
    note: z.string().max(1024).nullish(),
  })
  .meta({ id: 'ApiTokenCreate', title: 'ApiTokenCreate', unusedIO: 'input' });

export const ApiTokenCreatedSchema = z
  .strictObject({
    token: ApiTokenSchema,
    secret: z
      .string()
      .max(128)
      .meta({
        description:
          'The secret, in the clear, for the only time it will ever be shown. The server stores ' +
          'its SHA-256 and cannot reproduce it (§3.2).',
      }),
  })
  .meta({ id: 'ApiTokenCreated', title: 'ApiTokenCreated' });

/* -------------------------------------------------------------------------------------------- */
/* Export                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const EXPORT_FORMATS = ['bibtex', 'biblatex', 'ris', 'csl-json'] as const;

export const ExportFormatSchema = z.enum(EXPORT_FORMATS).meta({
  id: 'ExportFormat',
  description: 'The serialisation formats of CONCEPT.md §5.11.',
});

export const LossEntrySchema = z
  .strictObject({
    direction: z.enum(['export', 'import']),
    format: z.string().max(32),
    recordIndex: z.number().int().min(0).meta({ description: 'Zero-based position of the record in the batch.' }),
    recordKey: z
      .string()
      .max(255)
      .optional()
      .meta({ description: 'The entry key — the human handle for the row — when the record has one.' }),
    field: z.string().max(128),
    reason: z.string().max(512),
    value: z.string().max(1024).optional(),
  })
  .meta({
    id: 'LossEntry',
    title: 'LossEntry',
    description: 'One thing a format could not carry. P10: what is dropped is reported, never silently lost.',
  });

export const ExportReportSchema = z
  .strictObject({
    format: ExportFormatSchema,
    recordCount: z.number().int().min(0),
    losses: z.array(LossEntrySchema).max(10_000),
  })
  .meta({ id: 'ExportReport', title: 'ExportReport' });

/* -------------------------------------------------------------------------------------------- */
/* Events                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const LifecycleEventSchema = z
  .strictObject({
    id: IdSchema,
    type: z.enum([
      'item.created',
      'item.updated',
      'item.merged',
      'item.trashed',
      'item.restored',
      'document.ingested',
      'attachment.added',
      'annotation.created',
      'check.completed',
      'job.started',
      'job.finished',
      'job.failed',
    ]),
    occurredAt: TimestampSchema,
    sequence: z.number().int().min(1),
    actor: z.record(z.string(), z.unknown()),
    requestId: z.string().max(128).optional(),
    causationId: IdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .meta({
    id: 'LifecycleEvent',
    title: 'LifecycleEvent',
    description:
      'One event envelope as `spec/hooks.md` §7.1 defines it, delivered as the `data` of a ' +
      'Server-Sent Event whose `event:` field is the type.',
  });

/* -------------------------------------------------------------------------------------------- */
/* Connector (ADR-0006)                                                                            */
/* -------------------------------------------------------------------------------------------- */

export const ConnectorPingResponseSchema = z
  .strictObject({
    prefs: z.record(z.string(), z.unknown()),
  })
  .meta({
    id: 'ConnectorPingResponse',
    title: 'ConnectorPingResponse',
    description: "The handshake the Zotero Connector expects from a client on port 23119 (ADR-0006).",
  });

/**
 * One row of the connector's save-target picker.
 *
 * `id` is Zotero's `treeViewID`: `L<libraryID>` for a library, `C<collectionID>` for a collection.
 * `level` is the indent depth, 0 for a library. Shape taken from the client's own response builder,
 * captured verbatim in `fixtures/zotero-connector/server_connector.GetSelectedCollection.js`.
 */
const ConnectorSaveTargetSchema = z
  .looseObject({
    id: z.string().max(64),
    name: z.string().max(255),
    filesEditable: z.boolean(),
    level: z.number().int().min(0),
    recent: z.boolean().optional(),
  })
  .meta({ id: 'ConnectorSaveTarget', title: 'ConnectorSaveTarget' });

export const ConnectorCollectionResponseSchema = z
  .strictObject({
    libraryID: z.union([z.number(), z.string()]),
    libraryName: z.string().max(255),
    libraryEditable: z.boolean(),
    editable: z.boolean(),
    id: z.string().max(64).nullable(),
    name: z.string().max(255),
    filesEditable: z.boolean().optional(),
    /**
     * Required, not optional. The extension does `response.targets.filter(…)` with no guard —
     * `progressWindow_inject.js` line 153 at `c279ccc` — so omitting it throws a `TypeError` in the
     * progress window on every capture.
     */
    targets: z.array(ConnectorSaveTargetSchema),
    /** Tag autocomplete, keyed by `treeViewID`. Sent because `ping` advertises the capability. */
    tags: z.record(z.string(), z.array(z.looseObject({ tag: z.string() }))),
  })
  .meta({
    id: 'ConnectorCollectionResponse',
    title: 'ConnectorCollectionResponse',
    description: 'Where a save from the browser will land (ADR-0006).',
  });

export const ConnectorSaveItemsResponseSchema = z
  .strictObject({ items: z.array(z.record(z.string(), z.unknown())) })
  .meta({ id: 'ConnectorSaveItemsResponse', title: 'ConnectorSaveItemsResponse' });

/* -------------------------------------------------------------------------------------------- */
/* Miscellaneous                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export const PublicIdRefSchema = z.strictObject({ key: PublicIdSchema });

export const MergeRequestSchema = z
  .strictObject({
    loserId: IdSchema.meta({ description: 'The record that loses. It goes to the trash, reversibly (P5).' }),
  })
  .meta({ id: 'MergeRequest', title: 'MergeRequest', unusedIO: 'input' });

export const TagMergeResultSchema = z
  .strictObject({ winner: TagSchema, moved: z.number().int().min(0) })
  .meta({ id: 'TagMergeResult', title: 'TagMergeResult' });

export const CreatorMergeResultSchema = z
  .strictObject({ winner: CreatorSchema, movedAppearances: z.number().int().min(0) })
  .meta({ id: 'CreatorMergeResult', title: 'CreatorMergeResult' });
