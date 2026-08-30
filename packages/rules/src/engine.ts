/**
 * The engine: precedence, boolean composition, action application, trace.
 *
 * Everything here is facet-independent, which is the point. `all`, `any` and `not` mean the same
 * thing over an ingestion subject and over a duplicate pair, and so do "higher priority first",
 * "stop cuts the run" and "record what happened". A facet supplies only the two things that differ:
 * how to evaluate one leaf condition against its own subject, and how to apply one action to its
 * own draft outcome.
 *
 * **Determinism.** Rules are sorted by priority descending, then by the order they are written. The
 * sort is stable and the tiebreak is explicit, so a rule set with no priorities at all still
 * evaluates in a fixed order, and adding a rule in the middle of a file cannot reorder the others.
 * Nothing in the evaluation reads a clock, a random source or the filesystem: the same rule set over
 * the same subject produces the same outcome and the same trace, which is what makes a dry run a
 * prediction rather than an estimate.
 *
 * **Purity.** `evaluateRules` returns a decision. It writes nothing, and it is given no handle with
 * which it could: the subject is a plain value and the outcome is a plain value. The dry run in
 * `./dry-run.ts` is therefore not a special mode with the writes disabled — it is the ordinary
 * evaluation, which never had any.
 */
import type { ConditionTrace, ActionTrace, EvaluationTrace, RuleOutcome, RuleTrace } from './trace.js';
import type { RuleKind, RuleLimits, RuleMode } from './schema/common.js';

/** The shape every rule has, whatever facet it belongs to. */
export interface RuleLike<Condition, Action> {
  readonly id: string;
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly when: Condition;
  readonly then: readonly Action[];
}

export interface RuleSetLike<Condition, Action> {
  readonly kind: RuleKind;
  readonly name?: string | undefined;
  readonly mode?: RuleMode | undefined;
  readonly limits?: RuleLimits | undefined;
  readonly rules: readonly RuleLike<Condition, Action>[];
}

export interface ResolvedLimits {
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly maxTextLength: number;
  readonly maxInputLength: number;
}

/**
 * The defaults a rule set inherits when it says nothing.
 *
 * The two length limits are not the same limit and it is worth being exact about which does what,
 * because they answer different questions and only one of them can refuse anything.
 *
 * - **`maxTextLength` truncates.** Extracted text from a long scanned contract is routinely
 *   megabytes, and a `text` condition that reads all of it against twenty rules is the slowest
 *   thing this engine does. Past this length the `text` condition sees the beginning of the
 *   document and the trace says so, because a condition evaluated against part of a document must
 *   never be reported as if it had seen all of it.
 * - **`maxInputLength` refuses.** It is the matcher's own ceiling, applied to *every* value a rule
 *   reads — a filename, a mail subject, a path, a tag, as well as text — and a value above it is a
 *   named refusal that routes the subject to review rather than a verdict nobody computed. It is
 *   also what stops the matcher allocating anything proportional to a value it was never going to
 *   be able to finish reading.
 *
 * The effective bound on a `text` condition is therefore the smaller of the two: it truncates to
 * `maxInputLength` rather than being refused for exceeding it, which keeps the documented behaviour
 * of a long document ("the rule saw the first N characters") instead of turning every long document
 * into a review entry.
 *
 * `maxTextLength` stays at sixteen megabytes because that is the honest statement of what a rule
 * author may ask for; the shipped `maxInputLength` of 256 KiB is what an unconfigured engine can
 * actually finish inside `timeoutMs`, and raising one without the other does nothing.
 */
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxSteps: 5_000_000,
  timeoutMs: 250,
  maxTextLength: 16 * 1024 * 1024,
  maxInputLength: 256 * 1024,
};

export const resolveLimits = (limits?: RuleLimits, overrides?: Partial<ResolvedLimits>): ResolvedLimits => {
  // `maxInputLength` is not a field of `RuleLimitsSchema` yet: that schema is rendered into
  // `apps/server/openapi.yaml`, a committed artefact belonging to another package, and adding a
  // field to it without regenerating that document leaves the drift test red. It is read leniently
  // here so that the engine default and a caller's `EvaluateOptions.limits` both work today, and
  // the day the wire schema carries it nothing on these lines has to change.
  const declared = limits as (RuleLimits & { readonly maxInputLength?: number }) | undefined;
  return {
    maxSteps: overrides?.maxSteps ?? limits?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
    timeoutMs: overrides?.timeoutMs ?? limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxTextLength: overrides?.maxTextLength ?? limits?.maxTextLength ?? DEFAULT_LIMITS.maxTextLength,
    maxInputLength: overrides?.maxInputLength ?? declared?.maxInputLength ?? DEFAULT_LIMITS.maxInputLength,
  };
};

/** What a facet is handed while it evaluates one rule. */
export interface EvaluationContext {
  readonly limits: ResolvedLimits;
  /** Named captures collected so far in this rule. A facet adds to it when a regex matched. */
  readonly captures: Map<string, string>;
  /**
   * False inside a `not`, where a child that matched is evidence *against* the rule. Its captures
   * would be meaningless in an action, so a facet must not record them.
   */
  collecting: boolean;
  readonly warnings: string[];
  readonly ruleId: string;
}

/** What a facet is handed while it applies one action. */
export interface ActionContext {
  readonly ruleId: string;
  readonly captures: ReadonlyMap<string, string>;
  readonly warnings: string[];
}

/**
 * The two halves a facet supplies. `Draft` accumulates while the rules run; `Outcome` is the frozen
 * answer handed back.
 */
export interface RuleFacet<Subject, Condition extends object, Action extends { type: string }, Draft, Outcome> {
  readonly kind: RuleKind;
  /** Evaluate one leaf condition. `all`, `any` and `not` never reach here. */
  evaluateLeaf(condition: Condition, subject: Subject, context: EvaluationContext): ConditionTrace;
  createDraft(): Draft;
  applyAction(action: Action, subject: Subject, draft: Draft, context: ActionContext): ActionTrace;
  /** True once a `stop` action has been applied. */
  isStopped(draft: Draft): boolean;
  finish(draft: Draft): Outcome;
}

type Composite<Condition> =
  | { readonly type: 'all'; readonly of: readonly Condition[] }
  | { readonly type: 'any'; readonly of: readonly Condition[] }
  | { readonly type: 'not'; readonly of: Condition };

/**
 * Recognise a composite.
 *
 * A leaf is `{ type: … }`; a composite is `{ all: [ … ] }`, `{ any: [ … ] }` or `{ not: … }`. The
 * shapes cannot collide, because both facets' leaf schemas are strict objects that require `type`
 * and neither declares an `all`, `any` or `not` property.
 */
const asComposite = <Condition extends object>(condition: Condition): Composite<Condition> | undefined => {
  const record = condition as Record<string, unknown>;
  if (Array.isArray(record['all'])) return { type: 'all', of: record['all'] as readonly Condition[] };
  if (Array.isArray(record['any'])) return { type: 'any', of: record['any'] as readonly Condition[] };
  if (record['not'] !== undefined && typeof record['not'] === 'object') return { type: 'not', of: record['not'] as Condition };
  return undefined;
};

/**
 * How deeply `all`, `any` and `not` may nest inside one rule.
 *
 * `parse.ts` refuses a document deeper than this before the schema sees it, but `evaluateRules`
 * takes a `RuleSetLike` — a plain object another package may have built without going through the
 * parser, which is exactly what the ingest pipeline's rule adapter does. A guard here turns what
 * would be a `RangeError` out of the middle of an evaluation into an ordinary undecidable
 * condition, so the rule is traced as `error` and the subject goes to a human (P3).
 */
export const MAX_CONDITION_DEPTH = 64;

/** Did anything in this trace fail to evaluate? A rule with an undecidable condition is not a non-match. */
export const traceHasError = (trace: ConditionTrace): boolean =>
  trace.error !== undefined || (trace.children ?? []).some(traceHasError);

const evaluateCondition = <Subject, Condition extends object, Action extends { type: string }, Draft, Outcome>(
  condition: Condition,
  subject: Subject,
  facet: RuleFacet<Subject, Condition, Action, Draft, Outcome>,
  context: EvaluationContext,
  depth = 1,
): ConditionTrace => {
  if (depth > MAX_CONDITION_DEPTH) {
    const detail = `condition nests more than ${MAX_CONDITION_DEPTH} levels deep (MAX_CONDITION_DEPTH)`;
    return { type: 'unknown', matched: false, detail, error: detail };
  }
  const composite = asComposite(condition);
  if (composite === undefined) return facet.evaluateLeaf(condition, subject, context);

  if (composite.type === 'not') {
    const wasCollecting = context.collecting;
    context.collecting = false;
    const child = evaluateCondition(composite.of, subject, facet, context, depth + 1);
    context.collecting = wasCollecting;
    return {
      type: 'not',
      matched: !child.matched && child.error === undefined && !traceHasError(child),
      detail: child.matched ? 'the member matched, so `not` does not' : 'the member did not match',
      children: [child],
    };
  }

  const children: ConditionTrace[] = [];
  const wantAll = composite.type === 'all';
  for (const member of composite.of) {
    const child = evaluateCondition(member, subject, facet, context, depth + 1);
    children.push(child);
    // Short-circuit: the remaining members are not evaluated, and are therefore absent from the
    // trace rather than reported with a verdict nobody computed.
    if (traceHasError(child)) break;
    if (wantAll && !child.matched) break;
    if (!wantAll && child.matched) break;
  }

  const decided = children[children.length - 1];
  const errored = children.some(traceHasError);
  const matched = errored ? false : wantAll ? children.every((child) => child.matched) : children.some((child) => child.matched);
  const evaluated = `${children.length} of ${composite.of.length} evaluated`;
  return {
    type: composite.type,
    matched,
    detail: errored
      ? `stopped at a member that could not be evaluated (${evaluated})`
      : matched
        ? wantAll
          ? `all ${composite.of.length} members matched`
          : `a member matched (${evaluated})`
        : wantAll
          ? `a member did not match (${evaluated}${decided === undefined ? '' : `, stopped at ${decided.type}`})`
          : `no member matched (${evaluated})`,
    children,
  };
};

/**
 * Sort into evaluation order: priority descending, then the order the rules were written.
 *
 * Exported because a report and a rule editor both want to show the order without re-deriving it,
 * and because "the order is this function" is a better contract than "the order is whatever the
 * engine does".
 */
export const sortRules = <Condition, Action, Rule extends RuleLike<Condition, Action>>(rules: readonly Rule[]): readonly Rule[] =>
  rules
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => (right.rule.priority ?? 0) - (left.rule.priority ?? 0) || left.index - right.index)
    .map((entry) => entry.rule);

export interface EvaluateOptions {
  /** Identifies the subject in the trace and in a dry-run report. */
  readonly subjectId?: string;
  /** Tighten (or loosen) what the rule set asked for — a dry run over a corpus usually tightens. */
  readonly limits?: Partial<ResolvedLimits>;
}

export interface Evaluation<Outcome> {
  readonly outcome: Outcome;
  readonly trace: EvaluationTrace;
}

/**
 * Run a rule set over one subject.
 *
 * Every rule appears in the trace, including the ones that were disabled and the ones that were
 * never reached, because a trace that omits them cannot answer "why did my rule not fire".
 */
export const evaluateRules = <Subject, Condition extends object, Action extends { type: string }, Draft, Outcome>(
  ruleSet: RuleSetLike<Condition, Action>,
  subject: Subject,
  facet: RuleFacet<Subject, Condition, Action, Draft, Outcome>,
  options: EvaluateOptions = {},
): Evaluation<Outcome> => {
  const mode: RuleMode = ruleSet.mode ?? 'all-match';
  const limits = resolveLimits(ruleSet.limits, options.limits);
  const warnings: string[] = [];
  const draft = facet.createDraft();
  const ordered = sortRules(ruleSet.rules);
  const traces: RuleTrace[] = [];
  const matchedRuleIds: string[] = [];
  let stoppedBy: string | undefined;

  for (const [order, rule] of ordered.entries()) {
    const priority = rule.priority ?? 0;
    const base = { ruleId: rule.id, order, priority, ...(rule.description === undefined ? {} : { description: rule.description }) };

    if (stoppedBy !== undefined) {
      traces.push({ ...base, outcome: 'not-reached', actions: [] });
      continue;
    }
    if (rule.enabled === false) {
      traces.push({ ...base, outcome: 'disabled', actions: [] });
      continue;
    }

    const context: EvaluationContext = { limits, captures: new Map(), collecting: true, warnings, ruleId: rule.id };
    const condition = evaluateCondition(rule.when, subject, facet, context);
    const errored = traceHasError(condition);

    if (errored) {
      const message = `rule ${rule.id} could not be evaluated; it is treated as not matching and the subject needs a human`;
      warnings.push(message);
      traces.push({ ...base, outcome: 'error', condition, actions: [], error: message });
      continue;
    }
    if (!condition.matched) {
      traces.push({ ...base, outcome: 'not-matched', condition, actions: [] });
      continue;
    }

    matchedRuleIds.push(rule.id);
    const actionContext: ActionContext = { ruleId: rule.id, captures: context.captures, warnings };
    const actions: ActionTrace[] = [];
    for (const action of rule.then) {
      if (facet.isStopped(draft)) {
        actions.push({ type: action.type, outcome: 'skipped', detail: 'evaluation had already stopped' });
        continue;
      }
      actions.push(facet.applyAction(action, subject, draft, actionContext));
    }

    const outcome: RuleOutcome = 'matched';
    traces.push({
      ...base,
      outcome,
      condition,
      actions,
      ...(context.captures.size > 0 ? { captures: Object.fromEntries(context.captures) } : {}),
    });

    if (facet.isStopped(draft)) {
      stoppedBy = rule.id;
    } else if (mode === 'first-match') {
      stoppedBy = rule.id;
      warnings.push(`first-match mode: ${rule.id} matched, so the ${ordered.length - order - 1} rules after it were not reached`);
    }
  }

  return {
    outcome: facet.finish(draft),
    trace: {
      kind: ruleSet.kind,
      ruleSet: ruleSet.name ?? '(unnamed)',
      mode,
      subjectId: options.subjectId ?? '(unidentified)',
      rules: traces,
      matchedRuleIds,
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
      warnings,
    },
  };
};
