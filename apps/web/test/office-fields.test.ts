/**
 * Money, which is the part of the office facet that is easy to get subtly wrong.
 *
 * `ck_item_office_amount` stores minor units and a currency code, and the whole reason it is an
 * integer is that a float is wrong: `Number('1.005') * 100` is 100.49999999999999, and an invoice
 * that rounds to the wrong cent is a defect nobody finds until a reconciliation.
 */
import { describe, expect, it } from 'vitest';

import { OFFICE_FIELDS, currencyExponent, decimalToMinor, minorToDecimal, officeFieldGroups } from '../src/item-pane/office-fields.js';

describe('currencyExponent', () => {
  it('asks the runtime rather than assuming two places', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('falls back to two for a code it does not recognise', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
  });
});

describe('minorToDecimal', () => {
  it('renders minor units with the currency’s own number of places', () => {
    expect(minorToDecimal(129_900, 'EUR')).toBe('1299.00');
    expect(minorToDecimal(1299, 'JPY')).toBe('1299');
    expect(minorToDecimal(1299, 'KWD')).toBe('1.299');
  });

  it('pads a value smaller than one unit', () => {
    expect(minorToDecimal(5, 'EUR')).toBe('0.05');
  });

  it('keeps the sign in front', () => {
    expect(minorToDecimal(-1250, 'EUR')).toBe('-12.50');
  });
});

describe('decimalToMinor', () => {
  it('reads the digits rather than multiplying a float', () => {
    expect(decimalToMinor('1299.00', 'EUR')).toEqual({ ok: true, minor: 129_900 });
    expect(decimalToMinor('1.005', 'KWD')).toEqual({ ok: true, minor: 1005 });
  });

  it('accepts a comma as the decimal separator, because a German invoice is written that way', () => {
    expect(decimalToMinor('1299,00', 'EUR')).toEqual({ ok: true, minor: 129_900 });
  });

  it('pads a short fraction rather than misreading it', () => {
    expect(decimalToMinor('12.5', 'EUR')).toEqual({ ok: true, minor: 1250 });
  });

  it('refuses more decimal places than the currency has', () => {
    const result = decimalToMinor('12.345', 'EUR');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('2 decimal places');
    expect(decimalToMinor('12.5', 'JPY').ok).toBe(false);
  });

  it('reads an emptied field as "no amount", which is not zero', () => {
    expect(decimalToMinor('  ', 'EUR')).toEqual({ ok: true, minor: null });
    expect(decimalToMinor('0', 'EUR')).toEqual({ ok: true, minor: 0 });
  });

  it('refuses text', () => {
    expect(decimalToMinor('twelve', 'EUR').ok).toBe(false);
    expect(decimalToMinor('.', 'EUR').ok).toBe(false);
  });

  it('refuses a value it could not record exactly', () => {
    expect(decimalToMinor('999999999999999999.99', 'EUR').ok).toBe(false);
  });
});

describe('the field table', () => {
  it('covers every member CONCEPT.md §5.2 names for the facet', () => {
    const paths = OFFICE_FIELDS.map((field) => field.path);
    expect(paths).toEqual(
      expect.arrayContaining(['correspondent', 'documentDate', 'asn', 'referenceNumber']),
    );
  });

  it('does not put the amount in the table: it is one control writing two columns', () => {
    const paths = OFFICE_FIELDS.map((field) => String(field.path));
    expect(paths).not.toContain('amountMinor');
    expect(paths).not.toContain('amountCurrency');
  });

  it('groups in table order without repeating a group', () => {
    const groups = officeFieldGroups().map((group) => group.group);
    expect(groups).toEqual([...new Set(groups)]);
  });
});
