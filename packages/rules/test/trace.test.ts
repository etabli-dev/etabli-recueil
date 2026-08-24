import { describe, expect, it } from 'vitest';

import { evaluateIngestion } from '../src/evaluate.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import { renderTrace } from '../src/trace.js';
import type { IngestionRuleSet } from '../src/schema/ingestion.js';
import { CAPTURE_YAML, CORPUS, PRECEDENCE_YAML } from './fixtures.js';

const ingestion = (yaml: string): IngestionRuleSet => {
  const parsed = parseRuleSetOrThrow(yaml);
  if (parsed.kind !== 'ingestion') throw new Error('fixture is not an ingestion rule set');
  return parsed;
};

const acme = CORPUS[0]!;
const photo = CORPUS[3]!;

describe('the trace', () => {
  const ruleSet = ingestion(PRECEDENCE_YAML);

  it('carries every rule, in evaluation order, with its priority and its verdict', () => {
    const { trace } = evaluateIngestion(ruleSet, photo);
    expect(trace.rules.map((rule) => ({ id: rule.ruleId, order: rule.order, priority: rule.priority, outcome: rule.outcome }))).toEqual([
      { id: 'acme-invoice', order: 0, priority: 100, outcome: 'not-matched' },
      { id: 'any-pdf', order: 1, priority: 0, outcome: 'not-matched' },
      { id: 'catch-all', order: 2, priority: -10, outcome: 'matched' },
    ]);
    expect(trace.kind).toBe('ingestion');
    expect(trace.ruleSet).toBe('precedence');
    expect(trace.mode).toBe('all-match');
    expect(trace.subjectId).toBe('doc-photo');
  });

  it('names the evidence for a condition that matched', () => {
    const { trace } = evaluateIngestion(ruleSet, acme);
    const sender = trace.rules[0]!.condition!.children![0]!;
    expect(sender.type).toBe('sender');
    expect(sender.matched).toBe(true);
    expect(sender.detail).toContain('"billing@acme.example"');
    expect(sender.detail).toContain('ends with "@acme.example"');
  });

  it('says which member of an `all` failed, and how far it got', () => {
    const { trace } = evaluateIngestion(ruleSet, photo);
    const condition = trace.rules[0]!.condition!;
    expect(condition.type).toBe('all');
    expect(condition.matched).toBe(false);
    expect(condition.detail).toContain('a member did not match');
    expect(condition.children).toHaveLength(1);
    expect(condition.children![0]!.type).toBe('sender');
    expect(condition.children![0]!.detail).toContain('no value to test');
  });

  it('records what each action did, including the ones it declined to do', () => {
    const { trace } = evaluateIngestion(ruleSet, acme);
    const catchAll = trace.rules.find((rule) => rule.ruleId === 'catch-all')!;
    expect(catchAll.actions).toEqual([
      { type: 'set-item-type', outcome: 'applied', detail: 'item type attachment_only, over report from any-pdf' },
      { type: 'add-tags', outcome: 'applied', detail: 'tags unfiled' },
    ]);

    const anyPdf = trace.rules.find((rule) => rule.ruleId === 'any-pdf')!;
    expect(anyPdf.actions[1]).toEqual({ type: 'add-tags', outcome: 'applied', detail: 'tags pdf' });
  });

  it('reports a tag that was already present as skipped rather than applied twice', () => {
    const twice: IngestionRuleSet = {
      version: 1,
      kind: 'ingestion',
      rules: [
        { id: 'first', priority: 2, when: { type: 'always' }, then: [{ type: 'add-tags', tags: ['pdf'] }] },
        { id: 'second', priority: 1, when: { type: 'always' }, then: [{ type: 'add-tags', tags: ['pdf'] }] },
      ],
    };
    const { outcome, trace } = evaluateIngestion(twice, acme);
    expect(outcome.tags).toEqual([{ value: 'pdf', ruleId: 'first' }]);
    expect(trace.rules[1]!.actions[0]).toEqual({ type: 'add-tags', outcome: 'skipped', detail: 'every tag was already present' });
  });

  it('renders as text a reviewer can read', () => {
    const rendered = renderTrace(evaluateIngestion(ruleSet, acme).trace);
    expect(rendered).toContain('ingestion rule set "precedence" (all-match) on doc-acme');
    expect(rendered).toContain('[0] acme-invoice (priority 100): matched');
    expect(rendered).toContain('✓ sender:');
    expect(rendered).toContain('→ set-correspondent: correspondent "ACME GmbH"');
    expect(rendered).toContain('[2] catch-all (priority -10): matched');
  });
});

describe('captures and interpolation', () => {
  const ruleSet = ingestion(CAPTURE_YAML);

  it('interpolates named captures from a condition in the same rule', () => {
    const { outcome, trace } = evaluateIngestion(ruleSet, acme);
    expect(trace.rules[0]!.captures).toEqual({ year: '2026', month: '08', who: 'ACME', ref: '40231' });
    expect(outcome.collections.map((entry) => entry.value)).toEqual(['Office/Invoices/2026']);
    expect(outcome.customFields).toEqual([{ field: 'reference_number', value: '40231', ruleId: 'scanner-convention' }]);
    expect(outcome.correspondent).toEqual({ value: 'ACME', ruleId: 'scanner-convention' });
  });

  it('skips a value whose capture is missing rather than writing a blank or the literal', () => {
    const { outcome, trace } = evaluateIngestion(ruleSet, acme);
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['2026-08']);
    const tagAction = trace.rules[0]!.actions.find((action) => action.type === 'add-tags')!;
    expect(tagAction.outcome).toBe('applied');
    expect(tagAction.detail).toContain('1 skipped');
    expect(tagAction.detail).toContain('${missing}');
  });

  it('does not carry captures from one rule into another', () => {
    const twoRules: IngestionRuleSet = {
      version: 1,
      kind: 'ingestion',
      rules: [
        { id: 'captures', priority: 2, when: { type: 'filename', match: { matches: '(?<who>ACME)' } }, then: [{ type: 'add-tags', tags: ['${who}'] }] },
        { id: 'borrows', priority: 1, when: { type: 'always' }, then: [{ type: 'add-tags', tags: ['also-${who}'] }] },
      ],
    };
    const { outcome, trace } = evaluateIngestion(twoRules, acme);
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['ACME']);
    expect(trace.rules[1]!.actions[0]!.outcome).toBe('skipped');
  });
});
