/**
 * The mapping, on its own.
 *
 * Pure functions, tested without a database or a server, because these are the decisions that are
 * cheapest to get wrong and cheapest to pin down: a slug, a date that must not move across a
 * timezone, a monetary string that must not go through a float, a select option whose id means
 * nothing without its label.
 */
import { describe, expect, it } from 'vitest';

import type { PaperlessCustomField, PaperlessDocument } from '../src/client/types.js';
import { planCustomField, planValue } from '../src/map/custom-fields.js';
import { documentDateOf, toDocumentDate, toInstant } from '../src/map/dates.js';
import { mapDocumentType } from '../src/map/document-types.js';
import { minorUnitExponent, parseMonetary, toMajorUnits } from '../src/map/money.js';
import { chooseFacetSources, mapOffice } from '../src/map/office.js';
import { slugify, uniqueSlug } from '../src/map/slug.js';
import { fixtureCustomFields } from '../src/testing/fixtures.js';

describe('slugify', () => {
  it('folds German so the key stays readable', () => {
    expect(slugify('Bürgeramt')).toBe('buergeramt');
    expect(slugify('Grüße & Küsse')).toBe('gruesse_and_kuesse');
    expect(slugify('Straße')).toBe('strasse');
    expect(slugify('Zeitraum von')).toBe('zeitraum_von');
  });

  it('folds other diacritics to plain ASCII', () => {
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('Ångström')).toBe('aangstroem');
  });

  it('always produces something a slug column accepts', () => {
    expect(slugify('2024 Rechnungen')).toBe('x_2024_rechnungen');
    expect(slugify('???')).toBe('unnamed');
    expect(slugify('')).toBe('unnamed');
    for (const name of ['Bürgeramt', '2024', '???', 'A B  C', '—']) {
      expect(slugify(name)).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it('numbers a collision rather than losing one of the pair', () => {
    const taken = new Set<string>();
    expect(uniqueSlug(slugify('Müller'), taken)).toBe('mueller');
    expect(uniqueSlug(slugify('Mueller'), taken)).toBe('mueller_2');
    expect(uniqueSlug(slugify('MUELLER'), taken)).toBe('mueller_3');
  });
});

describe('document types', () => {
  it('recognises the core office types in both languages', () => {
    expect(mapDocumentType({ id: 1, name: 'Rechnung' }).itemType).toBe('invoice');
    expect(mapDocumentType({ id: 1, name: 'Invoice' }).itemType).toBe('invoice');
    expect(mapDocumentType({ id: 1, name: 'Vertrag' }).itemType).toBe('contract');
    expect(mapDocumentType({ id: 1, name: 'Quittung' }).itemType).toBe('receipt');
    expect(mapDocumentType({ id: 1, name: 'Bescheinigung' }).itemType).toBe('certificate');
    expect(mapDocumentType({ id: 1, name: 'Foto' }).itemType).toBe('photo');
  });

  it('carries an unrecognised type in office_document_type rather than flattening it', () => {
    const mapped = mapDocumentType({ id: 3, name: 'Kontoauszug' });
    expect(mapped.itemType).toBe('document');
    expect(mapped.officeDocumentType).toBe('kontoauszug');
    expect(mapped.kind).toBe('carried');
  });

  it('does not match on a prefix: Rechnungsprüfung is not an invoice', () => {
    const mapped = mapDocumentType({ id: 9, name: 'Rechnungsprüfung' });
    expect(mapped.itemType).toBe('document');
    expect(mapped.officeDocumentType).toBe('rechnungspruefung');
  });

  it('handles a document with no type at all', () => {
    const mapped = mapDocumentType(null);
    expect(mapped.itemType).toBe('document');
    expect(mapped.officeDocumentType).toBeNull();
    expect(mapped.kind).toBe('absent');
  });
});

describe('dates', () => {
  it('keeps the printed calendar day when a datetime carries an offset', () => {
    // Converting to UTC first would make this the twenty-ninth of February.
    expect(toDocumentDate('2024-03-01T00:30:00+01:00')).toBe('2024-03-01');
    expect(toDocumentDate('2024-03-01T23:30:00-05:00')).toBe('2024-03-01');
  });

  it('accepts a bare calendar date, which is what API 9 and later send', () => {
    expect(toDocumentDate('2024-02-29')).toBe('2024-02-29');
  });

  it('refuses a date that does not exist', () => {
    expect(toDocumentDate('2023-02-29')).toBeNull();
    expect(toDocumentDate('not a date')).toBeNull();
    expect(toDocumentDate('')).toBeNull();
    expect(toDocumentDate(null)).toBeNull();
  });

  it('normalises an instant to the one stored form', () => {
    expect(toInstant('2024-03-02T08:15:00.000000+01:00')).toBe('2024-03-02T07:15:00.000Z');
    expect(toInstant('2024-03-02')).toBe('2024-03-02T00:00:00.000Z');
    expect(toInstant('rubbish')).toBeNull();
  });

  it('prefers `created` over the deprecated `created_date`', () => {
    expect(documentDateOf({ created: '2024-03-01', created_date: '2020-01-01' })).toBe('2024-03-01');
    expect(documentDateOf({ created_date: '2020-01-01' })).toBe('2020-01-01');
    expect(documentDateOf({})).toBeNull();
  });
});

describe('money', () => {
  it('reads the current Paperless form', () => {
    expect(parseMonetary('GBP123.45')).toStrictEqual({ minor: 12345, currency: 'GBP', raw: 'GBP123.45' });
    expect(parseMonetary('EUR-89.90')).toStrictEqual({ minor: -8990, currency: 'EUR', raw: 'EUR-89.90' });
  });

  it('reads the legacy bare-decimal form, with no currency', () => {
    expect(parseMonetary('123.45')).toStrictEqual({ minor: 12345, currency: null, raw: '123.45' });
  });

  it('takes a default currency when the value carries none', () => {
    expect(parseMonetary('123.45', { defaultCurrency: 'chf' })?.currency).toBe('CHF');
  });

  it('computes minor units from digits, never from a float', () => {
    // 1.005 * 100 is 100.49999999999999 in binary floating point, and 89.9 * 100 is 8989.999…
    expect(parseMonetary('EUR1.005')?.minor).toBe(100);
    expect(parseMonetary('EUR89.9')?.minor).toBe(8990);
    expect(parseMonetary('EUR0.07')?.minor).toBe(7);
  });

  it('respects a currency whose minor unit is not a hundredth', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(parseMonetary('JPY1200.00')?.minor).toBe(1200);
    expect(parseMonetary('KWD1.234')?.minor).toBe(1234);
    expect(toMajorUnits(1200, 'JPY')).toBe(1200);
    expect(toMajorUnits(12345, 'EUR')).toBe(123.45);
  });

  it('refuses anything that is not a monetary value', () => {
    expect(parseMonetary('')).toBeNull();
    expect(parseMonetary('abc')).toBeNull();
    expect(parseMonetary(null)).toBeNull();
    expect(parseMonetary({})).toBeNull();
  });
});

describe('custom field definitions', () => {
  const fields = fixtureCustomFields();
  const find = (id: number): PaperlessCustomField =>
    fields.find((field) => field.id === id) as PaperlessCustomField;

  it('preserves every supported Paperless type', () => {
    expect(planCustomField(find(1), 'betrag').dataType).toBe('monetary');
    expect(planCustomField(find(2), 'rechnungsnummer').dataType).toBe('text');
    expect(planCustomField(find(3), 'zeitraum_von').dataType).toBe('date');
    expect(planCustomField(find(5), 'status').dataType).toBe('choice');
    expect(planCustomField(find(6), 'links').dataType).toBe('item_reference');
    expect(planCustomField(find(7), 'bemerkung').dataType).toBe('long_text');
    expect(planCustomField(find(8), 'bezahlt').dataType).toBe('boolean');
    expect(planCustomField(find(9), 'seitenzahl').dataType).toBe('integer');
    expect(planCustomField(find(10), 'bewertung').dataType).toBe('number');
    expect(planCustomField(find(11), 'webseite').dataType).toBe('url');
  });

  it('makes documentlink repeatable, because Recueil holds one reference per slot', () => {
    expect(planCustomField(find(6), 'links').isRepeatable).toBe(true);
    expect(planCustomField(find(2), 'rechnungsnummer').isRepeatable).toBe(false);
  });

  it('keeps a select field reversible: labels as choices, ids alongside', () => {
    const plan = planCustomField(find(5), 'status');
    expect(plan.config['choices']).toStrictEqual(['offen', 'bezahlt']);
    expect(plan.config['paperlessOptionIds']).toStrictEqual({
      offen: 'aBcD1234aBcD1234',
      bezahlt: 'eFgH5678eFgH5678',
    });
  });

  it('refuses a data type it has never heard of instead of guessing text', () => {
    const plan = planCustomField(find(13), 'zukunftsfeld');
    expect(plan.unsupportedReason).toMatch(/quantum/u);
    expect(planValue(plan, 'anything', { resolveDocument: () => undefined })).toStrictEqual({
      kind: 'skipped',
      reason: plan.unsupportedReason,
    });
  });
});

describe('custom field values', () => {
  const fields = fixtureCustomFields();
  const planFor = (id: number, key: string) =>
    planCustomField(fields.find((field) => field.id === id) as PaperlessCustomField, key);
  const noDocuments = { resolveDocument: () => undefined };

  it('turns a select option id into its label', () => {
    const plan = planFor(5, 'status');
    expect(planValue(plan, 'eFgH5678eFgH5678', noDocuments)).toStrictEqual({
      kind: 'values',
      values: [{ ordinal: 0, content: { type: 'choice', value: 'bezahlt' } }],
    });
  });

  it('skips a select option id the field does not define, rather than storing the id', () => {
    const result = planValue(planFor(5, 'status'), 'zZzZ0000zZzZ0000', noDocuments);
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.reason).toMatch(/select_options/u);
  });

  it('expands a documentlink into one slot per link', () => {
    const resolve = (id: number) => (id === 1 ? 'item-one' : id === 2 ? 'item-two' : undefined);
    const result = planValue(planFor(6, 'links'), [1, 2], { resolveDocument: resolve });
    expect(result).toStrictEqual({
      kind: 'values',
      values: [
        { ordinal: 0, content: { type: 'item_reference', value: 'item-one' } },
        { ordinal: 1, content: { type: 'item_reference', value: 'item-two' } },
      ],
    });
  });

  it('reports a documentlink target outside the import instead of writing a dangling id', () => {
    const resolve = (id: number) => (id === 2 ? 'item-two' : undefined);
    const result = planValue(planFor(6, 'links'), [2, 999], { resolveDocument: resolve });
    expect(result.kind).toBe('partial');
    expect(result.kind === 'partial' && result.unresolved).toStrictEqual([999]);
    expect(result.kind === 'partial' && result.values).toHaveLength(1);
  });

  it('records an absent value as blank rather than as nothing', () => {
    expect(planValue(planFor(2, 'rechnungsnummer'), null, noDocuments)).toStrictEqual({ kind: 'blank' });
  });

  it('refuses a URL that is not one', () => {
    expect(planValue(planFor(11, 'webseite'), 'https://ok.example', noDocuments).kind).toBe('values');
    expect(planValue(planFor(11, 'webseite'), 'javascript:alert(1)', noDocuments).kind).toBe('skipped');
    expect(planValue(planFor(11, 'webseite'), 'not a url', noDocuments).kind).toBe('skipped');
  });

  it('refuses a value whose shape contradicts its declared type', () => {
    expect(planValue(planFor(8, 'bezahlt'), 'ja', noDocuments).kind).toBe('skipped');
    expect(planValue(planFor(9, 'seitenzahl'), 1.5, noDocuments).kind).toBe('skipped');
    expect(planValue(planFor(3, 'zeitraum_von'), '31.12.2024', noDocuments).kind).toBe('skipped');
  });
});

describe('the Office facet', () => {
  const fields = fixtureCustomFields();

  it('picks its source fields by name, in German', () => {
    const sources = chooseFacetSources(fields);
    expect(sources.amountFieldId).toBe(1);
    expect(sources.referenceNumberFieldId).toBe(2);
    expect(sources.periodStartFieldId).toBe(3);
    expect(sources.periodEndFieldId).toBe(4);
    expect(sources.dueDateFieldId).toBe(12);
  });

  it('takes neither of two candidates rather than guessing', () => {
    const ambiguous = [
      ...fields,
      { id: 99, name: 'Gesamtbetrag', data_type: 'monetary' as const, extra_data: null },
    ];
    const sources = chooseFacetSources(ambiguous);
    expect(sources.amountFieldId).toBeNull();
    const decision = sources.decisions.find((row) => row.column === 'amount');
    expect(decision?.outcome).toBe('ambiguous');
    expect(decision?.detail).toMatch(/Taking none/u);
  });

  it('honours a nomination, and reports one that cannot work', () => {
    expect(chooseFacetSources(fields, { amountField: 'Betrag' }).amountFieldId).toBe(1);
    const wrongType = chooseFacetSources(fields, { amountField: 'Bezahlt' });
    expect(wrongType.amountFieldId).toBeNull();
    expect(wrongType.decisions.find((row) => row.column === 'amount')?.detail).toMatch(/cannot feed/u);
  });

  const document = (overrides: Partial<PaperlessDocument> = {}): PaperlessDocument => ({
    id: 1,
    correspondent: 1,
    document_type: 1,
    title: 'Test',
    tags: [],
    created: '2024-03-01',
    archive_serial_number: 1001,
    ...overrides,
  });

  const context = (values: Array<[number, unknown]>, extra: Record<string, unknown> = {}) => ({
    correspondentName: 'Stadtwerke Ulm',
    sources: chooseFacetSources(fields),
    values: new Map(values),
    fields: new Map(fields.map((field) => [field.id, field])),
    ...extra,
  });

  it('maps the native three and the nominated rest', () => {
    const office = mapOffice(
      document(),
      context([
        [1, 'EUR89.90'],
        [2, 'RE-2024-0031'],
        [12, '2024-03-20'],
      ]),
    );

    expect(office.correspondent).toBe('Stadtwerke Ulm');
    expect(office.correspondentNormalised).toBe('stadtwerke ulm');
    expect(office.documentDate).toBe('2024-03-01');
    expect(office.asn).toBe(1001);
    expect(office.amountMinor).toBe(8990);
    expect(office.amountCurrency).toBe('EUR');
    expect(office.referenceNumber).toBe('RE-2024-0031');
    expect(office.dueDate).toBe('2024-03-20');
    expect(office.notes).toStrictEqual([]);
  });

  it('uses the placeholder when Paperless has no correspondent, and says so', () => {
    const office = mapOffice(
      document({ correspondent: null }),
      context([], { correspondentName: null, missingCorrespondentLabel: 'Unbekannt' }),
    );
    expect(office.correspondent).toBe('Unbekannt');
    expect(office.correspondentIsPlaceholder).toBe(true);
  });

  it('leaves the amount empty rather than guessing a currency', () => {
    const office = mapOffice(document(), context([[1, '123.45']]));
    expect(office.amountMinor).toBeNull();
    expect(office.amountCurrency).toBeNull();
    expect(office.notes.join(' ')).toMatch(/ck_item_office_amount/u);
  });

  it('drops a period that runs backwards, because the check constraint refuses it', () => {
    const office = mapOffice(
      document(),
      context([
        [3, '2026-09-30'],
        [4, '2023-10-01'],
      ]),
    );
    expect(office.periodStart).toBeNull();
    expect(office.periodEnd).toBeNull();
    expect(office.notes.join(' ')).toMatch(/backwards/u);
  });
});
