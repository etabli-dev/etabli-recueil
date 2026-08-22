/**
 * The bibliographic facet — `Item.Bibliographic` in CONCEPT.md §5.2, `item_bibliographic` in
 * `spec/data-model.md` §3.5.
 *
 * Two things here are load-bearing beyond the field list. Identifiers are stored **normalised**
 * (invariant B1) so the record deduplicator can compare with `=` rather than a function, which is
 * why the DOI schema refuses an uppercase or prefixed value instead of quietly folding it. And
 * every field can carry provenance and a manual lock (P4, §3.6), which is what makes "manual edits
 * are never overwritten" true of the data rather than of a code path.
 */
import * as z from 'zod';

import {
  EdtfDateSchema,
  LanguageTagSchema,
  LongTextSchema,
  ShortTextSchema,
  TimestampSchema,
  UrlSchema,
  isValidIsbn13,
  isValidIssn,
} from '../primitives.js';
import { FieldProvenanceMapSchema, LockedFieldsSchema } from '../provenance.js';
import { OaStatusSchema, RetractionStatusSchema, VerificationStatusSchema } from '../vocabularies.js';

/* -------------------------------------------------------------------------------------------- */
/* Identifiers (CONCEPT.md §5.2: DOI, PMID, PMCID, arXiv, ISBN, OpenAlex, S2)                       */
/* -------------------------------------------------------------------------------------------- */

export const DoiSchema = z
  .string()
  .max(255)
  .regex(/^10\.\d{4,9}\/\S+$/, 'must be a DOI of the form 10.<registrant>/<suffix>, without the https://doi.org/ prefix')
  .refine((value) => value === value.toLowerCase(), 'must be stored lower-cased (invariant B1)')
  .meta({
    id: 'Doi',
    title: 'Doi',
    description: 'Lowercase, prefix-stripped DOI. Normalisation happens once, on write (B1).',
    examples: ['10.1136/bmj.n71'],
  });

export const PmidSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, 'must be digits only, with no leading zero')
  .meta({ id: 'Pmid', title: 'Pmid', examples: ['33782057'] });

export const PmcidSchema = z
  .string()
  .regex(/^PMC\d{1,10}$/, 'must retain the PMC prefix')
  .meta({ id: 'Pmcid', title: 'Pmcid', examples: ['PMC8005924'] });

export const ArxivIdSchema = z
  .string()
  .regex(
    /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/,
    'must be a modern (2103.00020v2) or legacy (math.GT/0309136) arXiv identifier',
  )
  .meta({ id: 'ArxivId', title: 'ArxivId', examples: ['2103.00020v2'] });

export const IsbnSchema = z
  .string()
  .regex(/^\d{13}$/, 'must be a hyphenless ISBN-13 (invariant B1)')
  .refine(isValidIsbn13, 'ISBN-13 check digit does not match')
  .meta({
    id: 'Isbn',
    title: 'Isbn',
    description: 'ISBN-13, hyphenless, check digit verified. ISBN-10 is converted on import (B1).',
    examples: ['9780262035613'],
  });

export const IssnSchema = z
  .string()
  .regex(/^\d{4}-\d{3}[\dX]$/, 'must be a hyphenated ISSN')
  .refine(isValidIssn, 'ISSN check digit does not match')
  .meta({ id: 'Issn', title: 'Issn', examples: ['0140-6736'] });

export const OpenAlexWorkIdSchema = z
  .string()
  .regex(/^W\d{2,12}$/, 'must be an OpenAlex work id of the form W…')
  .meta({ id: 'OpenAlexWorkId', title: 'OpenAlexWorkId', examples: ['W2741809807'] });

export const SemanticScholarPaperIdSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a 40-character Semantic Scholar paper id')
  .meta({ id: 'SemanticScholarPaperId', title: 'SemanticScholarPaperId' });

/**
 * The identifier block. Grouped as its own component because the resolvers, the deduplicator and
 * the `identifier_syntax` check all take exactly this set and nothing else.
 */
export const BibliographicIdentifiersSchema = z
  .strictObject({
    doi: DoiSchema.nullish(),
    pmid: PmidSchema.nullish(),
    pmcid: PmcidSchema.nullish(),
    arxivId: ArxivIdSchema.nullish(),
    isbn: IsbnSchema.nullish(),
    issn: IssnSchema.nullish().meta({ description: 'Print ISSN.' }),
    eissn: IssnSchema.nullish().meta({ description: 'Electronic ISSN.' }),
    issnL: IssnSchema.nullish().meta({ description: 'Linking ISSN — the venue key used by the graph.' }),
    openalexId: OpenAlexWorkIdSchema.nullish(),
    semanticScholarId: SemanticScholarPaperIdSchema.nullish(),
    dataciteDoi: DoiSchema.nullish().meta({ description: 'Set only when distinct from `doi`.' }),
    handle: z.string().max(255).nullish(),
    url: UrlSchema.nullish(),
  })
  .meta({
    id: 'BibliographicIdentifiers',
    title: 'BibliographicIdentifiers',
    description:
      'The identifier set of CONCEPT.md §5.2, stored normalised so that deduplication is an ' +
      'equality test (invariant B1).',
  });

/* -------------------------------------------------------------------------------------------- */
/* The facet                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const bibliographicWritableShape = {
  cslType: z
    .string()
    .max(64)
    .nullish()
    .meta({ description: 'CSL item type, when it differs from the Recueil item type mapping.' }),
  title: ShortTextSchema.nullish(),
  subtitle: ShortTextSchema.nullish(),
  shortTitle: ShortTextSchema.nullish().meta({ description: 'Feeds the citation key formula (ADR-0016).' }),
  containerTitle: ShortTextSchema.nullish().meta({ description: 'Journal, book or proceedings — bibliometrix SO.' }),
  containerShort: ShortTextSchema.nullish().meta({ description: 'ISO-4 abbreviation.' }),
  collectionTitle: ShortTextSchema.nullish().meta({ description: 'Series.' }),
  collectionNumber: z.string().max(64).nullish(),
  publisher: ShortTextSchema.nullish(),
  publisherPlace: ShortTextSchema.nullish(),
  edition: z.string().max(64).nullish(),
  volume: z.string().max(64).nullish().meta({ description: 'Text, not a number: volumes are 12, 12A, II.' }),
  issue: z.string().max(64).nullish(),
  pages: z.string().max(64).nullish().meta({ description: 'The range as printed.' }),
  pageFirst: z.number().int().nullish(),
  pageLast: z.number().int().nullish(),
  numberOfPages: z.number().int().min(0).nullish(),
  issuedDate: EdtfDateSchema.nullish().meta({ description: 'The canonical publication date. May be year-only.' }),
  issuedYear: z.number().int().min(1).max(2999).nullish().meta({ description: 'Derived from issuedDate; bibliometrix PY.' }),
  issuedMonth: z.number().int().min(1).max(12).nullish(),
  availableDate: EdtfDateSchema.nullish().meta({ description: 'Online-first date.' }),
  accessedAt: TimestampSchema.nullish(),
  ...BibliographicIdentifiersSchema.shape,
  abstract: LongTextSchema.nullish().meta({ description: 'bibliometrix AB.' }),
  languageCode: LanguageTagSchema.nullish(),
  citationKey: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:_.+#$%&\-/]*$/, 'must be a BibTeX-safe citation key')
    .nullish()
    .meta({ description: 'Stable, exported to BibTeX; bibliometrix SR (ADR-0016).' }),
  citationKeyLocked: z
    .boolean()
    .optional()
    .meta({ description: 'When true, regeneration never touches the key (ADR-0016, pinning).' }),
  citationKeyFormula: z.string().max(255).nullish(),
  licence: z
    .string()
    .max(255)
    .nullish()
    .meta({ description: 'SPDX id or licence URL. The CSL-JSON key is spelled `license`; the prose here is British English.' }),
  oaStatus: OaStatusSchema.nullish(),
  oaUrl: UrlSchema.nullish().meta({ description: 'From Unpaywall.' }),
  isPreprint: z.boolean().optional(),
  publishedVersionDoi: DoiSchema.nullish().meta({ description: 'Set by the `preprint_published` check.' }),
  versionLabel: z.string().max(64).nullish(),
  retractionNoticeDoi: DoiSchema.nullish(),
} as const;

/** Fields the checks engine owns. A client reads them; only a check writes them. */
const bibliographicDerivedShape = {
  oaCheckedAt: TimestampSchema.nullish(),
  preprintCheckedAt: TimestampSchema.nullish(),
  retractionStatus: RetractionStatusSchema,
  retractionCheckedAt: TimestampSchema.nullish(),
  verificationStatus: VerificationStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  provenance: FieldProvenanceMapSchema.optional(),
  lockedFields: LockedFieldsSchema.optional(),
} as const;

const checkPageOrder = (
  value: { pageFirst?: number | null; pageLast?: number | null },
  ctx: z.RefinementCtx,
): void => {
  if (
    typeof value.pageFirst === 'number' &&
    typeof value.pageLast === 'number' &&
    value.pageLast < value.pageFirst
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'pageLast must not be before pageFirst (ck_item_bibliographic_pages)',
      path: ['pageLast'],
    });
  }
};

export const BibliographicFacetSchema = z
  .strictObject({ ...bibliographicWritableShape, ...bibliographicDerivedShape })
  .superRefine(checkPageOrder)
  .meta({
    id: 'BibliographicFacet',
    title: 'BibliographicFacet',
    description:
      'The scholarly facet of an item (CONCEPT.md §5.2). Present on literature; absent on the ' +
      'invoices, letters and photographs that make up roughly half a real library.',
  });

export const BibliographicFacetCreateSchema = z
  .strictObject(bibliographicWritableShape)
  .superRefine(checkPageOrder)
  .meta({ id: 'BibliographicFacetCreate', title: 'BibliographicFacetCreate', unusedIO: 'input' });

/**
 * A partial write to the facet. Every field here is subject to the lock rule: writing a field by
 * hand records `source: "manual"` provenance and locks it against later enrichment (P4-1).
 */
export const BibliographicFacetUpdateSchema = z
  .strictObject(bibliographicWritableShape)
  .partial()
  .superRefine(checkPageOrder)
  .meta({ id: 'BibliographicFacetUpdate', title: 'BibliographicFacetUpdate', unusedIO: 'input' });

export type BibliographicIdentifiers = z.infer<typeof BibliographicIdentifiersSchema>;
export type BibliographicFacet = z.infer<typeof BibliographicFacetSchema>;
export type BibliographicFacetCreate = z.infer<typeof BibliographicFacetCreateSchema>;
export type BibliographicFacetUpdate = z.infer<typeof BibliographicFacetUpdateSchema>;
