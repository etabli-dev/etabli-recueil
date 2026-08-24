import { describe, expect, it } from 'vitest';

import { loadRuleSet, parseRuleSet, parseRuleSetOrThrow, RuleSetError } from '../src/parse.js';
import { RULE_FORMAT_VERSION } from '../src/version.js';
import { PRECEDENCE_YAML } from './fixtures.js';

const issuesOf = (text: string): readonly { path: string; message: string }[] => {
  const result = parseRuleSet(text);
  if (result.ok) throw new Error('expected the rule set to be refused');
  return result.issues;
};

describe('reading a rule set', () => {
  it('reads YAML', () => {
    const parsed = parseRuleSetOrThrow(PRECEDENCE_YAML);
    expect(parsed.version).toBe(RULE_FORMAT_VERSION);
    expect(parsed.kind).toBe('ingestion');
    expect(parsed.rules).toHaveLength(3);
  });

  it('reads the same set as JSON, and produces the same value', () => {
    const fromYaml = parseRuleSetOrThrow(PRECEDENCE_YAML);
    const fromJson = parseRuleSetOrThrow(JSON.stringify(fromYaml));
    expect(fromJson).toEqual(fromYaml);
  });

  it('accepts an already-decoded value, for an API body or a database row', () => {
    const value = JSON.parse(JSON.stringify(parseRuleSetOrThrow(PRECEDENCE_YAML))) as unknown;
    const result = loadRuleSet(value);
    expect(result.ok).toBe(true);
  });

  it('refuses a version it does not read, by name', () => {
    expect(issuesOf('version: 99\nkind: ingestion\nrules: []')).toEqual([
      { path: 'version', message: `rule format version 99 is not one this build reads (${RULE_FORMAT_VERSION})` },
    ]);
  });

  it('refuses a missing or unknown kind', () => {
    expect(issuesOf('version: 1\nkind: guesswork\nrules: []')[0]!.message).toContain('must be `ingestion`');
  });

  it('refuses a document that is not a mapping', () => {
    expect(issuesOf('- a\n- b')[0]!.message).toContain('must be a mapping');
    expect(issuesOf('')[0]!.message).toContain('empty');
  });

  it('reports a YAML syntax error with a position', () => {
    const message = issuesOf('version: 1\nkind: ingestion\nrules:\n  - id: a\n   bad indent')[0]!.message;
    expect(message).toContain('not valid YAML at line');
  });

  it('reports a JSON syntax error as JSON', () => {
    expect(issuesOf('{ "version": 1, }')[0]!.message).toContain('not valid JSON');
  });
});

describe('validation messages', () => {
  const wrap = (when: string, then = '      - type: stop'): string =>
    `version: 1\nkind: ingestion\nrules:\n  - id: probe\n    when:\n${when}\n    then:\n${then}\n`;

  it('names the offending rule and field', () => {
    const issues = issuesOf(wrap('      type: sender\n      match: { equals: 1, contains: 2 }'));
    expect(issues[0]!.path.startsWith('rules[0].when.match')).toBe(true);
  });

  it('reaches through the matcher union to the pattern that will not compile', () => {
    const issues = issuesOf(wrap('      type: filename\n      match: { matches: "(?=x)y" }'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('rules[0].when.match.matches');
    expect(issues[0]!.message).toContain('lookahead is not supported by the linear engine');
  });

  it('refuses a backreference for the same reason', () => {
    expect(issuesOf(wrap('      type: text\n      match: { matches: "(a)\\\\1" }'))[0]!.message).toContain('backreferences');
  });

  it('refuses a glob that will not compile', () => {
    expect(issuesOf(wrap('      type: path\n      match: { glob: "a{b" }'))[0]!.message).toContain('unmatched {');
  });

  it('refuses an unknown key rather than ignoring it', () => {
    const issues = issuesOf(`version: 1\nkind: ingestion\nrules:\n  - id: probe\n    wehn: {}\n    when: { type: always }\n    then:\n      - type: stop\n`);
    expect(issues.map((issue) => issue.message).join(' ')).toContain('wehn');
  });

  it('refuses a duplicate rule id, because ids are how provenance points back', () => {
    const text = `version: 1\nkind: ingestion\nrules:\n  - id: twice\n    when: { type: always }\n    then: [{ type: stop }]\n  - id: twice\n    when: { type: always }\n    then: [{ type: stop }]\n`;
    const issues = issuesOf(text);
    expect(issues[0]!.path).toBe('rules[1].id');
    expect(issues[0]!.message).toContain('duplicate rule id "twice"');
  });

  it('refuses a rule id that is not an identifier', () => {
    expect(issuesOf(`version: 1\nkind: ingestion\nrules:\n  - id: "Not An Id"\n    when: { type: always }\n    then: [{ type: stop }]\n`)[0]!.path).toBe(
      'rules[0].id',
    );
  });

  it('refuses a rule with no actions', () => {
    expect(issuesOf(`version: 1\nkind: ingestion\nrules:\n  - id: probe\n    when: { type: always }\n    then: []\n`)[0]!.path).toBe('rules[0].then');
  });

  it('refuses a confidence outside 0..1', () => {
    expect(issuesOf(wrap('      type: always', '      - type: set-confidence\n        confidence: 1.5'))[0]!.path).toBe(
      'rules[0].then[0].confidence',
    );
  });

  it('refuses a dedup action in an ingestion set', () => {
    expect(issuesOf(wrap('      type: always', '      - type: merge\n        winner: newest')).length).toBeGreaterThan(0);
  });

  it('throws a RuleSetError carrying every issue', () => {
    try {
      parseRuleSetOrThrow('version: 1\nkind: ingestion\nrules:\n  - id: probe\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleSetError);
      expect((error as RuleSetError).issues.length).toBeGreaterThan(0);
      expect((error as Error).message).toContain('rule set is not valid');
    }
  });
});

describe('hostile documents', () => {
  it('refuses a YAML alias bomb rather than expanding it', () => {
    const bomb = [
      'version: 1',
      'kind: ingestion',
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'rules: []',
    ].join('\n');
    const result = parseRuleSet(bomb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toContain('Excessive alias count');
  });

  it('does not run a rule set that only claims to be one', () => {
    expect(parseRuleSet('version: 1\nkind: ingestion\nrules: "all of them"').ok).toBe(false);
  });
});
