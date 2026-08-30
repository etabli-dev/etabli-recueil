/**
 * The resource budgets `@recueil/core` enforces on input from outside (ADR-0022).
 *
 * `@recueil/core` is the widest-reach package in the repository: the server, the CLI, every
 * importer and every plugin reach these functions directly, and only one of those callers has a
 * route schema in front of it. So the bound belongs to the call, not to the caller — "the server
 * limits the body" is not a property of `parseSearchQuery`.
 *
 * Everything here is a regression for something that was reproduced first. The search parser threw
 * `RangeError: Maximum call stack size exceeded` on 5 000 open brackets, which is neither a refusal
 * a caller can render nor a limit anyone named; the cursor decoder allocated three quarters of
 * whatever string it was handed before looking at its shape.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_CURSOR_LENGTH,
  MAX_QUERY_DEPTH,
  MAX_QUERY_LENGTH,
  ResourceBudgetError,
  compileSearchQuery,
  decodeCursor,
  encodeCursor,
  parseSearchQuery,
} from '../src/index.js';

describe('the search query compiler is bounded', () => {
  it('refuses a query that nests deeper than the stack should be asked to go', () => {
    // 5 000 of these used to be a RangeError out of V8 rather than anything a search box could
    // render. Well inside MAX_QUERY_LENGTH, so it is the depth bound that has to catch it.
    const nested = '('.repeat(1_000);
    expect(nested.length).toBeLessThan(MAX_QUERY_LENGTH);

    let thrown: unknown;
    try {
      parseSearchQuery(nested);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as Error).message).toContain(String(MAX_QUERY_DEPTH));
    expect((thrown as Error).name).not.toBe('RangeError');
  });

  it('refuses a stack of leading exclusions, which recurse the same way', () => {
    expect(() => parseSearchQuery(`${'-'.repeat(1_000)}sepsis`)).toThrow(ResourceBudgetError);
  });

  it('refuses a query longer than it will read, naming the limit', () => {
    let thrown: unknown;
    try {
      compileSearchQuery('a '.repeat(MAX_QUERY_LENGTH));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as Error).message).toContain(String(MAX_QUERY_LENGTH));
  });

  it('still compiles the queries the language is for', () => {
    expect(compileSearchQuery('(sepsis OR septicaemia) mortality')).toContain('OR');
    expect(compileSearchQuery('title:sepsis -draft')).toContain('NOT');
    expect(compileSearchQuery('((((nested))))')).toBe('("nested")');
  });
});

describe('the cursor decoder is bounded', () => {
  it('refuses a token far larger than any it issues, before decoding it', () => {
    let thrown: unknown;
    try {
      decodeCursor('A'.repeat(MAX_CURSOR_LENGTH + 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as Error).message).toContain(String(MAX_CURSOR_LENGTH));
  });

  it('still round-trips the tokens it issues', () => {
    const token = encodeCursor({ k: '2026-08-26T00:00:00.000Z', i: '01J8F3Z9K4ABCDEFGHJKMNPQRS' });
    expect(token.length).toBeLessThan(MAX_CURSOR_LENGTH);
    expect(decodeCursor(token)).toEqual({
      k: '2026-08-26T00:00:00.000Z',
      i: '01J8F3Z9K4ABCDEFGHJKMNPQRS',
    });
  });
});
