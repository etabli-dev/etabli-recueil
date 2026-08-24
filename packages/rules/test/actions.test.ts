import { describe, expect, it } from 'vitest';

import { evaluateIngestion } from '../src/evaluate.js';
import { hasPlaceholder, interpolate } from '../src/interpolate.js';
import type { IngestionAction, IngestionRuleSet } from '../src/schema/ingestion.js';
import type { IngestionSubject } from '../src/ingestion/subject.js';

const subject: IngestionSubject = { id: 's', filename: 'RE-40231.pdf', mime: 'application/pdf' };

const run = (...rules: readonly { id: string; priority?: number; then: readonly IngestionAction[] }[]) => {
  const ruleSet: IngestionRuleSet = {
    version: 1,
    kind: 'ingestion',
    mode: 'all-match',
    rules: rules.map((rule) => ({ id: rule.id, priority: rule.priority ?? 0, when: { type: 'always' }, then: [...rule.then] })),
  };
  return evaluateIngestion(ruleSet, subject);
};

describe('actions', () => {
  it('sets a custom field, and replaces rather than duplicating it', () => {
    const { outcome } = run(
      { id: 'first', priority: 2, then: [{ type: 'set-custom-field', field: 'reference_number', value: 'A' }] },
      { id: 'second', priority: 1, then: [{ type: 'set-custom-field', field: 'reference_number', value: 'B' }] },
    );
    expect(outcome.customFields).toEqual([{ field: 'reference_number', value: 'B', ruleId: 'second' }]);
    expect(outcome.conflicts).toEqual([
      { field: 'customField:reference_number', previous: { value: 'A', ruleId: 'first' }, next: { value: 'B', ruleId: 'second' } },
    ]);
  });

  it('carries a typed value through unchanged', () => {
    const { outcome } = run({
      id: 'typed',
      then: [
        { type: 'set-custom-field', field: 'amount_minor', value: 123_456 },
        { type: 'set-custom-field', field: 'paid', value: false },
        { type: 'set-custom-field', field: 'cleared_on', value: null },
      ],
    });
    expect(outcome.customFields.map((field) => [field.field, field.value])).toEqual([
      ['amount_minor', 123_456],
      ['paid', false],
      ['cleared_on', null],
    ]);
  });

  it('does not record a conflict when two rules set the same value', () => {
    const { outcome } = run(
      { id: 'first', priority: 2, then: [{ type: 'set-item-type', itemType: 'invoice' }] },
      { id: 'second', priority: 1, then: [{ type: 'set-item-type', itemType: 'invoice' }] },
    );
    expect(outcome.itemType).toEqual({ value: 'invoice', ruleId: 'second' });
    expect(outcome.conflicts).toEqual([]);
  });

  it('adds a collection once, and carries the create flag', () => {
    const { outcome, trace } = run(
      { id: 'first', priority: 2, then: [{ type: 'add-to-collection', collection: 'Office/Invoices' }] },
      { id: 'second', priority: 1, then: [{ type: 'add-to-collection', collection: 'Office/Invoices', create: false }] },
    );
    expect(outcome.collections).toEqual([{ value: 'Office/Invoices', ruleId: 'first', create: true }]);
    expect(trace.rules[1]!.actions[0]!.outcome).toBe('skipped');
  });

  it('defaults a review entry to a warning', () => {
    const { outcome } = run({
      id: 'review',
      then: [{ type: 'route-to-review', reasonCode: 'low_confidence_metadata', explanation: 'Nothing resolved.' }],
    });
    expect(outcome.review[0]!.severity).toBe('warning');
    expect(outcome.review[0]!.proposedAction).toBeUndefined();
  });

  it('skips every action after a `stop` in the same rule, and says why', () => {
    const { outcome, trace } = run({
      id: 'stopper',
      then: [{ type: 'add-tags', tags: ['before'] }, { type: 'stop' }, { type: 'add-tags', tags: ['after'] }],
    });
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['before']);
    expect(trace.rules[0]!.actions.map((action) => action.outcome)).toEqual(['applied', 'applied', 'skipped']);
    expect(trace.rules[0]!.actions[2]!.detail).toBe('evaluation had already stopped');
  });

  it('freezes the outcome it hands back', () => {
    const { outcome } = run({ id: 'any', then: [{ type: 'add-tags', tags: ['x'] }] });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.tags)).toBe(true);
  });
});

describe('interpolation', () => {
  const captures = new Map([
    ['year', '2026'],
    ['ref', '40231'],
  ]);

  it('substitutes every placeholder it can', () => {
    expect(interpolate('Invoices/${year}/${ref}', captures)).toEqual({ ok: true, value: 'Invoices/2026/40231', used: ['year', 'ref'] });
  });

  it('reports every placeholder it cannot, rather than substituting a blank', () => {
    expect(interpolate('${year}/${month}/${day}', captures)).toEqual({ ok: false, missing: ['month', 'day'] });
  });

  it('leaves text that is not a placeholder alone', () => {
    expect(interpolate('a $ b ${ c } d ${}', captures)).toEqual({ ok: true, value: 'a $ b ${ c } d ${}', used: [] });
  });

  it('escapes a literal `${` as `$${`', () => {
    expect(interpolate('cost $${year}', captures)).toEqual({ ok: true, value: 'cost ${year}', used: [] });
  });

  it('says whether a template has a placeholder at all', () => {
    expect(hasPlaceholder('plain text')).toBe(false);
    expect(hasPlaceholder('a ${b}')).toBe(true);
    expect(hasPlaceholder('a $${b}')).toBe(false);
  });
});
