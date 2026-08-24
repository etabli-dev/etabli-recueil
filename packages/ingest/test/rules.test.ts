/**
 * The rule engine and its validator.
 *
 * Two properties are worth more than the matching: the order is total and stable, and a
 * disagreement between two rules is reported rather than resolved by sort order (P3).
 */
import { describe, expect, it } from 'vitest';

import { RuleEngine } from '../src/rules/engine.js';
import type { RuleSubject } from '../src/rules/engine.js';
import { parseRules, parseRulesOrThrow } from '../src/rules/parse.js';
import type { IngestRule } from '../src/rules/types.js';

const subject = (overrides: Partial<RuleSubject> = {}): RuleSubject => ({
  sourceKind: 'imap',
  sourceId: 'mailbox',
  path: 'INBOX/4711',
  filename: 'rechnung.pdf',
  mediaType: 'application/pdf',
  detectedType: 'office_document',
  text: 'Rechnung\nGesamtbetrag 12,00 EUR',
  identifiers: [],
  resolvedBy: [],
  sourceMetadata: { from: 'billing@swu.example', subject: 'Ihre Rechnung 2026-03' },
  confidence: 0.4,
  ...overrides,
});

describe('matching', () => {
  it('matches on sender, subject, path, filename and text', () => {
    const rule: IngestRule = {
      id: 'swu-invoices',
      match: {
        sourceKind: ['imap'],
        sender: { pattern: '@swu\\.example$', flags: 'i' },
        subject: { pattern: 'Rechnung', flags: 'i' },
        path: { pattern: '^INBOX/' },
        filename: { pattern: '\\.pdf$', flags: 'i' },
        text: { pattern: 'Gesamtbetrag' },
      },
      actions: { itemType: 'invoice', addTags: ['utilities'], confidenceDelta: 0.3 },
    };

    const result = new RuleEngine([rule]).evaluate(subject());
    expect(result.matched).toEqual(['swu-invoices']);
    expect(result.itemType).toBe('invoice');
    expect(result.addTags).toEqual(['utilities']);
    expect(result.confidenceDelta).toBeCloseTo(0.3);
  });

  it('requires every clause, so one mismatch is a non-match', () => {
    const rule: IngestRule = {
      id: 'r',
      match: { sender: { pattern: '@swu\\.example$' }, detectedType: ['scholarly_pdf'] },
      actions: { itemType: 'article' },
    };
    expect(new RuleEngine([rule]).evaluate(subject()).matched).toEqual([]);
  });

  it('matches on a confidence window', () => {
    const rescue: IngestRule = {
      id: 'rescue',
      match: { maxConfidence: 0.5 },
      actions: { review: { reasonCode: 'needs_eyes', explanation: 'A doubtful document.' } },
    };
    expect(new RuleEngine([rescue]).evaluate(subject({ confidence: 0.4 })).review?.ruleId).toBe('rescue');
    expect(new RuleEngine([rescue]).evaluate(subject({ confidence: 0.9 })).review).toBe(null);
  });

  it('matches on the presence of an identifier scheme', () => {
    const rule: IngestRule = {
      id: 'doi',
      match: { hasIdentifier: ['doi'] },
      actions: { addTags: ['has-doi'] },
    };
    const engine = new RuleEngine([rule]);
    expect(engine.evaluate(subject()).matched).toEqual([]);
    expect(
      engine.evaluate(subject({ identifiers: [{ scheme: 'doi', value: '10.1/x' }] })).matched,
    ).toEqual(['doi']);
  });

  it('never matches on a pattern that does not compile, and does not throw', () => {
    const rule: IngestRule = {
      id: 'broken',
      match: { text: { pattern: '(unclosed' } },
      actions: { addTags: ['x'] },
    };
    expect(new RuleEngine([rule]).evaluate(subject()).matched).toEqual([]);
  });
});

describe('ordering', () => {
  it('is by descending priority then by id, whatever order the rules arrived in', () => {
    const make = (id: string, priority: number): IngestRule => ({
      id,
      priority,
      match: {},
      actions: { addTags: [id] },
    });
    const forwards = new RuleEngine([make('b', 1), make('a', 1), make('c', 5)]);
    const backwards = new RuleEngine([make('c', 5), make('a', 1), make('b', 1)]);

    expect(forwards.ordered.map((rule) => rule.id)).toEqual(['c', 'a', 'b']);
    expect(backwards.ordered.map((rule) => rule.id)).toEqual(['c', 'a', 'b']);
    expect(forwards.evaluate(subject()).addTags).toEqual(['c', 'a', 'b']);
  });

  it('honours stopOnMatch', () => {
    const engine = new RuleEngine([
      { id: 'first', priority: 10, stopOnMatch: true, match: {}, actions: { addTags: ['first'] } },
      { id: 'second', priority: 1, match: {}, actions: { addTags: ['second'] } },
    ]);
    expect(engine.evaluate(subject()).matched).toEqual(['first']);
  });

  it('skips disabled rules', () => {
    const engine = new RuleEngine([
      { id: 'off', enabled: false, match: {}, actions: { addTags: ['off'] } },
    ]);
    expect(engine.size).toBe(0);
  });
});

describe('conflicts', () => {
  it('reports two rules that want different item types rather than picking one silently', () => {
    const engine = new RuleEngine([
      { id: 'a', priority: 5, match: {}, actions: { itemType: 'invoice' } },
      { id: 'b', priority: 1, match: {}, actions: { itemType: 'letter' } },
    ]);
    const result = engine.evaluate(subject());

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.field).toBe('itemType');
    expect(result.conflicts[0]!.candidates.map((entry) => entry.ruleId)).toEqual(['a', 'b']);
    // The highest-priority value is still carried so the review entry can propose something.
    expect(result.itemType).toBe('invoice');
  });

  it('does not report two rules that want the same value', () => {
    const engine = new RuleEngine([
      { id: 'a', match: {}, actions: { itemType: 'invoice' } },
      { id: 'b', match: {}, actions: { itemType: 'invoice' } },
    ]);
    expect(engine.evaluate(subject()).conflicts).toEqual([]);
  });

  it('treats additive actions as a union, not a conflict', () => {
    const engine = new RuleEngine([
      { id: 'a', match: {}, actions: { addTags: ['x'], addCollectionIds: ['c1'] } },
      { id: 'b', match: {}, actions: { addTags: ['y'], addCollectionIds: ['c1'] } },
    ]);
    const result = engine.evaluate(subject());
    expect(result.addTags.sort()).toEqual(['x', 'y']);
    expect(result.addCollectionIds).toEqual(['c1']);
    expect(result.conflicts).toEqual([]);
  });
});

describe('parseRules', () => {
  it('accepts a rule set that arrived as JSON', () => {
    const parsed = parseRules([
      {
        id: 'r1',
        title: 'Utilities',
        priority: 5,
        match: { sourceKind: ['imap'], sender: '@swu\\.example$' },
        actions: { itemType: 'invoice', addTags: ['utilities'] },
      },
    ]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0]!.match.sender).toEqual({ pattern: '@swu\\.example$' });
  });

  it('reports every problem rather than throwing on the first', () => {
    const parsed = parseRules([
      { id: 'good', match: {}, actions: {} },
      { match: {}, actions: {} },
      { id: 'good', match: {}, actions: {} },
      { id: 'bad-regex', match: { text: '(' }, actions: {} },
      { id: 'bad-kind', match: { sourceKind: ['telepathy'] }, actions: {} },
      { id: 'bad-delta', match: {}, actions: { confidenceDelta: 7 } },
    ]);

    const paths = parsed.problems.map((problem) => problem.path);
    expect(paths).toContain('[1].id');
    expect(paths).toContain('[2].id');
    expect(paths).toContain('[3].match.text');
    expect(paths).toContain('[4].match.sourceKind');
    expect(paths).toContain('[5].actions.confidenceDelta');
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['good']);
  });

  it('refuses a review action with no explanation, because a person has to read it', () => {
    const parsed = parseRules([
      { id: 'r', match: {}, actions: { review: { reasonCode: 'x' } } },
    ]);
    expect(parsed.problems.map((problem) => problem.path)).toContain('[0].actions.review.explanation');
  });

  it('throws with every problem listed when the caller has nowhere to show them', () => {
    expect(() => parseRulesOrThrow([{ id: 'r', match: { text: '(' }, actions: {} }])).toThrowError(
      /is not a valid regular expression/u,
    );
  });
});
