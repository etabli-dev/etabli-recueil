/**
 * The dry-run report: what the rules would do, and to what.
 *
 * §5.6 asks for "a dry-run report before execution". What makes it worth reading is not the list of
 * things that would change — it is the two lists nobody asks for:
 *
 *   - **the rules that never fire.** A rule set grows by accretion, and a rule whose condition
 *     stopped matching when a scanner's filing convention changed still sits there looking
 *     authoritative. `rules` counts every rule against every subject whatever the outcome, so a
 *     zero is a real zero.
 *   - **the subjects nothing matched.** In an ingestion run those are exactly the documents a human
 *     will still be filing by hand, which is the number M2 is judged on.
 *
 * It is a prediction and is labelled as one — but a well-founded one: the engine behind it is a
 * pure function of a rule set and a subject, handed no database and no storage, so there is no
 * apply path the endpoint has to remember to switch off. And the rules it runs are the rows the
 * pipeline runs, through the same `StoredRuleEvaluator`, so it is not a parallel implementation
 * that happens to agree today.
 */
import { useState } from 'react';
import type { IngestionOutcome } from '@recueil/rules';

import type { RuleDryRunEntry, RuleDryRunResponse } from '../api/ingestion.js';
import { RuleTraceView } from '../review/rule-trace.js';

export interface DryRunReportViewProps {
  report: RuleDryRunResponse;
  /** A label per subject id — a filename, a reason code — so a row is not only a hash. */
  labels?: Readonly<Record<string, string>>;
}

export const DryRunReportView = ({ report, labels = {} }: DryRunReportViewProps): JSX.Element => {
  const changed = report.entries.filter((entry) => changesOf(entry).length > 0);

  return (
    <div className="dry-run" data-testid="dry-run-report">
      <p className="dry-run__summary">
        Over {report.subjectCount} subject{report.subjectCount === 1 ? '' : 's'}: {changed.length}{' '}
        would change, {report.unmatchedSubjectIds.length} matched no rule,{' '}
        {report.erroredSubjectIds.length} could not be evaluated. Nothing was written.
      </p>

      <section aria-label="Entries that would change">
        <h3 className="section__title">Would change</h3>
        {changed.length === 0 ? (
          <p className="section__note" data-testid="dry-run-no-changes">
            Nothing would change. Either these subjects already carry what the rules would set, or
            no rule matches them.
          </p>
        ) : (
          <ul className="dry-run__entries" data-testid="dry-run-changes">
            {changed.map((entry) => (
              <ChangedEntry key={entry.subjectId} entry={entry} label={labels[entry.subjectId]} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Per-rule statistics">
        <h3 className="section__title">Rules</h3>
        <div className="dry-run__table-scroll">
          <table className="dry-run__rules">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Priority</th>
                <th scope="col">Matched</th>
                <th scope="col">Did not</th>
                <th scope="col">Not reached</th>
                <th scope="col">Disabled</th>
                <th scope="col">Errors</th>
              </tr>
            </thead>
            <tbody>
              {report.rules.map((rule) => (
                <tr key={rule.ruleId} data-rule={rule.ruleId} data-dead={rule.matched === 0 ? 'true' : 'false'}>
                  <th scope="row">
                    <code>{rule.ruleId}</code>
                    {rule.matched === 0 ? <span className="badge badge--warn">never fires</span> : null}
                  </th>
                  <td>{rule.priority}</td>
                  <td>{rule.matched}</td>
                  <td>{rule.notMatched}</td>
                  <td>{rule.notReached}</td>
                  <td>{rule.disabled}</td>
                  <td>{rule.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {report.unmatchedSubjectIds.length === 0 ? null : (
        <section aria-label="Subjects no rule matched">
          <h3 className="section__title">No rule matched</h3>
          <p className="field__hint">
            These are the documents a person still has to file by hand. Shrinking this list is what a
            rule change is for.
          </p>
          <ul className="dry-run__unmatched" data-testid="dry-run-unmatched">
            {report.unmatchedSubjectIds.map((subjectId) => (
              <li key={subjectId}>
                <code>{labels[subjectId] ?? subjectId}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.warnings.length === 0 ? null : (
        <section aria-label="Warnings">
          <h3 className="section__title">Warnings</h3>
          <ul className="trace__warnings" data-testid="dry-run-warnings">
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/** One thing the outcome says would be different, with the rule that would do it. */
export interface DryRunChange {
  kind: string;
  ruleId: string;
  value: string;
  detail?: string;
}

/**
 * Read the engine's outcome.
 *
 * `outcome` is `z.unknown()` on the wire, so it is narrowed here rather than asserted: a report that
 * assumed a field and found none would render an empty row and call it "no change". Every value
 * carries the rule that set it, because `IngestionOutcome` attributes all of them — which is what
 * `item_tags.rule_ref` and the office facet's field provenance are populated from.
 */
export const changesOf = (entry: RuleDryRunEntry): DryRunChange[] => {
  const outcome = entry.outcome as Partial<IngestionOutcome> | null | undefined;
  if (outcome === null || outcome === undefined || typeof outcome !== 'object') return [];

  const changes: DryRunChange[] = [];
  if (outcome.itemType !== undefined) {
    changes.push({ kind: 'item type', ruleId: outcome.itemType.ruleId, value: outcome.itemType.value });
  }
  if (outcome.correspondent !== undefined) {
    changes.push({ kind: 'correspondent', ruleId: outcome.correspondent.ruleId, value: outcome.correspondent.value });
  }
  if (outcome.confidence !== undefined) {
    changes.push({
      kind: 'confidence',
      ruleId: outcome.confidence.ruleId,
      value: outcome.confidence.value.toFixed(2),
    });
  }
  for (const collection of outcome.collections ?? []) {
    changes.push({
      kind: 'collection',
      ruleId: collection.ruleId,
      value: collection.value,
      detail: collection.create ? 'creating it if it does not exist' : 'only if it already exists',
    });
  }
  for (const tag of outcome.tags ?? []) {
    changes.push({ kind: 'tag', ruleId: tag.ruleId, value: tag.value });
  }
  for (const field of outcome.customFields ?? []) {
    changes.push({ kind: `custom field ${field.field}`, ruleId: field.ruleId, value: String(field.value) });
  }
  for (const review of outcome.review ?? []) {
    changes.push({
      kind: 'to review',
      ruleId: review.ruleId,
      value: review.reasonCode,
      detail: review.explanation,
    });
  }
  for (const conflict of outcome.conflicts ?? []) {
    changes.push({
      kind: `conflict on ${conflict.field}`,
      ruleId: conflict.next.ruleId,
      value: conflict.next.value,
      detail: `overwrites ${conflict.previous.value} from ${conflict.previous.ruleId}`,
    });
  }
  return changes;
};

const ChangedEntry = ({ entry, label }: { entry: RuleDryRunEntry; label?: string }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const changes = changesOf(entry);
  return (
    <li className="dry-run__entry" data-subject={entry.subjectId}>
      <p className="dry-run__entry-head">
        <span className="dry-run__entry-label">{label ?? entry.subjectId}</span>
        {label === undefined ? null : <code className="dry-run__entry-id">{entry.subjectId}</code>}
      </p>
      <ul className="dry-run__changes">
        {changes.map((change, index) => (
          <li key={`${change.kind}-${String(index)}`} data-change={change.kind}>
            <code>{change.kind}</code> <span className="dry-run__after">{change.value}</span>
            <span className="dry-run__by">by {change.ruleId}</span>
            {change.detail === undefined ? null : <span className="dry-run__detail">{change.detail}</span>}
          </li>
        ))}
      </ul>
      {entry.trace === undefined ? null : (
        <>
          <button
            type="button"
            className="button button--small"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Hide' : 'Show'} the trace
          </button>
          {open ? <RuleTraceView trace={entry.trace} /> : null}
        </>
      )}
    </li>
  );
};
