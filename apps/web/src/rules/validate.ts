/**
 * Validating a rule set in the browser, against the engine's own schema.
 *
 * `parseRuleSet` is imported from `@recueil/rules` — not reimplemented, not approximated by a JSON
 * Schema validator, not replaced by a regex that looks for `version:`. It is the same function the
 * server calls and the same one the pipeline's stage 8 runs behind, so an editor that says a rule
 * set is valid is saying it in the words of the thing that will execute it. That matters most for
 * the two checks nothing else would make: the regular expressions in a `matches` matcher are
 * compiled by the linear-time engine, so an unsupported construct is a validation error with a
 * position rather than a surprise at ingest time; and the duplicate-rule-id check fires here rather
 * than after a save.
 *
 * The editor still sends the text and the server still validates it. This is the fast half of the
 * loop, not the authority: a browser that has an old bundle cached must not be able to talk a
 * server into storing something it would refuse.
 */
import { RULE_SET_SCHEMA_ID, parseRuleSet } from '@recueil/rules';
import type { RuleSet, RuleSetIssue } from '@recueil/rules';

export type { RuleSetIssue };
export { RULE_SET_SCHEMA_ID };

export type RuleValidation =
  | { ok: true; ruleSet: RuleSet; format: 'yaml' | 'json' }
  | { ok: false; issues: readonly RuleSetIssue[]; format: 'yaml' | 'json' };

/** JSON when the first non-space character is `{`, which is what `parseRuleSet` itself sniffs. */
export const detectFormat = (text: string): 'yaml' | 'json' =>
  text.trimStart().startsWith('{') ? 'json' : 'yaml';

export const validateRuleText = (text: string): RuleValidation => {
  const format = detectFormat(text);
  const parsed = parseRuleSet(text, { format });
  return parsed.ok ? { ok: true, ruleSet: parsed.ruleSet, format } : { ok: false, issues: parsed.issues, format };
};

/**
 * A starting document, for a library that has no rule set yet.
 *
 * Written as YAML with comments, because the first thing anyone does with a rule set is read it,
 * and because the two rules below are the two shapes that cover most of what a scanner produces: a
 * path convention that is trustworthy, and a catch-all that is honest about not being.
 */
export const STARTER_RULE_SET = `version: 1
kind: ingestion
name: Office intake
mode: all-match

rules:
  # A scanner that files into a directory per correspondent knows more than the heuristics do,
  # so this rule raises the confidence the gate at stage 9 will read.
  - id: scanner-by-folder
    description: Trust the scanner's own filing convention.
    priority: 100
    when:
      all:
        - type: source
          match: { equals: scanner }
        - type: path
          match: { matches: "scans/(?<correspondent>[^/]+)/" }
    then:
      - type: set-item-type
        itemType: invoice
      - type: set-correspondent
        correspondent: \${correspondent}
      - type: add-to-collection
        collection: Office/Scans
      - type: set-confidence
        confidence: 0.95

  # Everything else is flagged rather than guessed (P3).
  - id: unfiled
    description: Anything the rules above did not recognise.
    priority: -100
    when:
      type: always
    then:
      - type: route-to-review
        reasonCode: no_rule_matched
        explanation: No ingestion rule recognised this document, so it was not filed.
        severity: info
        proposedAction: set_fields
`;
