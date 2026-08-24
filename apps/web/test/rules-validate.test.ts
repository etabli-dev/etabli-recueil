/**
 * Validating in the browser with the engine's own parser.
 *
 * The claim the editor makes is that its verdict is the executor's verdict. These tests are what
 * that claim rests on: they check the cases only the real parser catches — a duplicate rule id, and
 * a regular expression the linear-time engine cannot compile — rather than checking that some
 * validator, somewhere, said no.
 */
import { describe, expect, it } from 'vitest';
import { RULE_FORMAT_VERSION } from '@recueil/rules';
import ruleSetSchemaJson from '@recueil/rules/rule-set.schema.json' with { type: 'json' };

import { RULE_SET_SCHEMA_ID, STARTER_RULE_SET, detectFormat, validateRuleText } from '../src/rules/validate.js';
import { RULE_SET_TEXT } from './ingestion-fixtures.js';

describe('detectFormat', () => {
  it('sniffs JSON by its opening brace, as the engine does', () => {
    expect(detectFormat('{"version": 1}')).toBe('json');
    expect(detectFormat('version: 1\n')).toBe('yaml');
  });
});

describe('validateRuleText', () => {
  it('accepts the fixture rule set', () => {
    const result = validateRuleText(RULE_SET_TEXT);
    expect(result.ok).toBe(true);
  });

  it('accepts the starter document offered to a library with no rules yet', () => {
    const result = validateRuleText(STARTER_RULE_SET);
    if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    expect(result.ruleSet.kind).toBe('ingestion');
  });

  it('reports a YAML error with its position rather than throwing', () => {
    const result = validateRuleText('version: 1\nkind: ingestion\nrules: [\n');
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues[0]?.message).toContain('not valid YAML');
  });

  it('catches a duplicate rule id, which no JSON Schema check would', () => {
    const text = `version: ${String(RULE_FORMAT_VERSION)}
kind: ingestion
rules:
  - id: same
    when: { type: always }
    then: [{ type: stop }]
  - id: same
    when: { type: always }
    then: [{ type: stop }]
`;
    const result = validateRuleText(text);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.issues.map((issue) => issue.message).join(' ')).toContain('duplicate rule id');
  });

  it('catches a pattern the linear-time engine cannot run, before it reaches the pipeline', () => {
    const text = `version: ${String(RULE_FORMAT_VERSION)}
kind: ingestion
rules:
  - id: lookahead
    when:
      type: filename
      match:
        matches: "(?=invoice).*"
    then: [{ type: stop }]
`;
    const result = validateRuleText(text);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.issues.map((issue) => issue.path).join(' ')).toContain('matches');
  });

  it('refuses a document that is valid YAML and not a rule set', () => {
    const result = validateRuleText('hello: world\n');
    expect(result.ok).toBe(false);
  });
});

describe('the schema the editor names', () => {
  it('is the one packages/rules publishes, so the editor is not citing a schema of its own', () => {
    expect((ruleSetSchemaJson as { $id: string }).$id).toBe(RULE_SET_SCHEMA_ID);
  });
});
