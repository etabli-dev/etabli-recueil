import { describe, expect, it } from 'vitest';

import {
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
