/**
 * The rule table as a document, and the diff back.
 *
 * The diff is where a mistake would be expensive: a save that rewrote every row would bump every
 * version counter and fill the audit log, and one that quietly dropped a rule the author had
 * deleted would leave it running. So both directions are asserted, and so is the property that an
 * unchanged document produces no requests at all.
 */
import { describe, expect, it } from 'vitest';
import { parseRuleSetOrThrow } from '@recueil/rules';
import type { IngestionRuleSet } from '@recueil/rules';

import { describeDiff, diffRuleSet, isEmptyDiff, rulesToText, toCreate } from '../src/rules/rule-set-text.js';
import { nestedRule, scannerRule } from './ingestion-fixtures.js';

const stored = [scannerRule(), nestedRule()];
const asSet = (text: string): IngestionRuleSet => parseRuleSetOrThrow(text) as IngestionRuleSet;

describe('rulesToText', () => {
  it('produces a document the engine parses back to the same rules', () => {
    const parsed = asSet(rulesToText(stored));
    expect(parsed.kind).toBe('ingestion');
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['scanner-by-folder', 'nested-rule']);
    expect(parsed.rules[0]?.priority).toBe(100);
  });

  it('omits a default rather than writing it out', () => {
    const text = rulesToText([scannerRule({ priority: 0, description: null })]);
    expect(text).not.toContain('priority:');
    expect(text).not.toContain('description:');
  });

  it('writes `enabled: false` for a disabled rule, because that one is not the default', () => {
    expect(rulesToText([scannerRule({ enabled: false })])).toContain('enabled: false');
  });
});

describe('diffRuleSet', () => {
  it('finds nothing to do for an unchanged document', () => {
    const diff = diffRuleSet(stored, asSet(rulesToText(stored)));
    expect(isEmptyDiff(diff)).toBe(true);
    expect(describeDiff(diff)).toBe('Nothing to save.');
  });

  it('updates only the rule that changed', () => {
    const text = rulesToText(stored).replace('priority: 100', 'priority: 200');
    const diff = diffRuleSet(stored, asSet(text));
    expect(diff.create).toEqual([]);
    expect(diff.remove).toEqual([]);
    expect(diff.update).toHaveLength(1);
    expect(diff.update[0]?.ruleId).toBe('scanner-by-folder');
    expect(diff.update[0]?.body.priority).toBe(200);
  });

  it('creates a rule the document has and the table does not', () => {
    const text = `${rulesToText(stored)}  - id: mail-invoices
    when:
      type: sender
      match:
        contains: "@acme.test"
    then:
      - type: add-tags
        tags:
          - acme
`;
    const diff = diffRuleSet(stored, asSet(text));
    expect(diff.create.map((rule) => rule.ruleId)).toEqual(['mail-invoices']);
    expect(diff.remove).toEqual([]);
  });

  it('removes a rule the document no longer has, and names it before doing so', () => {
    const diff = diffRuleSet(stored, asSet(rulesToText([scannerRule()])));
    expect(diff.remove.map((rule) => rule.ruleId)).toEqual(['nested-rule']);
    expect(describeDiff(diff)).toContain('remove nested-rule');
  });

  it('reads a renamed handle as a delete and a create, because that is what it is', () => {
    const text = rulesToText(stored).replace('id: scanner-by-folder', 'id: scanner-by-directory');
    const diff = diffRuleSet(stored, asSet(text));
    expect(diff.create.map((rule) => rule.ruleId)).toEqual(['scanner-by-directory']);
    expect(diff.remove.map((rule) => rule.ruleId)).toEqual(['scanner-by-folder']);
  });
});

describe('toCreate', () => {
  it('carries the rule into the shape the API takes', () => {
    const set = asSet(rulesToText([scannerRule()]));
    expect(toCreate(set.rules[0] as never)).toEqual({
      ruleId: 'scanner-by-folder',
      kind: 'ingestion',
      description: "Trust the scanner's own filing convention.",
      priority: 100,
      when: { type: 'source', match: { equals: 'scanner' } },
      then: [
        { type: 'set-item-type', itemType: 'invoice' },
        { type: 'add-to-collection', collection: 'Office/Scans' },
      ],
    });
  });
});
