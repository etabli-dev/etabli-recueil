/**
 * The rule table as a document, and back.
 *
 * The server stores one row per rule (`spec/data-model.md` O2 recommended a table and it built
 * one), and CONCEPT.md §5.6 asks for rules "editable as YAML/JSON in the UI". Those are not in
 * conflict, but they do need a translation, and this module is it: rows become one `@recueil/rules`
 * rule-set document, and an edited document becomes the set of creates, updates and deletes that
 * turns the table into what the document says.
 *
 * Two things about the diff are deliberate.
 *
 * **It is keyed by `ruleId`, the author's handle, not by the row's ULID.** That is what makes the
 * text editable by hand: a person writing YAML has the handle in front of them and has never seen
 * the ULID. It also means renaming a handle reads as a delete and a create, which is exactly what
 * it is — a tag added by the old handle points at a rule that no longer exists, and pretending the
 * rename was an update would hide that.
 *
 * **A rule whose content has not changed produces no request.** Saving a document after editing one
 * rule must not rewrite forty rows, bump forty version counters and fill the audit log.
 */
import { stringify } from 'yaml';
import { RULE_FORMAT_VERSION } from '@recueil/rules';
import type { IngestionRule, IngestionRuleSet } from '@recueil/rules';

import type { Rule, RuleCreate, RuleUpdate } from '../api/ingestion.js';

/**
 * The stored rules as one document.
 *
 * `mode` is not written: it is not a stored property of the table — the server assembles the set
 * with the mode the caller asks for — so putting a value in the document would be inventing one.
 */
export const rulesToText = (rules: readonly Rule[]): string => {
  const document_ = {
    version: RULE_FORMAT_VERSION,
    kind: 'ingestion',
    rules: rules.map((rule) => ({
      id: rule.ruleId,
      ...(rule.description === null ? {} : { description: rule.description }),
      ...(rule.enabled ? {} : { enabled: false }),
      ...(rule.priority === 0 ? {} : { priority: rule.priority }),
      when: rule.when,
      then: rule.then,
    })),
  };
  return stringify(document_, { lineWidth: 100 });
};

/** One rule of a parsed document, as the API takes it. */
export const toCreate = (rule: IngestionRule): RuleCreate => ({
  ruleId: rule.id,
  kind: 'ingestion',
  when: rule.when,
  then: [...rule.then],
  ...(rule.description === undefined ? {} : { description: rule.description }),
  ...(rule.enabled === undefined ? {} : { enabled: rule.enabled }),
  ...(rule.priority === undefined ? {} : { priority: rule.priority }),
});

export interface RuleSetDiff {
  create: RuleCreate[];
  update: { id: string; ruleId: string; body: RuleUpdate }[];
  /** Rows whose handle is no longer in the document. Removed, because the document is the set. */
  remove: { id: string; ruleId: string }[];
}

/** Whether two rule bodies are the same. Compared as JSON, because that is how both are stored. */
const sameBody = (stored: Rule, wanted: RuleCreate): boolean =>
  JSON.stringify(stored.when) === JSON.stringify(wanted.when) &&
  JSON.stringify(stored.then) === JSON.stringify(wanted.then) &&
  (stored.description ?? undefined) === wanted.description &&
  stored.enabled === (wanted.enabled ?? true) &&
  stored.priority === (wanted.priority ?? 0);

/**
 * What has to happen for the table to say what the document says.
 *
 * Returns an empty diff for an unchanged document, which is what lets the save button be disabled
 * honestly rather than always enabled and usually a no-op.
 */
export const diffRuleSet = (stored: readonly Rule[], wanted: IngestionRuleSet): RuleSetDiff => {
  const byHandle = new Map(stored.map((rule) => [rule.ruleId, rule]));
  const diff: RuleSetDiff = { create: [], update: [], remove: [] };
  const seen = new Set<string>();

  for (const rule of wanted.rules) {
    const create = toCreate(rule);
    seen.add(rule.id);
    const existing = byHandle.get(rule.id);
    if (existing === undefined) {
      diff.create.push(create);
      continue;
    }
    if (sameBody(existing, create)) continue;
    diff.update.push({
      id: existing.id,
      ruleId: existing.ruleId,
      body: {
        description: create.description ?? null,
        enabled: create.enabled ?? true,
        priority: create.priority ?? 0,
        when: create.when,
        then: create.then,
      },
    });
  }

  for (const rule of stored) {
    if (!seen.has(rule.ruleId)) diff.remove.push({ id: rule.id, ruleId: rule.ruleId });
  }
  return diff;
};

export const isEmptyDiff = (diff: RuleSetDiff): boolean =>
  diff.create.length === 0 && diff.update.length === 0 && diff.remove.length === 0;

/** The diff in a sentence, so the save button says what pressing it will do. */
export const describeDiff = (diff: RuleSetDiff): string => {
  const parts: string[] = [];
  if (diff.create.length > 0) parts.push(`add ${count(diff.create.length, 'rule')}`);
  if (diff.update.length > 0) parts.push(`change ${count(diff.update.length, 'rule')}`);
  if (diff.remove.length > 0) {
    parts.push(`remove ${diff.remove.map((rule) => rule.ruleId).join(', ')}`);
  }
  return parts.length === 0 ? 'Nothing to save.' : `Will ${parts.join(', ')}.`;
};

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
