/**
 * What the form can and cannot hold.
 *
 * The important assertion is the negative one. `toSimpleRule` must return `null` for every
 * condition the form would not round-trip, because the failure to avoid is a form that opens a
 * nested rule, renders the half it understands, and saves that half over the whole thing.
 */
import { describe, expect, it } from 'vitest';
import { parseRuleSetOrThrow } from '@recueil/rules';
import type { IngestionRule, IngestionRuleSet } from '@recueil/rules';

import { describeAction, describeCondition, fromSimpleRule, toSimpleRule } from '../src/rules/form-model.js';
import { RULE_SET_TEXT } from './ingestion-fixtures.js';

const ruleSet = parseRuleSetOrThrow(RULE_SET_TEXT) as IngestionRuleSet;
const rule = (id: string): IngestionRule => {
  const found = ruleSet.rules.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no rule ${id} in the fixture`);
  return found;
};

describe('toSimpleRule', () => {
  it('reads a single-leaf rule', () => {
    const simple = toSimpleRule(rule('scanner-by-folder'));
    expect(simple).not.toBeNull();
    expect(simple?.conditions).toEqual([
      { field: 'source', operator: 'equals', value: 'scanner', caseSensitive: false },
    ]);
    expect(simple?.priority).toBe(100);
  });

  it('reads a flat conjunction', () => {
    const parsed = parseRuleSetOrThrow(`version: 1
kind: ingestion
rules:
  - id: two
    when:
      all:
        - { type: source, match: { equals: folder } }
        - { type: filename, match: { glob: "*.pdf" } }
    then: [{ type: stop }]
`) as IngestionRuleSet;
    const simple = toSimpleRule(parsed.rules[0] as IngestionRule);
    expect(simple?.combinator).toBe('all');
    expect(simple?.conditions).toHaveLength(2);
  });

  it('reads a catch-all as "match everything" rather than as an empty condition list', () => {
    const parsed = parseRuleSetOrThrow(`version: 1
kind: ingestion
rules:
  - id: catch-all
    when: { type: always }
    then: [{ type: stop }]
`) as IngestionRuleSet;
    expect(toSimpleRule(parsed.rules[0] as IngestionRule)?.always).toBe(true);
  });

  it('declines a negated condition rather than dropping the negation', () => {
    expect(toSimpleRule(rule('nested-rule'))).toBeNull();
  });

  it('declines a nested tree', () => {
    const parsed = parseRuleSetOrThrow(`version: 1
kind: ingestion
rules:
  - id: nested
    when:
      all:
        - { type: source, match: { equals: folder } }
        - any:
            - { type: filename, match: { glob: "*.pdf" } }
            - { type: filename, match: { glob: "*.tif" } }
    then: [{ type: stop }]
`) as IngestionRuleSet;
    expect(toSimpleRule(parsed.rules[0] as IngestionRule)).toBeNull();
  });

  it('declines a resolver condition, which has no matcher for the form to show', () => {
    const parsed = parseRuleSetOrThrow(`version: 1
kind: ingestion
rules:
  - id: resolved
    when: { type: resolver, outcome: hit }
    then: [{ type: stop }]
`) as IngestionRuleSet;
    expect(toSimpleRule(parsed.rules[0] as IngestionRule)).toBeNull();
  });
});

describe('fromSimpleRule', () => {
  it('round-trips a rule the form accepted, and the engine still parses it', () => {
    const simple = toSimpleRule(rule('scanner-by-folder'));
    if (simple === null) throw new Error('the fixture rule should be editable');
    const rebuilt = fromSimpleRule(simple);

    const parsed = parseRuleSetOrThrow(
      JSON.stringify({ version: 1, kind: 'ingestion', rules: [rebuilt] }),
    ) as IngestionRuleSet;
    expect(parsed.rules[0]).toEqual(rebuilt);
    expect(toSimpleRule(parsed.rules[0] as IngestionRule)).toEqual(simple);
  });

  it('omits a default rather than writing it out', () => {
    const rebuilt = fromSimpleRule({
      id: 'plain',
      description: '',
      enabled: true,
      priority: 0,
      combinator: 'all',
      always: true,
      conditions: [],
      actions: [{ type: 'stop' }],
    });
    expect(rebuilt).not.toHaveProperty('description');
    expect(rebuilt).not.toHaveProperty('enabled');
    expect(rebuilt).not.toHaveProperty('priority');
  });

  it('splits an equalsAny list on newlines and drops the blanks', () => {
    const rebuilt = fromSimpleRule({
      id: 'senders',
      description: '',
      enabled: true,
      priority: 0,
      combinator: 'all',
      always: false,
      conditions: [{ field: 'sender', operator: 'equalsAny', value: 'a@x.test\n\n b@x.test ', caseSensitive: false }],
      actions: [{ type: 'stop' }],
    });
    expect(rebuilt.when).toEqual({ type: 'sender', match: { equalsAny: ['a@x.test', 'b@x.test'] } });
  });
});

describe('describing a rule', () => {
  it('renders a condition tree as a sentence, negation included', () => {
    expect(describeCondition(rule('nested-rule').when)).toBe('not (tag equals "filed")');
  });

  it('renders an action by what it writes, not by what it is called', () => {
    expect(describeAction({ type: 'add-to-collection', collection: 'Office/Scans' })).toBe(
      'file it under Office/Scans',
    );
    expect(describeAction({ type: 'set-confidence', confidence: 0.95 })).toBe('set the confidence to 0.95');
  });
});
