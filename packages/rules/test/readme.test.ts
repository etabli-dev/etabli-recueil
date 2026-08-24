import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluateIngestion } from '../src/evaluate.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import { renderTrace } from '../src/trace.js';
import type { IngestionSubject } from '../src/ingestion/subject.js';

/**
 * The README's example is executable, and this runs it.
 *
 * A README that drifts from the code is worse than no README, because it is read as a contract.
 * The rule set below is the one in the file, not a copy of it.
 */
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const yaml = readme.split('```yaml\n')[1]!.split('```')[0]!;

const subject: IngestionSubject = {
  id: 'doc-acme',
  source: 'imap',
  sender: 'billing@acme.example',
  filename: '2026-08-14_ACME_RE-40231.pdf',
  mime: 'application/pdf',
};

const parsed = parseRuleSetOrThrow(yaml);
if (parsed.kind !== 'ingestion') throw new Error('the README example is not an ingestion rule set');
const ruleSet = parsed;

describe('the README example', () => {
  it('is a valid rule set', () => {
    expect(ruleSet.kind).toBe('ingestion');
    expect(ruleSet.rules.map((rule) => rule.id)).toEqual(['acme-invoices', 'scanner-convention', 'unresolved-pdfs']);
  });

  it('produces what the README says it produces', () => {
    const { outcome } = evaluateIngestion(ruleSet, subject);
    expect(outcome.itemType).toEqual({ value: 'invoice', ruleId: 'acme-invoices' });
    expect(outcome.correspondent).toEqual({ value: 'ACME GmbH', ruleId: 'acme-invoices' });
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['acme', 'invoice']);
    expect(outcome.collections.map((entry) => entry.value)).toEqual(['Office/Invoices', 'Office/Invoices/2026']);
    expect(outcome.customFields).toEqual([{ field: 'reference_number', value: '40231', ruleId: 'scanner-convention' }]);
  });

  it('renders the trace the README shows', () => {
    const rendered = renderTrace(evaluateIngestion(ruleSet, subject).trace);
    for (const line of [
      'ingestion rule set "Office filing" (all-match) on doc-acme',
      '  [0] acme-invoices (priority 100): matched',
      '    - ✓ all: all 3 members matched',
      '      - ✓ sender: "billing@acme.example" ends with "@acme.example"',
      '      - ✓ not: the member did not match',
      '        - ✗ tag: no tags on this subject; the rule wanted one that equals "filed"',
      '  [2] unresolved-pdfs (priority -10): not-matched',
      '    - ✗ all: a member did not match (2 of 2 evaluated, stopped at resolver)',
    ]) {
      expect(rendered).toContain(line);
      expect(readme).toContain(line);
    }
  });
});
