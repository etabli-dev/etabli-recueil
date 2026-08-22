/**
 * The client against the contract it restates.
 *
 * Two constants in `src/api` are copies of values that belong to `@recueil/schemas`: the API base
 * path and the problem-type table. They are copies for one reason — importing them would pull the
 * Zod runtime into a browser bundle that never validates anything — and copies are only safe if
 * something fails when they drift. This is that something.
 */
import { API_BASE_PATH as CONTRACT_BASE_PATH } from '@recueil/schemas/openapi';
import {
  CORE_PROBLEM_TYPES as CONTRACT_PROBLEM_TYPES,
  PROBLEM_CONTENT_TYPE as CONTRACT_CONTENT_TYPE,
} from '@recueil/schemas';
import { describe, expect, it } from 'vitest';

import { API_BASE_PATH } from '../src/api/client.js';
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
});
