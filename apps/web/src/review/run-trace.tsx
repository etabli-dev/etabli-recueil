/**
 * Why this entry exists: what the run that raised it recorded.
 *
 * The honest scope of this component is worth stating, because the obvious thing to build is not
 * available. `@recueil/rules` produces a full `EvaluationTrace` — every rule, matched or not, with
 * the evidence — but the pipeline keeps only the matched rule ids and the conflicts from it
 * (`StoredRuleEvaluator` in `apps/server/src/ingestion/rules-store.ts` returns a `RuleEvaluation`,
 * and the pipeline journals `{ matched, conflicts }` at stage 8). **Nothing stores the whole trace
 * against a review entry.** So this renders what *is* recorded, and says which is which:
 *
 *   - the stage checkpoints for the entry's own candidate, from `ingest_checkpoints` — the same
 *     rows a resumed run reads, so the trace and the resume point cannot disagree;
 *   - the run's log lines for that subject;
 *   - the rules stage's matched ids and conflicts, called out because they are the answer to "which
 *     rule decided this".
 *
 * The full trace, with the rules that did *not* fire and the evidence behind each condition, is
 * available for a rule set through the dry run in the rules editor, which is where `RuleTraceView`
 * renders it. The link to it is here rather than a silent absence, because "why did nothing tag
 * this?" is a question this pane should not leave hanging.
 */
import type { IngestionJobDetail, ReviewEntry, StageTraceEntry } from '../api/ingestion.js';
import { ErrorState, LoadingState } from '../components/states.js';

export interface RunTraceProps {
  entry: ReviewEntry;
  detail: IngestionJobDetail | undefined;
  pending: boolean;
  error: unknown;
  onRetry?: (() => void) | undefined;
}

/** What the stage-8 checkpoint holds. Narrowed rather than asserted: an old run may hold neither. */
interface RulesCheckpoint {
  matched?: string[];
  conflicts?: { path?: string; ruleId?: string; previousRuleId?: string; detail?: string }[];
}

export const RunTrace = ({ entry, detail, pending, error, onRetry }: RunTraceProps): JSX.Element => {
  if (entry.jobId === null) {
    return (
      <p className="section__note" data-testid="trace-no-job">
        This entry names no run. It was raised outside the ingestion pipeline — by a check, an import
        or by hand — so there is no stage trace to read. The stored explanation above is the record.
      </p>
    );
  }
  if (pending) return <LoadingState label="Reading what the run recorded…" />;
  if (error !== null && error !== undefined) {
    return <ErrorState label="Could not read the run" error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }
  if (detail === undefined) return <LoadingState label="Reading what the run recorded…" />;

  // The checkpoints are keyed by candidate, and one run carries many. The entry's own candidate is
  // the one whose stages name its subject — matched on the sha256 the document rows share.
  const candidateKey = candidateKeyFor(entry, detail);
  const stages =
    candidateKey === undefined
      ? detail.stages
      : detail.stages.filter((stage) => stage.candidateKey === candidateKey);
  const log = detail.log.filter(
    (line) => line.subjectId === null || line.subjectId === entry.subjectId || line.subjectId === entry.id,
  );
  const rules = rulesCheckpoint(stages);

  return (
    <div className="run-trace" data-testid="run-trace">
      <p className="run-trace__summary">
        Run <code>{detail.job.id}</code> — <span className="badge">{detail.job.state}</span>, attempt{' '}
        {detail.job.attempts} of {detail.job.maxAttempts}, {detail.job.progress.done} of{' '}
        {detail.job.progress.total ?? '?'} candidates.
      </p>

      <section aria-label="Rules">
        <h4 className="section__title">Rules</h4>
        {rules === null ? (
          <p className="section__note" data-testid="trace-no-rules">
            The run recorded no rules stage for this document, which means the pipeline stopped
            before stage 8 — the reason code above says where.
          </p>
        ) : (
          <>
            {(rules.matched ?? []).length === 0 ? (
              <p className="section__note" data-testid="trace-no-match">
                No rule matched. Whatever this entry proposes came from the extraction stages, not
                from the rule set. To see which rules were considered and why each declined, run the
                rule set over this document as a dry run in the rules editor: the pipeline stores the
                ids of the rules that fired, not the whole evaluation.
              </p>
            ) : (
              <ul className="run-trace__matched" data-testid="trace-matched">
                {(rules.matched ?? []).map((ruleId) => (
                  <li key={ruleId}>
                    <code>{ruleId}</code> matched
                  </li>
                ))}
              </ul>
            )}
            {(rules.conflicts ?? []).length === 0 ? null : (
              <ul className="run-trace__conflicts" data-testid="trace-conflicts">
                {(rules.conflicts ?? []).map((conflict, index) => (
                  <li key={`${conflict.path ?? ''}-${String(index)}`}>
                    <code>{conflict.path ?? 'a field'}</code> was set by{' '}
                    <code>{conflict.ruleId ?? 'a rule'}</code> over{' '}
                    <code>{conflict.previousRuleId ?? 'an earlier rule'}</code>
                    {conflict.detail === undefined ? '' : ` — ${conflict.detail}`}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-label="Stages">
        <h4 className="section__title">Stages</h4>
        {stages.length === 0 ? (
          <p className="section__note">The run recorded no checkpoints for this document.</p>
        ) : (
          <ol className="run-trace__stages" data-testid="trace-stages">
            {stages.map((stage) => (
              <li key={`${stage.stage}-${stage.createdAt}`} data-stage={stage.stage}>
                <code className="run-trace__stage">{stage.stage}</code>
                <span className="run-trace__at">{stage.createdAt}</span>
                <details>
                  <summary>what it produced</summary>
                  <pre>{JSON.stringify(stage.payload, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      {log.length === 0 ? null : (
        <section aria-label="Run log">
          <h4 className="section__title">Log</h4>
          <ul className="run-trace__log" data-testid="trace-log">
            {log.map((line) => (
              <li key={line.id} data-level={line.level}>
                <span className="run-trace__at">{line.loggedAt}</span>
                <span className="run-trace__level">{line.level}</span>
                <span>{line.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/**
 * Which candidate of the run this entry is about.
 *
 * A document-subject entry names the document, and the checkpoints carry the sha256 of the bytes.
 * The document id is not in the checkpoint, so the match is made through the stage that recorded a
 * digest for this subject; when nothing matches, every stage of the run is shown rather than none,
 * because an over-broad trace is more useful than an empty one and the candidate key is printed on
 * each row.
 */
const candidateKeyFor = (entry: ReviewEntry, detail: IngestionJobDetail): string | undefined => {
  const keys = new Set(detail.stages.map((stage) => stage.candidateKey));
  if (keys.size === 1) return [...keys][0];
  const naming = detail.log.find(
    (line) => line.subjectId === entry.subjectId && typeof line.data?.candidateKey === 'string',
  );
  return typeof naming?.data?.candidateKey === 'string' ? naming.data.candidateKey : undefined;
};

const rulesCheckpoint = (stages: readonly StageTraceEntry[]): RulesCheckpoint | null => {
  const stage = stages.find((candidate) => candidate.stage === 'rules');
  if (stage === undefined) return null;
  const payload = stage.payload;
  return typeof payload === 'object' && payload !== null ? (payload as RulesCheckpoint) : {};
};
