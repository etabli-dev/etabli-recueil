/**
 * Custom fields and their typed values (§4.6, §4.7).
 *
 * The point of the typed columns is that a wrong type is caught at the boundary. So most of this
 * file is about refusals: a `text` value offered to an `integer` field, a choice that is not one of
 * the choices, an ordinal on a field that is not repeatable, a type change after the fact, a delete
 * with values behind it. The happy paths are here to prove the columns are the ones §4.7 names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { InvariantError, ValidationError, schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const item = (itemType = 'article') =>
  library.library.createItem({ itemType }, library.actor).item;

describe('CustomFieldService — definitions', () => {
  it('defines a field and refuses a key that is not a slug', () => {
    const field = library.customFields.define(
      { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
      library.actor,
    );
    expect(field.fieldKey).toBe('sample_size');
    expect(field.dataType).toBe('integer');
    expect(field.scope).toBe('library');

    expect(() =>
      library.customFields.define(
        { fieldKey: 'Sample Size', name: 'x', dataType: 'text' },
        library.actor,
      ),
    ).toThrow(/slug/iu);
  });

  it('refuses a duplicate key', () => {
    library.customFields.define({ fieldKey: 'arm', name: 'Arm', dataType: 'text' }, library.actor);
    expect(() =>
      library.customFields.define({ fieldKey: 'arm', name: 'Arm again', dataType: 'text' }, library.actor),
    ).toThrow(/already exists/iu);
  });

  it('has no way to change the data type — CF1 is enforced by the shape of the API', () => {
    const field = library.customFields.define(
      { fieldKey: 'dose', name: 'Dose', dataType: 'number' },
      library.actor,
    );
    // `UpdateCustomFieldInput` carries neither `dataType` nor `fieldKey`, so the only way to change
    // the type is to define a new field and migrate — which is exactly what CF1 says.
    const updated = library.customFields.updateField(field.id, { name: 'Dose (mg)' }, library.actor);
    expect(updated.name).toBe('Dose (mg)');
    expect(updated.dataType).toBe('number');
    expect(updated.fieldKey).toBe('dose');
  });

  it('refuses to delete a field with values, and allows it once they are gone (CF2)', () => {
    const field = library.customFields.define(
      { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
      library.actor,
    );
    const subject = item();
    library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, content: { type: 'integer', value: 120 } },
      library.actor,
    );

    expect(() => library.customFields.removeField(field.id, library.actor)).toThrow(InvariantError);
    expect(() => library.customFields.removeField(field.id, library.actor)).toThrow(/CF2/u);

    library.customFields.clearValue({ fieldId: field.id, itemId: subject.id }, library.actor);
    expect(() => library.customFields.removeField(field.id, library.actor)).not.toThrow();
  });
});

describe('CustomFieldService — typed values (FV1)', () => {
  it('rejects a value whose type is not the field type, naming both', () => {
    const field = library.customFields.define(
      { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
      library.actor,
    );
    const subject = item();

    try {
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'text', value: 'quite a lot' } },
        library.actor,
      );
      throw new Error('the wrongly typed value should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantError);
      const problem = error as InvariantError;
      expect(problem.detail?.['invariant']).toBe('FV1');
      expect(problem.detail?.['declared']).toBe('integer');
      expect(problem.detail?.['offered']).toBe('text');
    }

    // And nothing was written.
    expect(library.customFields.getValue({ fieldId: field.id, itemId: subject.id })).toBeUndefined();
  });

  it('rejects a malformed value of the right type', () => {
    const field = library.customFields.define(
      { fieldKey: 'assessed_on', name: 'Assessed on', dataType: 'date' },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'date', value: '4th of July' } },
        library.actor,
      ),
    ).toThrow(ValidationError);
  });

  it('puts each data type in the column §4.7 names for it', () => {
    const subject = item();
    const cases: Array<[string, Parameters<typeof library.customFields.setValue>[0]['content'], keyof schema.FieldValueRow, unknown]> = [
      ['text', { type: 'text', value: 'hello' }, 'valueText', 'hello'],
      ['number', { type: 'number', value: 1.5 }, 'valueNumber', 1.5],
      ['integer', { type: 'integer', value: 7 }, 'valueInteger', 7],
      ['boolean', { type: 'boolean', value: true }, 'valueBoolean', true],
      ['date', { type: 'date', value: '2026-08-22' }, 'valueDate', '2026-08-22'],
      ['json', { type: 'json', value: { a: 1 } }, 'valueJson', '{"a":1}'],
    ];

    for (const [dataType, content, column, expected] of cases) {
      const field = library.customFields.define(
        { fieldKey: `f_${dataType}`, name: dataType, dataType: dataType as 'text' },
        library.actor,
      );
      const stored = library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content },
        library.actor,
      );
      expect(stored.row[column]).toEqual(expected);
      expect(stored.content).toEqual(content);
    }
  });

  it('validates a choice against the field configuration', () => {
    const field = library.customFields.define(
      {
        fieldKey: 'study_design',
        name: 'Study design',
        dataType: 'choice',
        config: { choices: ['rct', 'cohort', 'case_control'] },
      },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'choice', value: 'anecdote' } },
        library.actor,
      ),
    ).toThrow(/not one of the choices/iu);

    const stored = library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, content: { type: 'choice', value: 'rct' } },
      library.actor,
    );
    expect(stored.row.valueText).toBe('rct');
  });

  it('validates every member of a multi-choice, and stores it as JSON', () => {
    const field = library.customFields.define(
      {
        fieldKey: 'outcomes',
        name: 'Outcomes',
        dataType: 'multi_choice',
        config: { choices: ['mortality', 'los', 'readmission'] },
      },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        {
          fieldId: field.id,
          itemId: subject.id,
          content: { type: 'multi_choice', value: ['mortality', 'vibes'] },
        },
        library.actor,
      ),
    ).toThrow(/'vibes'/u);

    const stored = library.customFields.setValue(
      {
        fieldId: field.id,
        itemId: subject.id,
        content: { type: 'multi_choice', value: ['mortality', 'los'] },
      },
      library.actor,
    );
    expect(stored.row.valueJson).toBe('["mortality","los"]');
    expect(stored.content).toEqual({ type: 'multi_choice', value: ['mortality', 'los'] });
  });

  it('enforces a numeric range from the configuration', () => {
    const field = library.customFields.define(
      { fieldKey: 'quality', name: 'Quality', dataType: 'integer', config: { min: 0, max: 10 } },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'integer', value: 11 } },
        library.actor,
      ),
    ).toThrow(/maximum of 10/u);
  });

  it('resolves an item reference and refuses one of the wrong item type', () => {
    const field = library.customFields.define(
      {
        fieldKey: 'protocol',
        name: 'Protocol',
        dataType: 'item_reference',
        config: { targetItemTypes: ['report'] },
      },
      library.actor,
    );
    const subject = item();
    const article = item('article');
    const report = item('report');

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'item_reference', value: article.id } },
        library.actor,
      ),
    ).toThrow(/references items of type/iu);

    const stored = library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, content: { type: 'item_reference', value: report.id } },
      library.actor,
    );
    expect(stored.row.valueItemId).toBe(report.id);
  });

  it('refuses a field that does not apply to the item type', () => {
    const field = library.customFields.define(
      { fieldKey: 'asn_note', name: 'ASN note', dataType: 'text', appliesToItemTypes: ['invoice'] },
      library.actor,
    );
    const article = item('article');

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: article.id, content: { type: 'text', value: 'x' } },
        library.actor,
      ),
    ).toThrow(/does not apply/iu);
  });
});

describe('CustomFieldService — slots and blanks', () => {
  it('refuses an ordinal above zero on a field that is not repeatable (FV3)', () => {
    const field = library.customFields.define(
      { fieldKey: 'arm', name: 'Arm', dataType: 'text' },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, ordinal: 1, content: { type: 'text', value: 'B' } },
        library.actor,
      ),
    ).toThrow(/FV3/u);
  });

  it('keeps repeatable values in separate slots, keyed by group and ordinal', () => {
    const field = library.customFields.define(
      { fieldKey: 'arm', name: 'Arm', dataType: 'text', isRepeatable: true },
      library.actor,
    );
    const subject = item();

    library.customFields.setValue(
      { fieldKey: 'arm', itemId: subject.id, ordinal: 0, content: { type: 'text', value: 'placebo' } },
      library.actor,
    );
    library.customFields.setValue(
      { fieldKey: 'arm', itemId: subject.id, ordinal: 1, content: { type: 'text', value: 'drug' } },
      library.actor,
    );
    library.customFields.setValue(
      {
        fieldKey: 'arm',
        itemId: subject.id,
        groupKey: 'outcome:mortality',
        content: { type: 'text', value: 'drug' },
      },
      library.actor,
    );

    expect(library.customFields.listValues(subject.id)).toHaveLength(3);
    expect(
      library.customFields.getValue({ fieldKey: 'arm', itemId: subject.id, ordinal: 1 })?.content,
    ).toEqual({ type: 'text', value: 'drug' });
    void field;
  });

  it('writing the same slot twice updates it rather than duplicating (P9)', () => {
    const field = library.customFields.define(
      { fieldKey: 'n', name: 'N', dataType: 'integer' },
      library.actor,
    );
    const subject = item();

    library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, content: { type: 'integer', value: 1 } },
      library.actor,
    );
    library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, content: { type: 'integer', value: 2 } },
      library.actor,
    );

    const rows = library.db
      .select()
      .from(schema.fieldValues)
      .where(eq(schema.fieldValues.itemId, subject.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueInteger).toBe(2);
  });

  it('records an explicit blank, which is not the same as an absent row', () => {
    const field = library.customFields.define(
      { fieldKey: 'n', name: 'N', dataType: 'integer' },
      library.actor,
    );
    const subject = item();

    const blank = library.customFields.setValue(
      { fieldId: field.id, itemId: subject.id, isBlank: true },
      library.actor,
    );
    expect(blank.row.isBlank).toBe(true);
    expect(blank.content).toBeNull();
    expect(blank.row.valueInteger).toBeNull();

    // "Recorded as not reported" is a row; "not yet extracted" is no row at all.
    expect(library.customFields.getValue({ fieldId: field.id, itemId: subject.id })).toBeDefined();
    library.customFields.clearValue({ fieldId: field.id, itemId: subject.id }, library.actor);
    expect(library.customFields.getValue({ fieldId: field.id, itemId: subject.id })).toBeUndefined();
  });

  it('refuses a value that is both recorded and blank, and one that is neither', () => {
    const field = library.customFields.define(
      { fieldKey: 'n', name: 'N', dataType: 'integer' },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldId: field.id, itemId: subject.id, content: { type: 'integer', value: 1 }, isBlank: true },
        library.actor,
      ),
    ).toThrow(/never both/iu);

    expect(() =>
      library.customFields.setValue({ fieldId: field.id, itemId: subject.id }, library.actor),
    ).toThrow(/needs content/iu);
  });
});

/**
 * `config.pattern` is operator configuration; the value it is matched against is not.
 *
 * The re-attack found `checkPattern` compiling the pattern with the native `RegExp` and running
 * `.test()` with no budget, inside `this.db.transaction` — so the ADR's own example of an innocent
 * rule, `^(\w+\s?)*$` ("the value is just plain words"), held SQLite's writer lock for 54 seconds
 * against a 33-character value. The value reaches here from `POST /api/v1/custom-fields/…/values`,
 * from stage 10 of ingestion where a rule interpolates it out of a document's own text, and from
 * the Paperless importer. ADR-0022 §4 admits no exception for "internal" patterns.
 */
describe('CustomFieldService — pattern validation is bounded (ADR-0022 §4)', () => {
  const catastrophic = '^(\\w+\\s?)*$';

  it('decides the ADR’s own catastrophic pattern in milliseconds, not seconds', () => {
    library.customFields.define(
      { fieldKey: 'reference', name: 'Reference', dataType: 'text', config: { pattern: catastrophic } },
      library.actor,
    );
    const subject = item();

    // Thirty characters. Against the native backtracking engine this took about five seconds, and
    // every further character roughly quadrupled it; the linear engine is flat.
    const value = `${'a'.repeat(29)}!`;
    const started = performance.now();
    expect(() =>
      library.customFields.setValue(
        { fieldKey: 'reference', itemId: subject.id, content: { type: 'text', value } },
        library.actor,
      ),
    ).toThrow(ValidationError);
    const elapsed = performance.now() - started;

    expect(elapsed, `deciding a ${value.length}-character value took ${elapsed.toFixed(0)} ms`).toBeLessThan(
      1_000,
    );
  }, 15_000);

  it('still accepts what the pattern allows and refuses what it does not', () => {
    library.customFields.define(
      { fieldKey: 'invoice', name: 'Invoice', dataType: 'text', config: { pattern: '^RE-\\d{4}-\\d{4}$' } },
      library.actor,
    );
    const subject = item();

    const stored = library.customFields.setValue(
      { fieldKey: 'invoice', itemId: subject.id, content: { type: 'text', value: 'RE-2024-0031' } },
      library.actor,
    );
    expect(stored.row.valueText).toBe('RE-2024-0031');

    expect(() =>
      library.customFields.setValue(
        { fieldKey: 'invoice', itemId: subject.id, content: { type: 'text', value: 'RE-24-1' } },
        library.actor,
      ),
    ).toThrow(/requires values matching/u);
  });

  it('refuses a pattern the linear engine cannot run, at definition time', () => {
    // A backreference: expressible in the native engine, and the reason the native engine can be
    // made to hang. The operator learns here rather than at the first write.
    expect(() =>
      library.customFields.define(
        { fieldKey: 'doubled', name: 'Doubled', dataType: 'text', config: { pattern: '^(a+)\\1$' } },
        library.actor,
      ),
    ).toThrow(/backreference/iu);

    // And on the way in through `updateField`, which is the other door to `config`.
    const field = library.customFields.define(
      { fieldKey: 'plain', name: 'Plain', dataType: 'text' },
      library.actor,
    );
    expect(() =>
      library.customFields.updateField(field.id, { config: { pattern: '^(?=x)y$' } }, library.actor),
    ).toThrow(/lookahead/iu);
  });

  it('refuses a value too long to match, naming the limit, rather than skipping the check', () => {
    library.customFields.define(
      { fieldKey: 'body', name: 'Body', dataType: 'long_text', config: { pattern: '^[a-z]+$' } },
      library.actor,
    );
    const subject = item();

    expect(() =>
      library.customFields.setValue(
        { fieldKey: 'body', itemId: subject.id, content: { type: 'long_text', value: 'a'.repeat(70_000) } },
        library.actor,
      ),
    ).toThrow(/the most that can be matched is 65536/u);
  });
});
