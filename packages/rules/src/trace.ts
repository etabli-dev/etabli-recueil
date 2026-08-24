/**
 * The trace: why the engine did what it did.
 *
 * This is not logging. CONCEPT.md §5.3 stage 9 routes anything the confidence gate does not accept
 * into the review queue, and `spec/data-model.md` §6.1 requires each entry to carry a stored,
 * human-readable explanation. A reviewer looking at "this scan became an invoice filed under
 * Office/2026 and tagged `acme`" needs to see which rule decided that and on what evidence,
 * otherwise the only available action is to distrust the whole rule set.
 *
 * Two properties make the trace worth storing. It records the conditions that did *not* match as
 * well as the ones that did, because "why was this rule skipped" is the more common question. And
 * it names the evidence — the matched span, the compared values — rather than restating the rule,
 * so a trace stays true after the rule that produced it has been edited.
 */
import type { RuleKind, RuleMode } from './schema/common.js';

/** One node of the condition tree, as evaluated. */
export interface ConditionTrace {
  /** The condition's `type`, so a UI can render the same icons it uses in the editor. */
  readonly type: string;
  readonly matched: boolean;
  /** One sentence: what was compared with what, and what came back. */
  readonly detail: string;
  /** The matched span, or the value that was read, when quoting it helps a reviewer. */
  readonly evidence?: string;
  /** Present on `all`, `any` and `not`. Short-circuited members are absent, not marked. */
  readonly children?: readonly ConditionTrace[];
  /** Set when the condition could not be evaluated at all — a regex budget, most likely. */
  readonly error?: string;
}

export type ActionOutcome = 'applied' | 'skipped';

export interface ActionTrace {
  readonly type: string;
  readonly outcome: ActionOutcome;
  /** What was applied, or why it was not. */
  readonly detail: string;
}

export type RuleOutcome =
  | 'matched'
  | 'not-matched'
  /** `enabled: false` in the rule set. Traced rather than omitted, so the set reads as written. */
  | 'disabled'
  /** Evaluation had already stopped — first-match mode, or a `stop` action. */
  | 'not-reached'
  /** The condition threw. The rule is treated as not matching, and the failure is on the record. */
  | 'error';

export interface RuleTrace {
  readonly ruleId: string;
  readonly description?: string;
  /** Position in evaluation order, after the precedence sort. Zero-based. */
  readonly order: number;
  readonly priority: number;
  readonly outcome: RuleOutcome;
  readonly condition?: ConditionTrace;
  readonly actions: readonly ActionTrace[];
  /** Named captures this rule's regex conditions produced, and its actions could interpolate. */
  readonly captures?: Readonly<Record<string, string>>;
  readonly error?: string;
}

export interface EvaluationTrace {
  readonly kind: RuleKind;
  readonly ruleSet: string;
  readonly mode: RuleMode;
  /** Whatever the caller used to identify the subject. Echoed so a report can be joined back. */
  readonly subjectId: string;
  readonly rules: readonly RuleTrace[];
  readonly matchedRuleIds: readonly string[];
  /** The rule whose `stop` action, or whose match in first-match mode, ended the run. */
  readonly stoppedBy?: string;
  /**
   * Anything the engine wants a human to know that is not a rule outcome: a truncated text, a
   * normalised path, a regex that ran out of budget, a scalar overwritten by a later rule.
   */
  readonly warnings: readonly string[];
}

const bullet = (depth: number): string => `${'  '.repeat(depth)}- `;

const renderCondition = (trace: ConditionTrace, depth: number, lines: string[]): void => {
  const mark = trace.error !== undefined ? '!' : trace.matched ? '✓' : '✗';
  const evidence = trace.evidence === undefined ? '' : ` — ${JSON.stringify(trace.evidence)}`;
  const error = trace.error === undefined ? '' : ` — ${trace.error}`;
  lines.push(`${bullet(depth)}${mark} ${trace.type}: ${trace.detail}${evidence}${error}`);
  for (const child of trace.children ?? []) renderCondition(child, depth + 1, lines);
};

/**
 * Render a trace as plain text.
 *
 * The dry-run report and the CLI both print this, and the review queue can store it beside the
 * explanation. Deliberately not Markdown: it is read in a terminal, in a table cell and in a log.
 */
export const renderTrace = (trace: EvaluationTrace): string => {
  const lines: string[] = [
    `${trace.kind} rule set ${JSON.stringify(trace.ruleSet)} (${trace.mode}) on ${trace.subjectId}`,
  ];
  for (const rule of trace.rules) {
    lines.push(`  [${rule.order}] ${rule.ruleId} (priority ${rule.priority}): ${rule.outcome}`);
    if (rule.condition !== undefined) renderCondition(rule.condition, 2, lines);
    for (const action of rule.actions) {
      lines.push(`${bullet(2)}${action.outcome === 'applied' ? '→' : '·'} ${action.type}: ${action.detail}`);
    }
    if (rule.error !== undefined) lines.push(`${bullet(2)}! ${rule.error}`);
  }
  if (trace.stoppedBy !== undefined) lines.push(`  stopped by ${trace.stoppedBy}`);
  for (const warning of trace.warnings) lines.push(`  warning: ${warning}`);
  return lines.join('\n');
};
