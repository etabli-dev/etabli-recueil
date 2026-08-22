/**
 * Per-field provenance and the manual lock (P4, `spec/data-model.md` §3.6).
 *
 * The lock is the whole point: CONCEPT.md §5.4 says "manual edits locked per field and never
 * overwritten", and invariant P4-1 makes that a property of the data rather than of a code path —
 * editing a field by hand writes a provenance row with `source: "manual"` and `locked: true`.
 */
import * as z from 'zod';

import {
  ConfidenceSchema,
  IdSchema,
  TimestampSchema,
} from './primitives.js';
import {
  ProvenanceEntityTypeSchema,
  ProvenanceSourceSchema,
} from './vocabularies.js';

/**
 * A field path: the API-side name of the field the provenance row describes, dotted for values
 * nested inside a JSON column.
 */
export const FieldPathSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/, 'must be a field name, dotted for nested values')
  .meta({
    id: 'FieldPath',
    description: 'The field this provenance row describes, e.g. `doi` or `containerTitle`.',
    examples: ['doi', 'containerTitle', 'issuedDate'],
  });

/** Provenance for one field, without the entity coordinates — the shape carried inside a facet. */
export const FieldProvenanceEntrySchema = z
  .strictObject({
    source: ProvenanceSourceSchema,
    sourceRecordId: z
      .string()
      .max(512)
      .nullish()
      .meta({ description: 'The upstream record the value came from, so the claim can be re-fetched.' }),
    sourceVersion: z.string().max(128).nullish(),
    confidence: ConfidenceSchema.nullish(),
    fetchedAt: TimestampSchema,
    appliedAt: TimestampSchema,
    locked: z
      .boolean()
      .meta({ description: 'When true, no resolver may overwrite this field. Not overridable by configuration (P4-2).' }),
    lockedAt: TimestampSchema.nullish(),
    lockedByUserId: IdSchema.nullish(),
    previousValue: z
      .string()
      .max(8192)
      .nullish()
      .meta({ description: 'The value this one replaced, as text. Retained even when the field is cleared (P4-3).' }),
  })
  .meta({
    id: 'FieldProvenanceEntry',
    title: 'FieldProvenanceEntry',
    description: 'Source, confidence, timing and manual lock for a single field (P4).',
  });

/** A whole provenance row, as the `/items/{id}/provenance` collection returns it. */
export const FieldProvenanceSchema = z
  .strictObject({
    id: IdSchema,
    entityType: ProvenanceEntityTypeSchema,
    entityId: IdSchema,
    fieldPath: FieldPathSchema,
  })
  .extend(FieldProvenanceEntrySchema.shape)
  .meta({
    id: 'FieldProvenance',
    title: 'FieldProvenance',
    description: 'One current provenance row per (entity, field). History lives in the audit log.',
  });

/**
 * The provenance block a facet carries: one entry per field, keyed by field path.
 *
 * Read-only on the wire. A client changes provenance by writing the field (which locks it) or by
 * calling the explicit unlock endpoint — never by posting this map back (P4-3).
 */
export const FieldProvenanceMapSchema = z
  .record(FieldPathSchema, FieldProvenanceEntrySchema)
  .meta({
    id: 'FieldProvenanceMap',
    title: 'FieldProvenanceMap',
    description: 'Per-field provenance for a facet, keyed by field path. Read-only.',
  });

/**
 * The set of fields locked against enrichment. A convenience projection of
 * `FieldProvenanceMap`: the same information, in the form the item pane actually asks for.
 */
export const LockedFieldsSchema = z
  .array(FieldPathSchema)
  .max(512)
  .meta({
    id: 'LockedFields',
    title: 'LockedFields',
    description: 'Fields locked against resolver writes (P4-2). A projection of the provenance map.',
  });

export type FieldPath = z.infer<typeof FieldPathSchema>;
export type FieldProvenanceEntry = z.infer<typeof FieldProvenanceEntrySchema>;
export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;
export type FieldProvenanceMap = z.infer<typeof FieldProvenanceMapSchema>;
