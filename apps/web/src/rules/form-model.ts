/**
 * The rule shape the form can edit, and the honest boundary of it.
 *
 * A rule's condition is a tree: `all`, `any` and `not` compose leaves to any depth. A form that
 * claimed to edit that tree would be an outline editor, and a bad one. So the form edits the shape
 * that covers what a real ingestion rule set is made of — a flat conjunction or disjunction of
 * leaves, each a field and one matcher — and **declines** anything else rather than flattening it.
 * `toSimpleRule` returns `null` for a nested condition, the editor shows that rule read-only with
 * its YAML, and nothing is silently rewritten.
 *
 * That boundary is the point. The alternative failure is the one to avoid: a form that opens a
 * nested rule, renders the part it understands, and saves that part over the whole thing.
 */
import type { IngestionAction, IngestionCondition, IngestionLeafCondition, IngestionRule, Matcher } from '@recueil/rules';

/** The matcher operators, as the form's operator picker offers them. */
export const MATCHER_OPERATORS = [
  'equals',
  'equalsAny',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'glob',
] as const;

export type MatcherOperator = (typeof MATCHER_OPERATORS)[number];

/** The leaf condition types that carry a matcher. `resolver` and `always` do not, and are excluded. */
export const CONDITION_FIELDS = [
  'source',
  'sender',
  'recipient',
  'subject',
  'path',
  'filename',
  'mime',
  'text',
  'item-type',
  'tag',
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];

export interface SimpleCondition {
  field: ConditionField;
  operator: MatcherOperator;
  /** For `equalsAny`, the members joined by newlines — which is how the textarea holds them. */
  value: string;
  caseSensitive: boolean;
}

export interface SimpleRule {
  id: string;
  description: string;
  enabled: boolean;
  priority: number;
  /** How the leaves combine. A single leaf is `all` with one member. */
  combinator: 'all' | 'any';
  /** `true` when the condition is the literal `always`, in which case `conditions` is empty. */
  always: boolean;
  conditions: SimpleCondition[];
  actions: IngestionAction[];
}

/* Reading ------------------------------------------------------------------------------------- */

const isLeaf = (condition: IngestionCondition): condition is IngestionLeafCondition =>
  typeof condition === 'object' && condition !== null && 'type' in condition;

const operatorOf = (match: Matcher): { operator: MatcherOperator; value: string } | null => {
  const record = match as Record<string, unknown>;
  for (const operator of MATCHER_OPERATORS) {
    const value = record[operator];
    if (typeof value === 'string') return { operator, value };
    if (Array.isArray(value)) return { operator, value: value.map(String).join('\n') };
  }
  return null;
};

const toSimpleCondition = (condition: IngestionCondition): SimpleCondition | null => {
  if (!isLeaf(condition)) return null;
  if (!(CONDITION_FIELDS as readonly string[]).includes(condition.type)) return null;
  const leaf = condition as { type: ConditionField; match: Matcher };
  const parsed = operatorOf(leaf.match);
  if (parsed === null) return null;
  return {
    field: leaf.type,
    operator: parsed.operator,
    value: parsed.value,
    caseSensitive: (leaf.match as { caseSensitive?: boolean }).caseSensitive ?? false,
  };
};

/**
 * A rule as the form can hold it, or `null` when the form would have to lose something.
 *
 * `null` is returned for a nested tree, for a `not`, for a `resolver` condition and for a matcher
 * whose operator the picker does not offer — every case where round-tripping through the form would
 * not produce the rule that went in.
 */
export const toSimpleRule = (rule: IngestionRule): SimpleRule | null => {
  const base = {
    id: rule.id,
    description: rule.description ?? '',
    enabled: rule.enabled ?? true,
    priority: rule.priority ?? 0,
    actions: [...rule.then],
  };

  const when = rule.when;
  if (isLeaf(when) && when.type === 'always') {
    return { ...base, combinator: 'all', always: true, conditions: [] };
  }
  if (isLeaf(when)) {
    const single = toSimpleCondition(when);
    return single === null ? null : { ...base, combinator: 'all', always: false, conditions: [single] };
  }
  if ('all' in when || 'any' in when) {
    const combinator = 'all' in when ? 'all' : 'any';
    const members = ('all' in when ? when.all : when.any) as IngestionCondition[];
    const simple: SimpleCondition[] = [];
    for (const member of members) {
      const converted = toSimpleCondition(member);
      if (converted === null) return null;
      simple.push(converted);
    }
    return { ...base, combinator, always: false, conditions: simple };
  }
  return null;
};

/* Writing ------------------------------------------------------------------------------------- */

const toMatcher = (condition: SimpleCondition): Matcher => {
  const base = condition.caseSensitive ? { caseSensitive: true } : {};
  if (condition.operator === 'equalsAny') {
    const members = condition.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return { equalsAny: members, ...base } as Matcher;
  }
  return { [condition.operator]: condition.value, ...base } as Matcher;
};

/** The rule as it will be written into the document. Absent optionals are omitted, not nulled. */
export const fromSimpleRule = (simple: SimpleRule): IngestionRule => {
  const when: IngestionCondition = simple.always
    ? { type: 'always' }
    : simple.conditions.length === 1
      ? ({ type: simple.conditions[0]?.field, match: toMatcher(simple.conditions[0] as SimpleCondition) } as IngestionCondition)
      : simple.combinator === 'all'
        ? { all: simple.conditions.map((condition) => ({ type: condition.field, match: toMatcher(condition) }) as IngestionCondition) }
        : { any: simple.conditions.map((condition) => ({ type: condition.field, match: toMatcher(condition) }) as IngestionCondition) };

  return {
    id: simple.id,
    ...(simple.description.trim() === '' ? {} : { description: simple.description.trim() }),
    ...(simple.enabled ? {} : { enabled: false }),
    ...(simple.priority === 0 ? {} : { priority: simple.priority }),
    when,
    then: simple.actions,
  } as IngestionRule;
};

/* Describing ----------------------------------------------------------------------------------- */

/** A condition in one line, for the rule list. */
export const describeCondition = (condition: IngestionCondition): string => {
  if (isLeaf(condition)) {
    if (condition.type === 'always') return 'always';
    if (condition.type === 'resolver') {
      const resolver = condition as { resolver?: string; outcome: string | string[] };
      const outcomes = Array.isArray(resolver.outcome) ? resolver.outcome.join(' or ') : resolver.outcome;
      return `${resolver.resolver ?? 'any resolver'} came back ${outcomes}`;
    }
    const leaf = condition as { type: string; match: Matcher };
    const parsed = operatorOf(leaf.match);
    return parsed === null ? leaf.type : `${leaf.type} ${parsed.operator} ${JSON.stringify(parsed.value)}`;
  }
  if ('all' in condition) return condition.all.map(describeCondition).join(' and ');
  if ('any' in condition) return condition.any.map(describeCondition).join(' or ');
  return `not (${describeCondition(condition.not)})`;
};

/** An action in one line. Every branch names what the action writes, not what it is called. */
export const describeAction = (action: IngestionAction): string => {
  switch (action.type) {
    case 'set-item-type':
      return `set the item type to ${action.itemType}`;
    case 'add-to-collection':
      return `file it under ${action.collection}`;
    case 'add-tags':
      return `tag it ${action.tags.join(', ')}`;
    case 'set-custom-field':
      return `set ${action.field} to ${JSON.stringify(action.value)}`;
    case 'set-correspondent':
      return `record the correspondent as ${action.correspondent}`;
    case 'set-confidence':
      return `set the confidence to ${action.confidence.toFixed(2)}`;
    case 'route-to-review':
      return `send it to review as ${action.reasonCode}`;
    case 'stop':
      return 'stop: apply nothing further';
    default:
      return (action as { type: string }).type;
  }
};
