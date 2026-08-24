import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RULE_SET_SCHEMA_ID, ruleSetJsonSchema } from '../src/json-schema.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import { DEDUP_YAML, PRECEDENCE_YAML } from './fixtures.js';

const checkedIn = JSON.parse(
  readFileSync(fileURLToPath(new URL('../schema/rule-set.schema.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('the published JSON Schema', () => {
  it('matches what the Zod schema generates — run `pnpm run json-schema` after changing src/schema', () => {
    expect(checkedIn).toEqual(ruleSetJsonSchema());
  });

  it('carries an $id and the 2020-12 dialect, so a UI can resolve it', () => {
    expect(checkedIn['$id']).toBe(RULE_SET_SCHEMA_ID);
    expect(checkedIn['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('has no generated placeholder names left in $defs', () => {
    const defs = checkedIn['$defs'] as Record<string, unknown>;
    expect(Object.keys(defs).filter((name) => name.startsWith('__'))).toEqual([]);
  });

  it('names the definitions a rule editor needs to build a form', () => {
    const defs = Object.keys(checkedIn['$defs'] as Record<string, unknown>);
    for (const wanted of [
      'IngestionRuleSet',
      'DedupRuleSet',
      'IngestionRule',
      'DedupRule',
      'IngestionCondition',
      'DedupCondition',
      'IngestionAction',
      'DedupAction',
      'Matcher',
      'RuleId',
      'RuleMode',
      'MergeWinner',
    ]) {
      expect(defs).toContain(wanted);
    }
  });

  it('closes every object, so a typo in the editor is a validation error and not a silent no-op', () => {
    const closed = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.every(closed);
      if (typeof node !== 'object' || node === null) return true;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && record['properties'] !== undefined && record['additionalProperties'] !== false) return false;
      return Object.values(record).every(closed);
    };
    expect(closed(checkedIn)).toBe(true);
  });

  it('describes the two kinds as a choice, keyed on `kind`', () => {
    expect(checkedIn['oneOf']).toEqual([{ $ref: '#/$defs/IngestionRuleSet' }, { $ref: '#/$defs/DedupRuleSet' }]);
  });

  it('accepts the fixture rule sets, which the engine also runs', () => {
    // Not a schema-validation run — that is Zod's job and is tested in parse.test.ts. This asserts
    // the two halves describe the same documents: anything the engine accepts must round-trip
    // through the JSON form the schema governs.
    for (const yaml of [PRECEDENCE_YAML, DEDUP_YAML]) {
      const parsed = parseRuleSetOrThrow(yaml);
      expect(parseRuleSetOrThrow(JSON.stringify(parsed))).toEqual(parsed);
    }
  });
});
