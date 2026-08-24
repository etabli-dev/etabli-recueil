/**
 * The client against the contract it restates.
 *
 * Three constants in `src/api` are copies of values that belong to `@recueil/schemas`: the API base
 * path, the problem-type table and the maximum page size. They are copies for one reason —
 * importing them would pull the Zod runtime into a browser bundle that never validates anything —
 * and copies are only safe if something fails when they drift. This is that something.
 */
import { API_BASE_PATH as CONTRACT_BASE_PATH } from '@recueil/schemas/openapi';
import {
  CORE_PROBLEM_TYPES as CONTRACT_PROBLEM_TYPES,
  MAX_PAGE_SIZE as CONTRACT_MAX_PAGE_SIZE,
  PROBLEM_CONTENT_TYPE as CONTRACT_CONTENT_TYPE,
  PageInfoSchema,
} from '@recueil/schemas';
import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, MAX_PAGE_SIZE } from '../src/api/client.js';
import { CORE_PROBLEM_TYPES, PROBLEM_CONTENT_TYPE } from '../src/api/problem.js';

describe('the restated contract constants', () => {
  it('uses the API base path the OpenAPI document declares', () => {
    expect(API_BASE_PATH).toBe(CONTRACT_BASE_PATH);
  });

  it('uses the problem content type the server sends', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe(CONTRACT_CONTENT_TYPE);
  });

  it('carries exactly the problem types the contract defines', () => {
    expect(CORE_PROBLEM_TYPES).toEqual(CONTRACT_PROBLEM_TYPES);
  });

  it('uses the maximum page size the contract declares', () => {
    expect(MAX_PAGE_SIZE).toBe(CONTRACT_MAX_PAGE_SIZE);
  });

  /**
   * Why the ceiling is hard rather than advisory, asserted against the real schema.
   *
   * `PageInfoSchema` validates the page block the server *sends*. A listing route may accept a
   * larger `limit` in its query string — `routes/ingestion-review.ts` accepts up to 500 — but the
   * response it then builds fails this schema, so the caller gets a 500 rather than a short page.
   * That is the trap this constant exists to keep the client out of, and this is the proof it is
   * a real trap and not a cautious guess.
   */
  it('rejects a page block whose limit exceeds the ceiling, which is why the client may not ask for one', () => {
    const page = { nextCursor: null, hasMore: false, limit: MAX_PAGE_SIZE };
    expect(PageInfoSchema.safeParse(page).success).toBe(true);
    expect(PageInfoSchema.safeParse({ ...page, limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
  });
});
