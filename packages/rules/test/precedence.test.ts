import { describe, expect, it } from 'vitest';

import { evaluateIngestion } from '../src/evaluate.js';
import { sortRules } from '../src/engine.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import type { IngestionRuleSet } from '../src/schema/ingestion.js';
import { CORPUS, FIRST_MATCH_YAML, PRECEDENCE_YAML, REVIEW_YAML } from './fixtures.js';

const ingestion = (yaml: string): IngestionRuleSet => {
  const parsed = parseRuleSetOrThrow(yaml);
  if (parsed.kind !== 'ingestion') throw new Error('fixture is not an ingestion rule set');
  return parsed;
};

const acme = CORPUS[0]!;
const scan = CORPUS[1]!;
const photo = CORPUS[3]!;

describe('precedence', () => {
  const ruleSet = ingestion(PRECEDENCE_YAML);

  it('orders by priority descending, not by the order the rules are written', () => {
    expect(ruleSet.rules.map((rule) => rule.id)).toEqual(['catch-all', 'any-pdf', 'acme-invoice']);
    expect(sortRules(ruleSet.rules).map((rule) => rule.id)).toEqual(['acme-invoice', 'any-pdf', 'catch-all']);
  });

  it('breaks ties by the order the rules are written, so an unprioritised set is still deterministic', () => {
    const rules = [
      { id: 'c', priority: 0, when: { type: 'always' as const }, then: [] },
      { id: 'a', priority: 5, when: { type: 'always' as const }, then: [] },
      { id: 'b', priority: 0, when: { type: 'always' as const }, then: [] },
      { id: 'd', priority: 5, when: { type: 'always' as const }, then: [] },
    ];
    expect(sortRules(rules).map((rule) => rule.id)).toEqual(['a', 'd', 'c', 'b']);
    expect(sortRules([...rules]).map((rule) => rule.id)).toEqual(sortRules(rules).map((rule) => rule.id));
  });

  it('in all-match mode every matching rule contributes, and the last writer wins a scalar', () => {
    const { outcome, trace } = evaluateIngestion(ruleSet, acme);

    expect(trace.rules.map((rule) => [rule.ruleId, rule.outcome])).toEqual([
      ['acme-invoice', 'matched'],
      ['any-pdf', 'matched'],
      ['catch-all', 'matched'],
    ]);
    // `catch-all` runs last, so its item type is the one that stands.
    expect(outcome.itemType).toEqual({ value: 'attachment_only', ruleId: 'catch-all' });
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['acme', 'invoice', 'pdf', 'unfiled']);
    expect(outcome.collections.map((entry) => entry.value)).toEqual(['Office/Invoices']);
    expect(outcome.correspondent).toEqual({ value: 'ACME GmbH', ruleId: 'acme-invoice' });
  });

  it('records each overwrite as a conflict, naming both rules', () => {
    const { outcome } = evaluateIngestion(ruleSet, acme);
    expect(outcome.conflicts).toEqual([
      { field: 'itemType', previous: { value: 'invoice', ruleId: 'acme-invoice' }, next: { value: 'report', ruleId: 'any-pdf' } },
      { field: 'itemType', previous: { value: 'report', ruleId: 'any-pdf' }, next: { value: 'attachment_only', ruleId: 'catch-all' } },
    ]);
  });

  it('in first-match mode the highest-priority match ends the run', () => {
    const { outcome, trace } = evaluateIngestion(ingestion(FIRST_MATCH_YAML), acme);
    expect(trace.matchedRuleIds).toEqual(['acme-invoice']);
    expect(trace.stoppedBy).toBe('acme-invoice');
    expect(trace.rules.map((rule) => rule.outcome)).toEqual(['matched', 'not-reached', 'not-reached']);
    expect(outcome.itemType).toEqual({ value: 'invoice', ruleId: 'acme-invoice' });
    expect(outcome.conflicts).toEqual([]);
  });

  it('a `stop` action ends the run in all-match mode too', () => {
    const paper = { ...CORPUS[4]!, resolvers: [{ resolver: 'crossref', outcome: 'miss' as const }] };
    const { outcome, trace } = evaluateIngestion(ingestion(REVIEW_YAML), paper);
    expect(trace.stoppedBy).toBe('unresolved');
    expect(trace.rules.map((rule) => [rule.ruleId, rule.outcome])).toEqual([
      ['unresolved', 'matched'],
      ['never-reached', 'not-reached'],
    ]);
    expect(outcome.stopped).toBe(true);
    expect(outcome.tags).toEqual([]);
    expect(outcome.review).toEqual([
      {
        reasonCode: 'no_identifier_match',
        explanation: 'Crossref returned no decisive match for this PDF.',
        severity: 'warning',
        proposedAction: 'set_fields',
        ruleId: 'unresolved',
      },
    ]);
  });

  it('a disabled rule is skipped but still appears in the trace', () => {
    const disabled: IngestionRuleSet = {
      ...ruleSet,
      rules: ruleSet.rules.map((rule) => (rule.id === 'acme-invoice' ? { ...rule, enabled: false } : rule)),
    };
    const { outcome, trace } = evaluateIngestion(disabled, acme);
    expect(trace.rules.find((rule) => rule.ruleId === 'acme-invoice')?.outcome).toBe('disabled');
    expect(outcome.correspondent).toBeUndefined();
  });

  it('leaves a subject no rule matched untouched, and says so', () => {
    const noRules: IngestionRuleSet = { ...ruleSet, rules: ruleSet.rules.filter((rule) => rule.id === 'acme-invoice') };
    const { outcome, trace } = evaluateIngestion(noRules, photo);
    expect(trace.matchedRuleIds).toEqual([]);
    expect(outcome.untouched).toBe(true);
    expect(outcome.tags).toEqual([]);
  });

  it('is deterministic: the same set over the same subject gives an identical outcome and trace', () => {
    const first = evaluateIngestion(ruleSet, scan);
    const second = evaluateIngestion(ruleSet, scan);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
