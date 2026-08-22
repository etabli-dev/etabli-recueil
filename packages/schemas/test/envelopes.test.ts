import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  BULK_MAX_OPERATIONS,
  BulkResultSchema,
  CORE_PROBLEM_TYPES,
  DEFAULT_PAGE_SIZE,
  HealthResponseSchema,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  ItemCreateSchema,
  ItemSummarySchema,
  MAX_PAGE_SIZE,
  PROBLEM_CONTENT_TYPE,
  PageParamsSchema,
  ProblemDetailsSchema,
  bulkOperationOf,
  bulkRequestOf,
  pageOf,
} from '../src/index.js';
import { ULID_A, ULID_B, validHealth, validItemCreate } from './fixtures.js';

const issuePaths = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

describe('cursor pagination', () => {
  it('bounds the page size', () => {
    expect(PageParamsSchema.safeParse({}).success).toBe(true);
    expect(PageParamsSchema.safeParse({ limit: MAX_PAGE_SIZE }).success).toBe(true);
    expect(issuePaths(PageParamsSchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }))).toEqual(['limit']);
    expect(issuePaths(PageParamsSchema.safeParse({ limit: 0 }))).toEqual(['limit']);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('takes an opaque cursor and refuses a decorated one', () => {
    expect(PageParamsSchema.safeParse({ cursor: 'eyJpZCI6IjAxSjhGM1o5SzQifQ' }).success).toBe(true);
    expect(issuePaths(PageParamsSchema.safeParse({ cursor: 'offset=25' }))).toEqual(['cursor']);
  });

  it('wraps any record schema in a page', () => {
    const ItemSummaryPage = pageOf(ItemSummarySchema, { id: 'TestItemPage' });
    const result = ItemSummaryPage.safeParse({
      data: [
        {
          id: ULID_A,
          publicId: 'A1B2C3D4',
          itemType: 'article',
          title: 'A paper',
          attachmentCount: 1,
          dateModified: '2026-08-22T09:15:00.000Z',
        },
      ],
      page: { nextCursor: null, hasMore: false, limit: DEFAULT_PAGE_SIZE },
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
    expect(issuePaths(ItemSummaryPage.safeParse({ data: [], page: { hasMore: false, limit: 25 } }))).toEqual([
      'page.nextCursor',
    ]);
  });
});

describe('problem documents (RFC 9457)', () => {
  it('is served as application/problem+json', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });

  it('accepts a validation problem with field-level detail', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: CORE_PROBLEM_TYPES.validation,
      title: 'The request body is not valid',
      status: 422,
      detail: 'bibliographic.doi must be stored lower-cased',
      instance: '/api/v1/items',
      errors: [{ path: 'bibliographic.doi', message: 'must be stored lower-cased', code: 'custom' }],
      traceId: '9f2c1a0b7d4e6a33',
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });

  it('requires a real HTTP status', () => {
    const base = { type: CORE_PROBLEM_TYPES.notFound, title: 'Not found' };
    expect(ProblemDetailsSchema.safeParse({ ...base, status: 404 }).success).toBe(true);
    expect(issuePaths(ProblemDetailsSchema.safeParse({ ...base, status: 99 }))).toEqual(['status']);
    expect(issuePaths(ProblemDetailsSchema.safeParse({ ...base, status: 404.5 }))).toEqual(['status']);
    expect(issuePaths(ProblemDetailsSchema.safeParse(base))).toEqual(['status']);
  });

  it('gives every core problem a distinct, stable type URI', () => {
    const uris = Object.values(CORE_PROBLEM_TYPES);
    expect(new Set(uris).size).toBe(uris.length);
    for (const uri of uris) expect(uri.startsWith('https://recueil.org/problems/')).toBe(true);
  });
});

describe('bulk operations and idempotency', () => {
  const ItemBulkRequest = bulkRequestOf(bulkOperationOf(ItemCreateSchema, { id: 'TestItemBulkOperation' }), {
    id: 'TestItemBulkRequest',
  });

  it('names the header the API documents', () => {
    expect(IDEMPOTENCY_HEADER).toBe('Idempotency-Key');
  });

  it('accepts a batch with an idempotency key', () => {
    const result = ItemBulkRequest.safeParse({
      idempotencyKey: '01J8F3Z9K4ABCDEFGHJKMNPQRS',
      operations: [
        { op: 'create', payload: validItemCreate, ref: 'row-1' },
        { op: 'delete', id: ULID_B },
      ],
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });

  it('refuses an empty or oversized batch', () => {
    expect(issuePaths(ItemBulkRequest.safeParse({ operations: [] }))).toEqual(['operations']);
    const tooMany = Array.from({ length: BULK_MAX_OPERATIONS + 1 }, () => ({ op: 'delete', id: ULID_B }));
    expect(issuePaths(ItemBulkRequest.safeParse({ operations: tooMany }))).toEqual(['operations']);
  });

  it('validates the payload of each operation against the resource schema', () => {
    const result = ItemBulkRequest.safeParse({
      operations: [{ op: 'create', payload: { itemType: 'Journal Article' } }],
    });
    expect(issuePaths(result)).toEqual(['operations.0.payload.itemType']);
  });

  it('rejects an idempotency key with spaces', () => {
    expect(IdempotencyKeySchema.safeParse('import run 3').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('api:cli:import-run-3').success).toBe(true);
  });

  it('reports the outcome of every operation, and whether the call was replayed', () => {
    const result = BulkResultSchema.safeParse({
      batchId: ULID_A,
      jobId: ULID_B,
      replayed: true,
      succeeded: 1,
      failed: 1,
      results: [
        { index: 0, ref: 'row-1', status: 'created', id: ULID_B },
        {
          index: 1,
          status: 'failed',
          problem: { type: CORE_PROBLEM_TYPES.conflict, title: 'Duplicate DOI', status: 409 },
        },
      ],
    });
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
  });
});

describe('health', () => {
  it('accepts a healthy server with an empty library (the Phase 0 exit criterion)', () => {
    const result = HealthResponseSchema.safeParse(validHealth);
    expect(result.success, JSON.stringify(issuePaths(result))).toBe(true);
    expect(validHealth.library?.items).toBe(0);
  });

  it('rejects an unknown status and a missing component list', () => {
    expect(issuePaths(HealthResponseSchema.safeParse({ ...validHealth, status: 'fine' }))).toEqual(['status']);
    const { components: _components, ...withoutComponents } = validHealth;
    expect(issuePaths(HealthResponseSchema.safeParse(withoutComponents))).toEqual(['components']);
  });

  it('marks which components are required, so degraded and error are distinguishable', () => {
    const optionalDown = validHealth.components.find((component) => !component.required);
    expect(optionalDown?.status).toBe('degraded');
    expect(validHealth.status).toBe('ok');
  });
});
