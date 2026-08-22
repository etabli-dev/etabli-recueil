/**
 * The storage constraints and the wire contract must agree.
 *
 * `schema.ts` repeats the closed vocabularies of `@recueil/schemas` as database `CHECK`
 * constraints, because `spec/data-model.md` §1.1 says a closed vocabulary is a check in the
 * database and an enum in Zod — one is what the library will hold, the other is what an API caller
 * may send. Two copies of a list drift, so this test is the thing that keeps them honest: widening
 * a vocabulary is a migration *and* a schema change, and forgetting either half fails here.
 */
import { describe, expect, it } from 'vitest';
import * as contract from '@recueil/schemas';

import { schema } from '../src/index.js';

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('closed vocabularies', () => {
  const pairs: Array<[string, readonly string[], readonly string[]]> = [
    ['LIBRARY_STATES', schema.LIBRARY_STATES, contract.LIBRARY_STATES],
    ['MIME_SOURCES', schema.MIME_SOURCES, contract.MIME_SOURCES],
    ['STORAGE_BACKENDS', schema.STORAGE_BACKENDS, contract.STORAGE_BACKENDS],
    ['OCR_STATUSES', schema.OCR_STATUSES, contract.OCR_STATUSES],
    ['DOCUMENT_SOURCE_KINDS', schema.DOCUMENT_SOURCE_KINDS, contract.DOCUMENT_SOURCE_KINDS],
    ['ATTACHMENT_ROLES', schema.ATTACHMENT_ROLES, contract.ATTACHMENT_ROLES],
    ['ATTACHMENT_LINK_MODES', schema.ATTACHMENT_LINK_MODES, contract.ATTACHMENT_LINK_MODES],
    ['ATTACHMENT_SOURCES', schema.ATTACHMENT_SOURCES, contract.ATTACHMENT_SOURCES],
    ['COLLECTION_KINDS', schema.COLLECTION_KINDS, contract.COLLECTION_KINDS],
    ['QUERY_BACKENDS', schema.QUERY_BACKENDS, contract.QUERY_BACKENDS],
    ['TAG_SCHEMES', schema.TAG_SCHEMES, contract.TAG_SCHEMES],
    ['CUSTOM_FIELD_DATA_TYPES', schema.CUSTOM_FIELD_DATA_TYPES, contract.CUSTOM_FIELD_DATA_TYPES],
    ['CUSTOM_FIELD_SCOPES', schema.CUSTOM_FIELD_SCOPES, contract.CUSTOM_FIELD_SCOPES],
    ['NOTE_FORMATS', schema.NOTE_FORMATS, contract.NOTE_FORMATS],
    ['NOTE_KINDS', schema.NOTE_KINDS, contract.NOTE_KINDS],
    ['ANNOTATION_TYPES', schema.ANNOTATION_TYPES, contract.ANNOTATION_TYPES],
    ['ANNOTATION_MOTIVATIONS', schema.ANNOTATION_MOTIVATIONS, contract.ANNOTATION_MOTIVATIONS],
    ['ANNOTATION_BODY_FORMATS', schema.ANNOTATION_BODY_FORMATS, contract.ANNOTATION_BODY_FORMATS],
    ['CREATOR_KINDS', schema.CREATOR_KINDS, contract.CREATOR_KINDS],
    ['CREATOR_ROLES', schema.CREATOR_ROLES, contract.CREATOR_ROLES],
    ['DISAMBIGUATION_STATUSES', schema.DISAMBIGUATION_STATUSES, contract.DISAMBIGUATION_STATUSES],
    ['OA_STATUSES', schema.OA_STATUSES, contract.OA_STATUSES],
    ['RETRACTION_STATUSES', schema.RETRACTION_STATUSES, contract.RETRACTION_STATUSES],
    ['VERIFICATION_STATUSES', schema.VERIFICATION_STATUSES, contract.VERIFICATION_STATUSES],
    ['PROVENANCE_ENTITY_TYPES', schema.PROVENANCE_ENTITY_TYPES, contract.PROVENANCE_ENTITY_TYPES],
  ];

  it.each(pairs)('%s matches @recueil/schemas', (_name, storage, wire) => {
    expect(sorted(storage)).toEqual(sorted(wire));
  });

  /**
   * The one place the two deliberately differ. `spec/data-model.md` gives `collection_items.source`
   * and `item_tags.source` different lists — a collection membership is never added by a resolver,
   * and a tag is never added by the connector as such — while the contract exposes one
   * `AssignmentSource` union covering both. Subsets, not equality, is the right assertion.
   */
  it('membership and tag assignment sources are subsets of the contract union', () => {
    for (const value of schema.MEMBERSHIP_SOURCES) {
      expect(contract.ASSIGNMENT_SOURCES).toContain(value);
    }
    for (const value of schema.TAG_ASSIGNMENT_SOURCES) {
      expect(contract.ASSIGNMENT_SOURCES).toContain(value);
    }
  });
});

describe('identifier shapes', () => {
  it('mints ids and public ids the contract accepts', async () => {
    const recueil = await import('../src/ids.js');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(contract.IdSchema.safeParse(recueil.newId()).success).toBe(true);
      expect(contract.PublicIdSchema.safeParse(recueil.newPublicId()).success).toBe(true);
    }
  });

  it('produces timestamps in the one permitted form', async () => {
    const { nowTimestamp } = await import('../src/time.js');
    expect(contract.TimestampSchema.safeParse(nowTimestamp()).success).toBe(true);
  });
});
