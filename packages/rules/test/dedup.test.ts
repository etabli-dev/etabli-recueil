import { describe, expect, it } from 'vitest';

import { evaluateDedup } from '../src/evaluate.js';
import { nameOverlap, similarity } from '../src/dedup/similarity.js';
import type { DedupCondition, DedupRuleSet } from '../src/schema/dedup.js';
import type { DedupPair } from '../src/dedup/subject.js';

const oneRule = (when: DedupCondition): DedupRuleSet => ({
  version: 1,
  kind: 'dedup',
  name: 'probe',
  rules: [{ id: 'probe', when, then: [{ type: 'merge', winner: 'newest' }] }],
});

const fired = (when: DedupCondition, pair: DedupPair): boolean => evaluateDedup(oneRule(when), pair).trace.matchedRuleIds.includes('probe');

type Side = Omit<DedupPair['left'], 'id'>;

const pair = (left: Side, right: Side): DedupPair => ({ id: 'p', left: { ...left, id: 'l' }, right: { ...right, id: 'r' } });

describe('similarity', () => {
  it('is 1 for the same normalised string and 0 for nothing in common', () => {
    expect(similarity('The PRISMA 2020 Statement', 'the prisma 2020 statement')).toBe(1);
    expect(similarity('abcdef', 'uvwxyz')).toBe(0);
  });

  it('scores an empty side 0, so a missing title is not evidence of a duplicate', () => {
    expect(similarity(undefined, 'anything')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'Deep learning for image recognition';
    const b = 'Deep learning for image recognition at scale';
    expect(similarity(a, b)).toBe(similarity(b, a));
  });

  it('flattens punctuation and case, which is where exporters disagree', () => {
    expect(similarity('Meta-analysis: a primer', 'Meta analysis  a primer')).toBe(1);
  });

  it('measures name overlap against the shorter list, so "et al." does not defeat a match', () => {
    expect(nameOverlap(['Page'], ['Page', 'McKenzie', 'Bossuyt'])).toBe(1);
    expect(nameOverlap(['Page', 'Smith'], ['Page', 'McKenzie'])).toBe(0.5);
    expect(nameOverlap([], ['Page'])).toBe(0);
  });
});

describe('dedup conditions', () => {
  it('matches a shared identifier, and only that identifier when one is named', () => {
    const shared = pair({ identifiers: { doi: '10.1/x' } }, { identifiers: { doi: '10.1/x' } });
    expect(fired({ type: 'identifier-match', identifier: 'doi' }, shared)).toBe(true);
    expect(fired({ type: 'identifier-match', identifier: 'pmid' }, shared)).toBe(false);
    expect(fired({ type: 'identifier-match' }, shared)).toBe(true);
  });

  it('does not treat a differing value as a match', () => {
    const differing = pair({ identifiers: { doi: '10.1/x' } }, { identifiers: { doi: '10.1/y' } });
    expect(fired({ type: 'identifier-match', identifier: 'doi' }, differing)).toBe(false);
    expect(fired({ type: 'identifier-conflict', identifier: 'doi' }, differing)).toBe(true);
  });

  it('is a conflict only when both sides carry the key', () => {
    const oneSided = pair({ identifiers: { doi: '10.1/x' } }, {});
    expect(fired({ type: 'identifier-conflict' }, oneSided)).toBe(false);
  });

  it('compares identifiers with `=`, and says in the trace what it compared', () => {
    const shared = pair({ identifiers: { doi: '10.1/x' } }, { identifiers: { doi: '10.1/x' } });
    const condition = evaluateDedup(oneRule({ type: 'identifier-match' }), shared).trace.rules[0]!.condition!;
    expect(condition.evidence).toBe('doi=10.1/x');
  });

  it('matches a shared document hash', () => {
    expect(fired({ type: 'file-hash-match' }, pair({ hashes: ['a'] }, { hashes: ['b', 'a'] }))).toBe(true);
    expect(fired({ type: 'file-hash-match' }, pair({ hashes: ['a'] }, { hashes: ['b'] }))).toBe(false);
    expect(fired({ type: 'file-hash-match' }, pair({}, {}))).toBe(false);
  });

  it('compares years within a tolerance, and refuses when one is missing', () => {
    expect(fired({ type: 'year-within', years: 1 }, pair({ year: 2020 }, { year: 2021 }))).toBe(true);
    expect(fired({ type: 'year-within', years: 1 }, pair({ year: 2020 }, { year: 2022 }))).toBe(false);
    expect(fired({ type: 'year-within', years: 5 }, pair({ year: 2020 }, {}))).toBe(false);
  });

  it('reads a field on the side the rule names', () => {
    const mixed = pair({ source: 'import:zotero' }, { source: 'manual' });
    expect(fired({ type: 'field', field: 'source', side: 'left', match: { equals: 'import:zotero' } }, mixed)).toBe(true);
    expect(fired({ type: 'field', field: 'source', side: 'right', match: { equals: 'import:zotero' } }, mixed)).toBe(false);
    expect(fired({ type: 'field', field: 'source', side: 'either', match: { equals: 'import:zotero' } }, mixed)).toBe(true);
    expect(fired({ type: 'field', field: 'source', side: 'both', match: { equals: 'import:zotero' } }, mixed)).toBe(false);
  });

  it('`same-field` compares the two sides after normalisation', () => {
    expect(fired({ type: 'same-field', field: 'venue' }, pair({ venue: 'The BMJ' }, { venue: 'the bmj' }))).toBe(true);
    expect(fired({ type: 'same-field', field: 'venue' }, pair({ venue: 'The BMJ' }, {}))).toBe(false);
  });

  it('composes with all, any and not exactly as the ingestion facet does', () => {
    const candidate = pair({ title: 'One study', year: 2020 }, { title: 'One study', year: 2020, identifiers: { doi: '10.1/y' } });
    expect(
      fired(
        {
          all: [
            { type: 'title-similarity', atLeast: 0.9 },
            { not: { type: 'identifier-conflict' } },
          ],
        },
        candidate,
      ),
    ).toBe(true);
  });
});

describe('dedup actions', () => {
  it('proposes rather than performs: the outcome names the decision, the winner and the rule', () => {
    const shared = pair({ identifiers: { doi: '10.1/x' }, dateAdded: '2020-01-01' }, { identifiers: { doi: '10.1/x' }, dateAdded: '2024-01-01' });
    const { outcome } = evaluateDedup(oneRule({ type: 'identifier-match' }), shared);
    expect(outcome.decision).toEqual({ value: 'merge', ruleId: 'probe' });
    expect(outcome.winner).toEqual({ value: 'newest', ruleId: 'probe' });
    // Nothing in the outcome resolves the winner to a side: choosing is the Phase 3 engine's job.
    expect(Object.keys(outcome)).not.toContain('winnerId');
  });

  it('records a later rule disagreeing with an earlier one as a conflict', () => {
    const ruleSet: DedupRuleSet = {
      version: 1,
      kind: 'dedup',
      mode: 'all-match',
      rules: [
        { id: 'merge-it', priority: 10, when: { type: 'always' }, then: [{ type: 'merge', winner: 'newest' }] },
        { id: 'never-mind', priority: 1, when: { type: 'always' }, then: [{ type: 'ignore' }] },
      ],
    };
    const { outcome } = evaluateDedup(ruleSet, pair({}, {}));
    expect(outcome.decision).toEqual({ value: 'ignore', ruleId: 'never-mind' });
    expect(outcome.conflicts).toEqual([
      { field: 'decision', previous: { value: 'merge', ruleId: 'merge-it' }, next: { value: 'ignore', ruleId: 'never-mind' } },
    ]);
  });

  it('flags with the reason code the review queue expects by default', () => {
    const ruleSet: DedupRuleSet = {
      version: 1,
      kind: 'dedup',
      rules: [{ id: 'flag-it', when: { type: 'always' }, then: [{ type: 'flag', explanation: 'Looks close.' }] }],
    };
    const { outcome } = evaluateDedup(ruleSet, pair({}, {}));
    expect(outcome.review).toEqual([
      { reasonCode: 'record_merge_candidate', explanation: 'Looks close.', severity: 'warning', ruleId: 'flag-it' },
    ]);
  });
});
