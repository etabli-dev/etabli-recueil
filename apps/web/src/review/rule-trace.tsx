/**
 * The rule trace, rendered.
 *
 * `@recueil/rules` says why the trace exists: "a reviewer looking at 'this scan became an invoice
 * filed under Office/2026 and tagged acme' needs to see which rule decided that and on what
 * evidence, otherwise the only available action is to distrust the whole rule set." This component
 * is the place that promise is kept or broken, so it renders three things the summary would drop:
 *
 *   - the rules that did **not** match, because "why was this rule skipped" is the more common
 *     question, and a list of only the winners cannot answer it;
 *   - the evidence — the matched span, the value that was read — rather than a restatement of the
 *     rule, so the trace stays true after the rule has been edited;
 *   - the warnings, including the ones nobody wants: a truncated text, a pattern that ran out of
 *     budget. A silent truncation is a wrong answer.
 *
 * Rules that did not match are collapsed by default and counted in the summary line, so the
 * common case is short without the uncommon case being hidden.
 */
import { useState } from 'react';
import type { ConditionTrace, EvaluationTrace, RuleTrace } from '../api/ingestion.js';

export interface RuleTraceViewProps {
  trace: EvaluationTrace | null | undefined;
  /** What to say when there is no trace. There are honest reasons for that, so it is a parameter. */
  absentLabel?: string;
}

export const RuleTraceView = ({
  trace,
  absentLabel = 'No rule trace was recorded for this entry.',
}: RuleTraceViewProps): JSX.Element => {
  const [showUnmatched, setShowUnmatched] = useState(false);

  if (trace === null || trace === undefined) {
    return (
      <p className="section__note" data-testid="trace-absent">
        {absentLabel} That is not the same as “no rule matched”: it means the entry was raised by
        something other than the rule engine, or before it ran.
      </p>
    );
  }

  const matched = trace.rules.filter((rule) => rule.outcome === 'matched');
  const others = trace.rules.filter((rule) => rule.outcome !== 'matched');

  return (
    <div className="trace" data-testid="rule-trace">
      <p className="trace__summary">
        <span className="badge">{trace.kind}</span> rule set <code>{trace.ruleSet}</code> in{' '}
        <code>{trace.mode}</code> mode over <code>{trace.subjectId}</code> — {matched.length} of{' '}
        {trace.rules.length} rules matched
        {trace.stoppedBy === undefined ? '' : `, stopped by ${trace.stoppedBy}`}.
      </p>

      {matched.length === 0 ? (
        <p className="section__note" data-testid="trace-no-match">
          No rule matched. Whatever this entry proposes came from the extraction stages, not from the
          rule set.
        </p>
      ) : (
        <ol className="trace__rules">
          {matched.map((rule) => (
            <RuleTraceRow key={rule.ruleId} rule={rule} />
          ))}
        </ol>
      )}

      {others.length === 0 ? null : (
        <>
          <button
            type="button"
            className="button button--small"
            aria-expanded={showUnmatched}
            onClick={() => setShowUnmatched((value) => !value)}
          >
            {showUnmatched ? 'Hide' : 'Show'} the {others.length} rule{others.length === 1 ? '' : 's'} that
            did not fire
          </button>
          {showUnmatched ? (
            <ol className="trace__rules trace__rules--quiet" data-testid="trace-unmatched">
              {others.map((rule) => (
                <RuleTraceRow key={rule.ruleId} rule={rule} />
              ))}
            </ol>
          ) : null}
        </>
      )}

      {trace.warnings.length === 0 ? null : (
        <ul className="trace__warnings" data-testid="trace-warnings">
          {trace.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const OUTCOME_LABEL: Readonly<Record<RuleTrace['outcome'], string>> = {
  matched: 'matched',
  'not-matched': 'did not match',
  disabled: 'disabled',
  'not-reached': 'not reached',
  error: 'could not be evaluated',
};

const RuleTraceRow = ({ rule }: { rule: RuleTrace }): JSX.Element => (
  <li className="trace__rule" data-rule={rule.ruleId} data-outcome={rule.outcome}>
    <p className="trace__rule-head">
      <code className="trace__rule-id">{rule.ruleId}</code>
      <span className="trace__rule-outcome">{OUTCOME_LABEL[rule.outcome]}</span>
      <span className="trace__rule-priority">priority {rule.priority}</span>
    </p>
    {rule.description === undefined ? null : <p className="trace__rule-description">{rule.description}</p>}
    {rule.condition === undefined ? null : <ConditionTree condition={rule.condition} />}
    {rule.actions.length === 0 ? null : (
      <ul className="trace__actions">
        {rule.actions.map((action, index) => (
          <li key={`${action.type}-${String(index)}`} data-outcome={action.outcome}>
            <span aria-hidden="true">{action.outcome === 'applied' ? '→' : '·'}</span>{' '}
            <code>{action.type}</code> {action.detail}
          </li>
        ))}
      </ul>
    )}
    {rule.captures === undefined || Object.keys(rule.captures).length === 0 ? null : (
      <dl className="trace__captures">
        {Object.entries(rule.captures).map(([name, value]) => (
          <div key={name}>
            <dt>
              <code>${'{'}
              {name}
              {'}'}</code>
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    )}
    {rule.error === undefined ? null : <p className="trace__error">{rule.error}</p>}
  </li>
);

const ConditionTree = ({ condition }: { condition: ConditionTrace }): JSX.Element => (
  <ul className="trace__conditions">
    <ConditionNode condition={condition} />
  </ul>
);

const ConditionNode = ({ condition }: { condition: ConditionTrace }): JSX.Element => (
  <li data-condition={condition.type} data-matched={condition.matched ? 'true' : 'false'}>
    <span className="trace__mark" aria-hidden="true">
      {condition.error !== undefined ? '!' : condition.matched ? '✓' : '✗'}
    </span>
    <span className="trace__condition-type">{condition.type}</span>
    <span className="trace__condition-detail">{condition.detail}</span>
    {condition.evidence === undefined ? null : (
      <q className="trace__evidence">{condition.evidence}</q>
    )}
    {condition.error === undefined ? null : <span className="trace__error">{condition.error}</span>}
    {condition.children === undefined || condition.children.length === 0 ? null : (
      <ul className="trace__conditions">
        {condition.children.map((child, index) => (
          <ConditionNode key={`${child.type}-${String(index)}`} condition={child} />
        ))}
      </ul>
    )}
  </li>
);
