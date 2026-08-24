import { describe, expect, it } from 'vitest';

import { dryRunDedup, dryRunIngestion, summariseDedup, summariseIngestion } from '../src/dry-run.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import { renderDedupReport, renderIngestionReport } from '../src/report.js';
import type { DedupRuleSet } from '../src/schema/dedup.js';
import type { IngestionRuleSet } from '../src/schema/ingestion.js';
import { CORPUS, DEDUP_YAML, PAIRS, PRECEDENCE_YAML } from './fixtures.js';

const ingestion = (yaml: string): IngestionRuleSet => {
  const parsed = parseRuleSetOrThrow(yaml);
  if (parsed.kind !== 'ingestion') throw new Error('fixture is not an ingestion rule set');
  return parsed;
};

const dedup = (yaml: string): DedupRuleSet => {
  const parsed = parseRuleSetOrThrow(yaml);
  if (parsed.kind !== 'dedup') throw new Error('fixture is not a dedup rule set');
  return parsed;
};

/** Freeze a whole object graph, so that any write during the run throws in strict mode. */
const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
};

describe('the dry run changes nothing', () => {
  it('leaves the corpus byte-identical, and would throw if it tried not to', () => {
    const ruleSet = deepFreeze(ingestion(PRECEDENCE_YAML));
    const corpus = deepFreeze(structuredClone(CORPUS.map((subject) => ({ ...subject }))));
    const before = JSON.stringify(corpus);

    dryRunIngestion(ruleSet, corpus);

    expect(JSON.stringify(corpus)).toBe(before);
    // The rule set is a value the caller keeps; a run that normalised it in place would be a
    // surprise the second time the same object was used.
    expect(JSON.stringify(ruleSet)).toBe(JSON.stringify(ingestion(PRECEDENCE_YAML)));
  });

  it('is idempotent: two runs over the same corpus produce the same report', () => {
    const ruleSet = ingestion(PRECEDENCE_YAML);
    const first = dryRunIngestion(ruleSet, CORPUS);
    const second = dryRunIngestion(ruleSet, CORPUS);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('has no handle it could write through: the evaluator sees only plain values', () => {
    // The subject and the outcome are the only two things that cross the boundary. If either could
    // reach a database, this assertion would be the wrong shape — that is the point of making it.
    const ruleSet = ingestion(PRECEDENCE_YAML);
    const report = dryRunIngestion(ruleSet, CORPUS);
    for (const entry of report.entries) {
      expect(Object.isFrozen(entry.outcome)).toBe(true);
    }
  });
});

describe('the ingestion dry-run report', () => {
  const ruleSet = ingestion(PRECEDENCE_YAML);
  const report = dryRunIngestion(ruleSet, CORPUS);

  it('covers every subject', () => {
    expect(report.subjectCount).toBe(CORPUS.length);
    expect(report.entries.map((entry) => entry.subjectId)).toEqual(CORPUS.map((subject) => subject.id));
  });

  it('counts each rule by what actually happened to it, per subject', () => {
    expect(report.rules).toEqual([
      { ruleId: 'acme-invoice', order: 0, priority: 100, matched: 1, notMatched: 4, notReached: 0, disabled: 0, errors: 0 },
      { ruleId: 'any-pdf', order: 1, priority: 0, matched: 4, notMatched: 1, notReached: 0, disabled: 0, errors: 0 },
      { ruleId: 'catch-all', order: 2, priority: -10, matched: 5, notMatched: 0, notReached: 0, disabled: 0, errors: 0 },
    ]);
    // Cross-check against the traces rather than trusting the counters: a report that counted its
    // own bookkeeping would agree with itself whatever the engine did.
    const matchedAcme = report.entries.filter((entry) => entry.trace!.matchedRuleIds.includes('acme-invoice'));
    expect(matchedAcme.map((entry) => entry.subjectId)).toEqual(['doc-acme']);
  });

  it('summarises what would change, from the outcomes rather than from a tally kept while deciding', () => {
    const summary = summariseIngestion(report);
    expect([...summary.itemTypes.entries()]).toEqual([['attachment_only', 5]]);
    expect([...summary.tags.entries()].sort()).toEqual([
      ['acme', 1],
      ['invoice', 1],
      ['pdf', 4],
      ['unfiled', 5],
    ]);
    expect([...summary.collections.entries()]).toEqual([['Office/Invoices', 1]]);
    expect([...summary.correspondents.entries()]).toEqual([['ACME GmbH', 1]]);

    const tagsFromEntries = report.entries.flatMap((entry) => entry.outcome.tags.map((tag) => tag.value));
    expect(tagsFromEntries.filter((tag) => tag === 'pdf')).toHaveLength(4);
  });

  it('lists the subjects no rule matched', () => {
    const narrow: IngestionRuleSet = { ...ruleSet, rules: ruleSet.rules.filter((rule) => rule.id === 'acme-invoice') };
    const narrowReport = dryRunIngestion(narrow, CORPUS);
    expect(narrowReport.unmatchedSubjectIds).toEqual(['doc-scan', 'doc-payroll', 'doc-photo', 'doc-paper']);
  });

  it('drops traces past `maxTraces` but keeps every count', () => {
    const capped = dryRunIngestion(ruleSet, CORPUS, { maxTraces: 2 });
    expect(capped.entries.filter((entry) => entry.trace !== undefined)).toHaveLength(2);
    expect(capped.subjectCount).toBe(CORPUS.length);
    expect(capped.rules).toEqual(report.rules);
  });

  it('renders as Markdown a person can read', () => {
    const markdown = renderIngestionReport(report);
    expect(markdown).toContain('# Dry run — precedence');
    expect(markdown).toContain('ingestion rule set, all-match mode, over 5 subjects.');
    expect(markdown).toContain('Nothing was written');
    expect(markdown).toContain('| acme | 1 |');
    expect(markdown).toContain('| 0 | acme-invoice | 100 | 1 | 4 | 0 | 0 | 0 |');
  });

  it('names a rule that never fires, which is the most common rule-set bug', () => {
    const withDud: IngestionRuleSet = {
      ...ruleSet,
      rules: [...ruleSet.rules, { id: 'dud', when: { type: 'mime', match: { equals: 'application/x-nothing' } }, then: [{ type: 'stop' }] }],
    };
    expect(renderIngestionReport(dryRunIngestion(withDud, CORPUS))).toContain('1 rule matched nothing: dud.');
  });
});

describe('the dedup dry-run report', () => {
  const ruleSet = dedup(DEDUP_YAML);
  const report = dryRunDedup(ruleSet, PAIRS);

  it('decides each pair with the highest-priority rule that fits', () => {
    expect(report.entries.map((entry) => [entry.subjectId, entry.outcome.decision?.value ?? null])).toEqual([
      ['pair-hash', 'link'],
      ['pair-doi', 'merge'],
      ['pair-fuzzy', 'flag'],
      ['pair-different', null],
    ]);
  });

  it('carries the winner rule and the rule that chose it', () => {
    const doi = report.entries.find((entry) => entry.subjectId === 'pair-doi')!;
    expect(doi.outcome.winner).toEqual({ value: 'most-complete', ruleId: 'same-doi' });
    expect(doi.outcome.confidence).toEqual({ value: 0.99, ruleId: 'same-doi' });
  });

  it('routes the fuzzy pair to review with a stored explanation, deciding nothing', () => {
    const fuzzy = report.entries.find((entry) => entry.subjectId === 'pair-fuzzy')!;
    expect(fuzzy.outcome.review).toEqual([
      {
        reasonCode: 'record_merge_candidate',
        explanation: 'Titles, years and first authors agree, but no identifier does.',
        severity: 'warning',
        ruleId: 'fuzzy-candidate',
      },
    ]);
    expect(fuzzy.outcome.winner).toBeUndefined();
  });

  it('leaves an unrelated pair undecided rather than guessing', () => {
    const summary = summariseDedup(report);
    expect(summary.undecidedCount).toBe(1);
    expect(report.unmatchedSubjectIds).toEqual(['pair-different']);
    expect([...summary.decisions.entries()].sort()).toEqual([
      ['flag', 1],
      ['link', 1],
      ['merge', 1],
    ]);
  });

  it('renders as Markdown too', () => {
    const markdown = renderDedupReport(report);
    expect(markdown).toContain('dedup rule set, first-match mode, over 4 subjects.');
    expect(markdown).toContain('| merge | 1 |');
    expect(markdown).toContain('| most-complete | 1 |');
  });

  it('leaves the pairs untouched', () => {
    const pairs = deepFreeze(structuredClone(PAIRS.map((pair) => ({ ...pair }))));
    const before = JSON.stringify(pairs);
    dryRunDedup(ruleSet, pairs);
    expect(JSON.stringify(pairs)).toBe(before);
  });
});
