import { describe, expect, it } from 'vitest';

import {
  CALENDAR_DATE_PATTERN,
  EDTF_PATTERN,
  PROVENANCE_SOURCE_PATTERN,
  PUBLIC_ID_PATTERN,
  SLUG_PATTERN,
  TIMESTAMP_PATTERN,
  ULID_PATTERN,
  CalendarDateSchema,
  CurrencyCodeSchema,
  EdtfDateSchema,
  HexColourSchema,
  IdSchema,
  JsonObjectSchema,
  LanguageTagSchema,
  PublicIdSchema,
  Sha256Schema,
  SlugSchema,
  TimestampSchema,
  UrlSchema,
  isValidIsbn13,
  isValidIssn,
  isValidOrcid,
} from '../src/index.js';
import { ULID_A } from './fixtures.js';

describe('identifiers', () => {
  it('accepts a Crockford base32 ULID', () => {
    expect(IdSchema.parse(ULID_A)).toBe(ULID_A);
  });

  it.each([
    ['too short', '01J8F3Z9K4'],
    ['lower case', ULID_A.toLowerCase()],
    ['contains I, L, O or U', '01J8F3Z9K4ABCDEFGHIKMNPQRS'],
    ['contains a hyphen', '01J8F3Z9K4-BCDEFGHJKMNPQR'],
  ])('rejects a ULID that is %s', (_label, value) => {
    expect(IdSchema.safeParse(value).success).toBe(false);
  });

  it('accepts an eight-character public id and rejects other lengths', () => {
    expect(PublicIdSchema.safeParse('A1B2C3D4').success).toBe(true);
    expect(PublicIdSchema.safeParse('A1B2C3D').success).toBe(false);
    expect(PublicIdSchema.safeParse('a1b2c3d4').success).toBe(false);
  });

  it('requires a SHA-256 to be 64 lowercase hex characters', () => {
    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(Sha256Schema.parse(digest)).toBe(digest);
    expect(Sha256Schema.safeParse(digest.toUpperCase()).success).toBe(false);
    expect(Sha256Schema.safeParse(digest.slice(0, 63)).success).toBe(false);
  });
});

describe('time', () => {
  it('accepts only the fixed-width UTC timestamp form', () => {
    expect(TimestampSchema.parse('2026-08-22T09:15:00.000Z')).toBe('2026-08-22T09:15:00.000Z');
  });

  it.each([
    ['no fractional digits', '2026-08-22T09:15:00Z'],
    ['an offset instead of Z', '2026-08-22T09:15:00.000+02:00'],
    ['a space separator', '2026-08-22 09:15:00.000Z'],
    ['a date alone', '2026-08-22'],
  ])('rejects a timestamp with %s', (_label, value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a calendar date that does not exist', () => {
    expect(CalendarDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(CalendarDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(CalendarDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it.each(['2019', '2019-04', '2019-04-01', '2019-04-01/2019-04-03', '1920~', '2019?', '../2019', '2019/..'])(
    'accepts the EDTF value %s',
    (value) => {
      expect(EdtfDateSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['19', 'March 2019', '2019-4', '2019-04-01T00:00:00.000Z'])(
    'rejects the EDTF value %s',
    (value) => {
      expect(EdtfDateSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('small scalars', () => {
  it('validates colours, currencies, language tags and slugs', () => {
    expect(HexColourSchema.safeParse('#ffd400').success).toBe(true);
    expect(HexColourSchema.safeParse('red').success).toBe(false);
    expect(CurrencyCodeSchema.safeParse('EUR').success).toBe(true);
    expect(CurrencyCodeSchema.safeParse('eur').success).toBe(false);
    expect(LanguageTagSchema.safeParse('en-GB').success).toBe(true);
    expect(LanguageTagSchema.safeParse('English').success).toBe(false);
    expect(SlugSchema.safeParse('sample_size').success).toBe(true);
    expect(SlugSchema.safeParse('Sample Size').success).toBe(false);
    expect(SlugSchema.safeParse('1_first').success).toBe(false);
  });

  it('requires an absolute http(s) URL', () => {
    expect(UrlSchema.safeParse('https://example.org/a.pdf').success).toBe(true);
    expect(UrlSchema.safeParse('/relative/path').success).toBe(false);
    expect(UrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });

  it('accepts nested JSON objects', () => {
    const value = { a: 1, b: [true, null, { c: 'd' }] };
    expect(JsonObjectSchema.parse(value)).toEqual(value);
    expect(JsonObjectSchema.safeParse({ a: undefined }).success).toBe(false);
  });
});

describe('check digits', () => {
  it('verifies ISBN-13 check digits', () => {
    expect(isValidIsbn13('9780262035613')).toBe(true);
    expect(isValidIsbn13('9780262035614')).toBe(false);
    expect(isValidIsbn13('978026203561')).toBe(false);
  });

  it('verifies ISSN check digits, including the X form', () => {
    expect(isValidIssn('0959-8138')).toBe(true);
    expect(isValidIssn('2049-3630')).toBe(true);
    expect(isValidIssn('0959-8139')).toBe(false);
  });

  it('verifies ORCID check digits', () => {
    expect(isValidOrcid('0000-0002-1825-0097')).toBe(true);
    expect(isValidOrcid('0000-0002-1825-0098')).toBe(false);
  });
});

/**
 * Every pattern in this package runs against strings from outside (ADR-0022 §4).
 *
 * A Zod `.regex()` is a native `RegExp` over whatever arrives in a request body, an imported
 * record or a third-party API response. The patterns here are all anchored, and their quantifiers
 * are either counted or over classes that cannot overlap their neighbours, so none of them can
 * backtrack — but "cannot backtrack" is a claim, and this is the test that makes it one the build
 * checks rather than one a reviewer asserted.
 *
 * Two of them were not safe as written, and the failure was not backtracking. `LanguageTagSchema`'s
 * `(?:-[A-Za-z0-9]{2,8})*` and `wikidataId`'s `\d+` are linear in the input rather than in the
 * pattern, and V8's engine recurses on a repeated group: an 11.4 MB language tag — inside the
 * server's own 16 MiB body limit — threw `RangeError: Maximum call stack size exceeded` out of
 * `RegExp.test`, i.e. out of validation, as a 500 rather than a 422. Both now carry a `max()`, and
 * the length bound is what this test defends.
 */
describe('every pattern is bounded over hostile input (ADR-0022 §4)', () => {
  const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['Id', ULID_PATTERN],
    ['PublicId', PUBLIC_ID_PATTERN],
    ['Timestamp', TIMESTAMP_PATTERN],
    ['CalendarDate', CALENDAR_DATE_PATTERN],
    ['Edtf', EDTF_PATTERN],
    ['Slug', SLUG_PATTERN],
    ['ProvenanceSource', PROVENANCE_SOURCE_PATTERN],
    ['fieldName', /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/u],
    ['sha256', /^[0-9a-f]{64}$/u],
    ['hexColour', /^#[0-9a-fA-F]{6}$/u],
    ['bcp47', /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,12}$/u],
    ['cursorToken', /^[A-Za-z0-9_-]+$/u],
    ['bulkId', /^[A-Za-z0-9._:-]+$/u],
    ['orcid', /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/u],
    ['ror', /^0[0-9a-hjkmnp-z]{6}\d{2}$/u],
    ['doi', /^10\.\d{4,9}\/\S+$/u],
    ['pmid', /^[1-9]\d{0,8}$/u],
    ['pmcid', /^PMC\d{1,10}$/u],
    ['isbn13', /^\d{13}$/u],
    ['issn', /^\d{4}-\d{3}[\dX]$/u],
    ['openalexWork', /^W\d{2,12}$/u],
    ['citationKey', /^[A-Za-z0-9][A-Za-z0-9:_.+#$%&\-/]*$/u],
    ['mime', /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu],
    ['wikidata', /^Q\d+$/u],
  ];

  // Seeds chosen to sit on each pattern's own alphabet, so the match runs rather than failing on
  // the first character: a prefix that cannot match is not an attack on anything.
  const SEEDS = ['a', 'A', '0', '-', '.', ':', '/', 'a-', '0-', 'ab-cd', 'Q1', 'W1', 'PMC1', '10.1000/'];

  it.each(PATTERNS)('%s decides a long string in linear time', (name, pattern) => {
    for (const seed of SEEDS) {
      const input = seed.repeat(Math.ceil(200_000 / seed.length)).slice(0, 200_000);
      const started = performance.now();
      pattern.test(input);
      const elapsed = performance.now() - started;
      expect(elapsed, `${name} over ${JSON.stringify(seed)} took ${elapsed.toFixed(1)} ms`).toBeLessThan(100);
    }
  });

  it('refuses a language tag no stack can hold, as a validation failure rather than a RangeError', () => {
    // 11.4 MB is inside the server's own body limit, and the open `*` made `RegExp.test` recurse
    // until V8 gave up. Note that `.max(64)` is not what saves it: Zod runs every check and
    // collects the issues, so the pattern is applied to the long string anyway — the counted
    // repetition is the fix, and the length bound is the belt.
    const monstrous = `en${'-abcd'.repeat(2_400_000)}`;
    expect(monstrous.length).toBeGreaterThan(11_000_000);

    const started = performance.now();
    const result = LanguageTagSchema.safeParse(monstrous);
    const elapsed = performance.now() - started;

    expect(result.success).toBe(false);
    expect(elapsed, `validating an 11 MB tag took ${elapsed.toFixed(0)} ms`).toBeLessThan(1_000);

    expect(LanguageTagSchema.parse('en-GB')).toBe('en-GB');
    expect(LanguageTagSchema.parse('zh-Hans-CN')).toBe('zh-Hans-CN');
    expect(LanguageTagSchema.parse('de-CH-1901')).toBe('de-CH-1901');
    expect(LanguageTagSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});
