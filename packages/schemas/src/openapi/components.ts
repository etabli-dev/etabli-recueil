/**
 * The component registry: every schema that appears in `components.schemas` of the generated
 * OpenAPI document.
 *
 * The name of a component is not written twice. Each schema already carries its name in
 * `.meta({ id })`, and this module reads it back out of Zod's global registry, so a schema whose
 * id was dropped in a refactor fails the build here instead of silently landing in the document
 * under a made-up name.
 */
import * as z from 'zod';

import {
  AnnotationCreateSchema,
  AnnotationSchema,
  AnnotationSelectorSchema,
  AnnotationSelectorSetSchema,
  AnnotationUpdateSchema,
  FragmentSelectorSchema,
  InkSelectorSchema,
  RectangleSelectorSchema,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  TextualBodySchema,
  WebAnnotationSchema,
} from '../entities/annotation.js';
import {
  AttachmentCreateSchema,
  AttachmentSchema,
  AttachmentUpdateSchema,
} from '../entities/attachment.js';
import {
  ArxivIdSchema,
  BibliographicFacetCreateSchema,
  BibliographicFacetSchema,
  BibliographicFacetUpdateSchema,
  BibliographicIdentifiersSchema,
  DoiSchema,
  IsbnSchema,
  IssnSchema,
  OpenAlexWorkIdSchema,
  PmcidSchema,
  PmidSchema,
  SemanticScholarPaperIdSchema,
} from '../entities/bibliographic.js';
import {
  CollectionCreateSchema,
  CollectionMembershipSchema,
  CollectionSchema,
  CollectionUpdateSchema,
} from '../entities/collection.js';
import {
  CreatorCreateSchema,
  CreatorSchema,
  CreatorUpdateSchema,
  ItemCreatorInputSchema,
  ItemCreatorSchema,
  NameVariantSchema,
  OrcidSchema,
  RorSchema,
} from '../entities/creator.js';
import {
  CustomFieldCreateSchema,
  CustomFieldSchema,
  CustomFieldUpdateSchema,
  FieldKeySchema,
  FieldValueContentSchema,
  FieldValueCreateSchema,
  FieldValueSchema,
  FieldValueUpdateSchema,
} from '../entities/custom-field.js';
import {
  DocumentCreateSchema,
  DocumentSchema,
  DocumentUpdateSchema,
  MimeTypeSchema,
} from '../entities/document.js';
import {
  ItemCreateSchema,
  ItemSchema,
  ItemSummarySchema,
  ItemUpdateSchema,
} from '../entities/item.js';
import { NoteCreateSchema, NoteSchema, NoteUpdateSchema } from '../entities/note.js';
import {
  OfficeFacetCreateSchema,
  OfficeFacetSchema,
  OfficeFacetUpdateSchema,
} from '../entities/office.js';
import { ItemTagSchema, TagCreateSchema, TagSchema, TagUpdateSchema } from '../entities/tag.js';
import {
  BulkOperationOutcomeSchema,
  BulkOperationVerbSchema,
  BulkResultSchema,
  IdempotencyKeySchema,
} from '../envelopes/bulk.js';
import {
  ComponentHealthSchema,
  HealthResponseSchema,
  HealthStatusSchema,
  LibrarySummarySchema,
} from '../envelopes/health.js';
import {
  CursorSchema,
  PageInfoSchema,
  PageParamsSchema,
  SortDirectionSchema,
  pageOf,
} from '../envelopes/pagination.js';
import { ProblemDetailsSchema, ProblemErrorSchema } from '../envelopes/problem.js';
import {
  CalendarDateSchema,
  ConfidenceSchema,
  CountryCodeSchema,
  CurrencyCodeSchema,
  EdtfDateSchema,
  HexColourSchema,
  IdSchema,
  JsonObjectSchema,
  JsonValueSchema,
  LanguageTagSchema,
  PublicIdSchema,
  Sha256Schema,
  SimhashSchema,
  TimestampSchema,
  UrlSchema,
} from '../primitives.js';
import {
  FieldPathSchema,
  FieldProvenanceEntrySchema,
  FieldProvenanceMapSchema,
  FieldProvenanceSchema,
  LockedFieldsSchema,
} from '../provenance.js';
import {
  AnnotationBodyFormatSchema,
  AnnotationMotivationSchema,
  AnnotationTypeSchema,
  AssignmentSourceSchema,
  AttachmentLinkModeSchema,
  AttachmentRoleSchema,
  AttachmentSourceSchema,
  CollectionKindSchema,
  CoreItemTypeSchema,
  CoreOfficeDocumentTypeSchema,
  CreatorKindSchema,
  CreatorRoleSchema,
  CustomFieldDataTypeSchema,
  CustomFieldScopeSchema,
  DisambiguationStatusSchema,
  DocumentSourceKindSchema,
  ItemTypeSchema,
  LibraryStateSchema,
  MimeSourceSchema,
  NoteKindSchema,
  NoteSourceFormatSchema,
  OaStatusSchema,
  OcrStatusSchema,
  OfficeDocumentTypeSchema,
  ProvenanceEntityTypeSchema,
  ProvenanceSourceSchema,
  QueryBackendSchema,
  RetractionStatusSchema,
  StorageBackendSchema,
  TagSchemeSchema,
  VerificationStatusSchema,
} from '../vocabularies.js';

/** The paged responses Phase 1 will serve. Named here so the component list is complete now. */
export const ItemPageSchema = pageOf(ItemSummarySchema, {
  id: 'ItemPage',
  description: 'A page of item summaries.',
});
export const CollectionPageSchema = pageOf(CollectionSchema, { id: 'CollectionPage' });
export const TagPageSchema = pageOf(TagSchema, { id: 'TagPage' });
export const DocumentPageSchema = pageOf(DocumentSchema, { id: 'DocumentPage' });
export const AttachmentPageSchema = pageOf(AttachmentSchema, { id: 'AttachmentPage' });
export const NotePageSchema = pageOf(NoteSchema, { id: 'NotePage' });
export const AnnotationPageSchema = pageOf(AnnotationSchema, { id: 'AnnotationPage' });
export const CreatorPageSchema = pageOf(CreatorSchema, { id: 'CreatorPage' });
export const CustomFieldPageSchema = pageOf(CustomFieldSchema, { id: 'CustomFieldPage' });
export const FieldValuePageSchema = pageOf(FieldValueSchema, { id: 'FieldValuePage' });

const REGISTERED: readonly z.ZodType[] = [
  // Primitives
  IdSchema,
  PublicIdSchema,
  Sha256Schema,
  SimhashSchema,
  TimestampSchema,
  CalendarDateSchema,
  EdtfDateSchema,
  ConfidenceSchema,
  HexColourSchema,
  CurrencyCodeSchema,
  CountryCodeSchema,
  LanguageTagSchema,
  UrlSchema,
  JsonValueSchema,
  JsonObjectSchema,
  MimeTypeSchema,

  // Vocabularies
  CoreItemTypeSchema,
  ItemTypeSchema,
  LibraryStateSchema,
  MimeSourceSchema,
  StorageBackendSchema,
  OcrStatusSchema,
  DocumentSourceKindSchema,
  AttachmentRoleSchema,
  AttachmentLinkModeSchema,
  AttachmentSourceSchema,
  CollectionKindSchema,
  QueryBackendSchema,
  TagSchemeSchema,
  AssignmentSourceSchema,
  CustomFieldDataTypeSchema,
  CustomFieldScopeSchema,
  NoteSourceFormatSchema,
  NoteKindSchema,
  AnnotationTypeSchema,
  AnnotationMotivationSchema,
  AnnotationBodyFormatSchema,
  CreatorKindSchema,
  CreatorRoleSchema,
  DisambiguationStatusSchema,
  OaStatusSchema,
  RetractionStatusSchema,
  VerificationStatusSchema,
  CoreOfficeDocumentTypeSchema,
  OfficeDocumentTypeSchema,
  ProvenanceSourceSchema,
  ProvenanceEntityTypeSchema,

  // Provenance
  FieldPathSchema,
  FieldProvenanceEntrySchema,
  FieldProvenanceSchema,
  FieldProvenanceMapSchema,
  LockedFieldsSchema,

  // Identifiers
  DoiSchema,
  PmidSchema,
  PmcidSchema,
  ArxivIdSchema,
  IsbnSchema,
  IssnSchema,
  OpenAlexWorkIdSchema,
  SemanticScholarPaperIdSchema,
  OrcidSchema,
  RorSchema,
  BibliographicIdentifiersSchema,

  // Entities
  DocumentSchema,
  DocumentCreateSchema,
  DocumentUpdateSchema,
  ItemSchema,
  ItemCreateSchema,
  ItemUpdateSchema,
  ItemSummarySchema,
  BibliographicFacetSchema,
  BibliographicFacetCreateSchema,
  BibliographicFacetUpdateSchema,
  OfficeFacetSchema,
  OfficeFacetCreateSchema,
  OfficeFacetUpdateSchema,
  AttachmentSchema,
  AttachmentCreateSchema,
  AttachmentUpdateSchema,
  CollectionSchema,
  CollectionCreateSchema,
  CollectionUpdateSchema,
  CollectionMembershipSchema,
  TagSchema,
  TagCreateSchema,
  TagUpdateSchema,
  ItemTagSchema,
  CustomFieldSchema,
  CustomFieldCreateSchema,
  CustomFieldUpdateSchema,
  FieldKeySchema,
  FieldValueContentSchema,
  FieldValueSchema,
  FieldValueCreateSchema,
  FieldValueUpdateSchema,
  NoteSchema,
  NoteCreateSchema,
  NoteUpdateSchema,
  TextQuoteSelectorSchema,
  TextPositionSelectorSchema,
  FragmentSelectorSchema,
  RectangleSelectorSchema,
  InkSelectorSchema,
  AnnotationSelectorSchema,
  AnnotationSelectorSetSchema,
  AnnotationSchema,
  AnnotationCreateSchema,
  AnnotationUpdateSchema,
  TextualBodySchema,
  WebAnnotationSchema,
  CreatorSchema,
  CreatorCreateSchema,
  CreatorUpdateSchema,
  NameVariantSchema,
  ItemCreatorSchema,
  ItemCreatorInputSchema,

  // Envelopes
  CursorSchema,
  SortDirectionSchema,
  PageParamsSchema,
  PageInfoSchema,
  ProblemErrorSchema,
  ProblemDetailsSchema,
  IdempotencyKeySchema,
  BulkOperationVerbSchema,
  BulkOperationOutcomeSchema,
  BulkResultSchema,
  HealthStatusSchema,
  ComponentHealthSchema,
  LibrarySummarySchema,
  HealthResponseSchema,

  // Pages
  ItemPageSchema,
  CollectionPageSchema,
  TagPageSchema,
  DocumentPageSchema,
  AttachmentPageSchema,
  NotePageSchema,
  AnnotationPageSchema,
  CreatorPageSchema,
  CustomFieldPageSchema,
  FieldValuePageSchema,
];

/**
 * Every schema in the contract, keyed by the component name it carries in its own metadata.
 *
 * Throws rather than guesses: a schema without an `id`, or two schemas claiming the same one, is
 * a mistake that must not reach the generated document.
 */
export const componentSchemas: Readonly<Record<string, z.ZodType>> = (() => {
  const schemas: Record<string, z.ZodType> = {};
  for (const schema of REGISTERED) {
    const id = z.globalRegistry.get(schema)?.id;
    if (id === undefined) {
      throw new Error(
        'every registered schema must carry an id in .meta(); one in src/openapi/components.ts does not',
      );
    }
    if (Object.hasOwn(schemas, id)) {
      throw new Error(`two schemas claim the OpenAPI component name '${id}'`);
    }
    schemas[id] = schema;
  }
  return Object.freeze(schemas);
})();

/** The component names the document is expected to carry. Sorted, so a diff is readable. */
export const componentSchemaNames: readonly string[] = Object.freeze(
  Object.keys(componentSchemas).sort((left, right) => left.localeCompare(right, 'en')),
);
