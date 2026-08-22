import { describe, expect, it } from 'vitest';
import type * as z from 'zod';

import {
  AnnotationCreateSchema,
  AnnotationSchema,
  AttachmentCreateSchema,
  AttachmentSchema,
  BibliographicFacetCreateSchema,
  CollectionCreateSchema,
  CollectionSchema,
  CreatorCreateSchema,
  CreatorSchema,
  CustomFieldCreateSchema,
  CustomFieldSchema,
  DocumentCreateSchema,
  DocumentSchema,
  FieldValueCreateSchema,
  FieldValueSchema,
  ItemCreateSchema,
  ItemSchema,
  ItemUpdateSchema,
  NoteSchema,
  OfficeFacetCreateSchema,
  TagSchema,
  WebAnnotationSchema,
  isCoreItemType,
} from '../src/index.js';
import {
  SHA256_A,
  ULID_A,
  ULID_B,
  ULID_C,
  validAnnotation,
  validAttachment,
  validCollection,
  validCreator,
  validCustomField,
  validDocument,
  validFieldValue,
  validItem,
  validItemCreate,
  validNote,
  validTag,
} from './fixtures.js';

/**
 * The distinct paths a failed parse complained about, joined for readable assertions. Distinct,
 * because one field can fail two checks — a hyphenated ISBN fails both the shape and the check
 * digit — and the test cares which field was named, not how many ways it was wrong.
 */
const issuePaths = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

/** Every message a failed parse produced, so an assertion can name the invariant it expects. */
const issueMessages = (result: z.ZodSafeParseResult<unknown>): string =>
  result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ');

const firstMessage = (result: z.ZodSafeParseResult<unknown>): string =>
  result.success ? '' : (result.error.issues[0]?.message ?? '');

describe('valid fixtures parse', () => {
  it.each([
    ['Document', DocumentSchema, validDocument],
    ['Item', ItemSchema, validItem],
    ['Attachment', AttachmentSchema, validAttachment],
    ['Collection', CollectionSchema, validCollection],
    ['Tag', TagSchema, validTag],
    ['Note', NoteSchema, validNote],
    ['Annotation', AnnotationSchema, validAnnotation],
    ['Creator', CreatorSchema, validCreator],
    ['CustomField', CustomFieldSchema, validCustomField],
    ['FieldValue', FieldValueSchema, validFieldValue],
    ['ItemCreate', ItemCreateSchema, validItemCreate],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });
});

describe('Item', () => {
  it('accepts every item type CONCEPT.md §5.2 names, and any registered slug', () => {
    for (const itemType of ['article', 'book', 'chapter', 'dataset', 'invoice', 'photo']) {
      expect(ItemCreateSchema.safeParse({ itemType }).success).toBe(true);
      expect(isCoreItemType(itemType)).toBe(true);
    }
    // Open vocabulary: a plugin may register one, so an unknown slug is accepted …
    expect(ItemCreateSchema.safeParse({ itemType: 'legal_ruling' }).success).toBe(true);
    expect(isCoreItemType('legal_ruling')).toBe(false);
  });

  it.each([
    ['a display name rather than a slug', 'Journal Article'],
    ['a leading digit', '2_article'],
    ['a hyphen', 'conference-paper'],
    ['empty', ''],
  ])('rejects an item type that is %s', (_label, itemType) => {
    const result = ItemCreateSchema.safeParse({ itemType });
    expect(issuePaths(result)).toContain('itemType');
  });

  it('rejects an unknown property rather than silently dropping it (P3)', () => {
    const result = ItemCreateSchema.safeParse({ itemType: 'article', titel: 'typo' });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.code)).toContain(
      'unrecognized_keys',
    );
  });

  it('has no server-generated fields on the create variant', () => {
    const result = ItemCreateSchema.safeParse({ ...validItemCreate, id: ULID_A, version: 1 });
    expect(result.success).toBe(false);
    const keys = result.success ? [] : (result.error.issues[0] as { keys?: string[] }).keys;
    expect(keys).toEqual(expect.arrayContaining(['id', 'version']));
  });

  it('takes every field as optional on the update variant', () => {
    expect(ItemUpdateSchema.safeParse({}).success).toBe(true);
    expect(ItemUpdateSchema.safeParse({ title: 'A corrected title' }).success).toBe(true);
    expect(issuePaths(ItemUpdateSchema.safeParse({ itemType: 'Journal Article' }))).toContain('itemType');
  });
});

describe('bibliographic facet', () => {
  it('accepts the identifier set of CONCEPT.md §5.2', () => {
    const result = BibliographicFacetCreateSchema.safeParse({
      doi: '10.1136/bmj.n71',
      pmid: '33782057',
      pmcid: 'PMC8005924',
      arxivId: '2103.00020v2',
      isbn: '9780262035613',
      issn: '0959-8138',
      openalexId: 'W3135361538',
      semanticScholarId: 'a'.repeat(40),
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });

  it.each([
    ['a DOI with the resolver prefix', { doi: 'https://doi.org/10.1136/bmj.n71' }, 'doi'],
    ['an upper-cased DOI', { doi: '10.1136/BMJ.N71' }, 'doi'],
    ['a PMID with a prefix', { pmid: 'PMID:33782057' }, 'pmid'],
    ['a PMCID without its prefix', { pmcid: '8005924' }, 'pmcid'],
    ['a hyphenated ISBN', { isbn: '978-0-262-03561-3' }, 'isbn'],
    ['an ISBN whose check digit is wrong', { isbn: '9780262035614' }, 'isbn'],
    ['an ISSN whose check digit is wrong', { issn: '0959-8139' }, 'issn'],
    ['an OpenAlex author id in the work field', { openalexId: 'A2208157607' }, 'openalexId'],
  ])('rejects %s', (_label, patch, path) => {
    expect(issuePaths(BibliographicFacetCreateSchema.safeParse(patch))).toEqual([path]);
  });

  it('rejects a page range that runs backwards', () => {
    const result = BibliographicFacetCreateSchema.safeParse({ pageFirst: 120, pageLast: 96 });
    expect(issuePaths(result)).toEqual(['pageLast']);
    expect(firstMessage(result)).toContain('ck_item_bibliographic_pages');
  });

  it('carries per-field provenance and the manual lock (P4)', () => {
    const provenance = validItem.bibliographic?.provenance;
    expect(provenance?.citationKey?.locked).toBe(true);
    expect(provenance?.doi?.source).toBe('crossref');
    expect(validItem.bibliographic?.lockedFields).toEqual(['citationKey']);
  });
});

describe('office facet', () => {
  it('accepts a complete invoice record', () => {
    const result = OfficeFacetCreateSchema.safeParse({
      correspondent: 'Stadtwerke Ulm',
      officeDocumentType: 'invoice',
      documentDate: '2026-07-31',
      asn: 1042,
      referenceNumber: 'RE-2026-004711',
      amountMinor: 12_950,
      amountCurrency: 'EUR',
      dueDate: '2026-08-14',
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });

  it('refuses an amount without a currency', () => {
    const result = OfficeFacetCreateSchema.safeParse({ correspondent: 'X', amountMinor: 1000 });
    expect(issuePaths(result)).toEqual(['amountCurrency']);
  });

  it('refuses a period that ends before it starts', () => {
    const result = OfficeFacetCreateSchema.safeParse({
      correspondent: 'X',
      periodStart: '2026-02-01',
      periodEnd: '2026-01-01',
    });
    expect(issuePaths(result)).toEqual(['periodEnd']);
  });
});

describe('attachment', () => {
  it('accepts each role', () => {
    for (const role of ['primary', 'supplement', 'snapshot', 'scan', 'source_export']) {
      const result = AttachmentCreateSchema.safeParse({
        itemId: ULID_B,
        documentId: ULID_A,
        role,
        linkMode: 'stored',
      });
      expect(result.success, `${role}: ${JSON.stringify(issuePaths(result))}`).toBe(true);
    }
    expect(issuePaths(
      AttachmentCreateSchema.safeParse({ itemId: ULID_B, documentId: ULID_A, role: 'thumbnail', linkMode: 'stored' }),
    )).toEqual(['role']);
  });

  it.each([
    [
      'a stored attachment without a document',
      { itemId: ULID_B, role: 'primary', linkMode: 'stored' },
      'documentId',
    ],
    [
      'a linked_url attachment without a url',
      { itemId: ULID_B, role: 'snapshot', linkMode: 'linked_url' },
      'url',
    ],
    [
      'a linked_url attachment that also claims a document',
      { itemId: ULID_B, role: 'snapshot', linkMode: 'linked_url', url: 'https://example.org', documentId: ULID_A },
      'documentId',
    ],
    [
      'a linked_file attachment without a path',
      { itemId: ULID_B, role: 'other', linkMode: 'linked_file' },
      'linkedPath',
    ],
  ])('rejects %s', (_label, payload, path) => {
    const result = AttachmentCreateSchema.safeParse(payload);
    expect(issuePaths(result)).toContain(path);
    expect(issueMessages(result)).toContain('ck_attachments_link_mode');
  });
});

describe('collection', () => {
  it('requires a query on a smart collection and forbids one elsewhere', () => {
    expect(
      CollectionCreateSchema.safeParse({ name: 'Preprints', kind: 'smart', query: { itemType: 'preprint' } }).success,
    ).toBe(true);
    expect(issuePaths(CollectionCreateSchema.safeParse({ name: 'Preprints', kind: 'smart' }))).toEqual(['query']);
    expect(
      issuePaths(CollectionCreateSchema.safeParse({ name: 'Reading', kind: 'manual', query: { a: 1 } })),
    ).toEqual(['query']);
  });
});

describe('creator', () => {
  it('needs a family name or a literal name', () => {
    expect(CreatorCreateSchema.safeParse({ kind: 'person', familyName: 'Ravaud' }).success).toBe(true);
    expect(issuePaths(CreatorCreateSchema.safeParse({ kind: 'person', givenName: 'Philippe' }))).toEqual([
      'familyName',
    ]);
  });

  it('names an organisation by its literal name', () => {
    expect(
      CreatorCreateSchema.safeParse({ kind: 'organisation', literalName: 'Cochrane Collaboration' }).success,
    ).toBe(true);
    expect(issuePaths(CreatorCreateSchema.safeParse({ kind: 'organisation', familyName: 'Cochrane' }))).toEqual([
      'literalName',
    ]);
  });

  it('checks the ORCID check digit', () => {
    expect(issuePaths(CreatorCreateSchema.safeParse({ ...validCreator, orcid: '0000-0002-1825-0098' }))).toContain(
      'orcid',
    );
  });
});

describe('custom field and field value', () => {
  it('requires a slug field key', () => {
    expect(CustomFieldCreateSchema.safeParse({ fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' }).success).toBe(true);
    expect(
      issuePaths(CustomFieldCreateSchema.safeParse({ fieldKey: 'Sample Size', name: 'Sample size', dataType: 'integer' })),
    ).toEqual(['fieldKey']);
  });

  it('types the value by the data type it declares', () => {
    const base = { fieldId: ULID_A, itemId: ULID_B };
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'integer', value: 412 } }).success).toBe(true);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'integer', value: 41.2 } }).success).toBe(false);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'date', value: '2026-08-22' } }).success).toBe(true);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'date', value: '22/08/2026' } }).success).toBe(false);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'item_reference', value: ULID_C } }).success).toBe(true);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'multi_choice', value: ['a', 'b'] } }).success).toBe(true);
    expect(FieldValueCreateSchema.safeParse({ ...base, content: { type: 'nonsense', value: 1 } }).success).toBe(false);
  });

  it('distinguishes "not reported" from "not yet extracted"', () => {
    const base = { fieldId: ULID_A, itemId: ULID_B };
    expect(FieldValueCreateSchema.safeParse({ ...base, isBlank: true }).success).toBe(true);
    expect(issuePaths(FieldValueCreateSchema.safeParse(base))).toEqual(['content']);
    expect(
      issuePaths(FieldValueCreateSchema.safeParse({ ...base, isBlank: true, content: { type: 'integer', value: 1 } })),
    ).toEqual(['isBlank']);
  });
});

describe('annotation', () => {
  const base = {
    documentId: ULID_A,
    annotationType: 'highlight' as const,
    motivation: 'highlighting' as const,
    selector: [{ type: 'FragmentSelector' as const, value: 'page=3' }],
  };

  it('accepts the W3C selector types and the two Recueil extensions', () => {
    const selectors = [
      { type: 'TextQuoteSelector', exact: 'a quote' },
      { type: 'TextPositionSelector', start: 10, end: 20 },
      { type: 'FragmentSelector', value: 'page=3' },
      { type: 'RectangleSelector', pageIndex: 2, rectangles: [{ x: 10, y: 20, width: 100, height: 12 }] },
      { type: 'InkSelector', pageIndex: 2, paths: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]] },
    ];
    const result = AnnotationCreateSchema.safeParse({ ...base, selector: selectors });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });

  it('insists on a selector that survives a text-layer change (AN4)', () => {
    const result = AnnotationCreateSchema.safeParse({
      ...base,
      selector: [
        { type: 'TextQuoteSelector', exact: 'a quote' },
        { type: 'TextPositionSelector', start: 10, end: 20 },
      ],
    });
    expect(issuePaths(result)).toEqual(['selector']);
    expect(firstMessage(result)).toContain('AN4');
  });

  it('requires at least one selector', () => {
    expect(issuePaths(AnnotationCreateSchema.safeParse({ ...base, selector: [] }))).toEqual(['selector']);
  });

  it('requires a body on a note annotation', () => {
    expect(issuePaths(AnnotationCreateSchema.safeParse({ ...base, annotationType: 'note', motivation: 'commenting' }))).toEqual([
      'bodyText',
    ]);
    expect(
      AnnotationCreateSchema.safeParse({
        ...base,
        annotationType: 'note',
        motivation: 'commenting',
        bodyText: 'A thought.',
      }).success,
    ).toBe(true);
  });

  it('rejects a position selector that ends before it starts', () => {
    const result = AnnotationCreateSchema.safeParse({
      ...base,
      selector: [{ type: 'FragmentSelector', value: 'page=3' }, { type: 'TextPositionSelector', start: 20, end: 10 }],
    });
    expect(issuePaths(result)).toEqual(['selector.1.end']);
  });

  it('accepts the W3C Web Annotation projection', () => {
    const result = WebAnnotationSchema.safeParse({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'https://recueil.example.org/api/v1/annotations/ANN00001',
      type: 'Annotation',
      motivation: 'highlighting',
      created: '2026-08-22T09:15:00.000Z',
      creator: { id: 'https://orcid.org/0000-0002-1825-0097', type: 'Person', name: 'Philippe Ravaud' },
      body: [{ type: 'TextualBody', value: 'Quote this in the methods section.', format: 'text/markdown' }],
      target: {
        source: `recueil:document/${ULID_A}`,
        selector: [
          { type: 'TextQuoteSelector', exact: 'reporting systematic reviews' },
          { type: 'FragmentSelector', value: 'page=3' },
        ],
      },
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });
});

describe('document', () => {
  it('will not take a document without a hash', () => {
    const { sha256: _sha256, ...withoutHash } = validDocument;
    expect(issuePaths(DocumentSchema.safeParse(withoutHash))).toEqual(['sha256']);
  });

  it('accepts a create payload with only what ingestion needs', () => {
    const result = DocumentCreateSchema.safeParse({ sha256: SHA256_A, sourceKind: 'folder', sourceRef: '/srv/consume/scan.pdf' });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });
});
