/**
 * Running the rules over something, and changing nothing.
 *
 * Two corpora, because there are only two honest ones. **The review queue** is the set a rule change
 * is meant to shrink — the documents a person is about to file by hand — and each of its entries
 * names a document whose path, filename and media type are the subject the pipeline matched on.
 * **A subject typed by hand** is the other: "would a scan at this path, with this name, be filed?"
 * is the question asked while writing a rule, and answering it should not require producing a file.
 *
 * The subjects for the queue corpus are assembled from the documents themselves — one
 * `GET /documents/{id}` per entry — rather than from anything the review entry claims about them.
 * That is deliberate and it is the same rule the sources screen follows: the two sides of a
 * comparison have to be queried, or the report is the client agreeing with itself.
 */
import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { IngestionRuleSet } from '@recueil/rules';

import { useApiClient } from '../api/context.js';
import type { ApiError } from '../api/problem.js';
import type { RuleDryRunRequest, RuleDryRunResponse, RuleDryRunSubject } from '../api/ingestion.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Pane } from '../components/panel.js';
import { DryRunReportView } from './dry-run-report.js';
import { toCreate } from './rule-set-text.js';

export interface DryRunPanelProps {
  /**
   * The unsaved document, when the text view holds a valid one.
   *
   * Passed to the endpoint as `rules`, which replaces the stored set for that call — the whole
   * point of a dry run is to answer "what would this do" before it is saved. Null runs the stored,
   * enabled rules instead, and the panel says which it did.
   */
  draft: IngestionRuleSet | null;
  dryRun: UseMutationResult<RuleDryRunResponse, ApiError, RuleDryRunRequest>;
}

/** How many review entries one dry run pulls. Enough to be representative, small enough to be quick. */
const QUEUE_SAMPLE = 25;

export const DryRunPanel = ({ draft, dryRun }: DryRunPanelProps): JSX.Element => {
  const client = useApiClient();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [gathering, setGathering] = useState(false);
  const [gatherError, setGatherError] = useState<unknown>(null);
  const [probe, setProbe] = useState({ source: 'folder', path: '', filename: '', mime: 'application/pdf', text: '' });

  const run = (subjects: RuleDryRunSubject[], nextLabels: Record<string, string>): void => {
    setLabels(nextLabels);
    dryRun.mutate({
      subjects,
      maxTraces: 25,
      ...(draft === null ? {} : { rules: draft.rules.map(toCreate) }),
    });
  };

  /**
   * The open review queue, as subjects.
   *
   * Each entry's document is fetched, because the subject the rules matched is the document's own
   * path, name and media type — not anything the entry says about itself.
   */
  const runOverQueue = async (): Promise<void> => {
    setGathering(true);
    setGatherError(null);
    try {
      const page = await client.listReviewEntries({ status: 'open', limit: QUEUE_SAMPLE });
      const documents = page.data.filter((entry) => entry.subjectType === 'document');
      const subjects: RuleDryRunSubject[] = [];
      const nextLabels: Record<string, string> = {};

      for (const entry of documents) {
        const row = await client.getDocument(entry.subjectId);
        const filename = row.originalFilename ?? null;
        subjects.push({
          id: entry.subjectId,
          source: row.sourceKind,
          ...(row.sourceRef === null || row.sourceRef === undefined ? {} : { path: row.sourceRef }),
          ...(filename === null ? {} : { filename }),
          mime: row.mimeType,
        });
        nextLabels[entry.subjectId] = filename ?? `${entry.reasonCode} · ${row.sha256.slice(0, 12)}`;
      }

      if (subjects.length === 0) {
        setGatherError(
          new Error(
            'The open queue holds no document entries, so there is nothing to evaluate. Try a subject by hand below.',
          ),
        );
        return;
      }
      run(subjects, nextLabels);
    } catch (error) {
      setGatherError(error);
    } finally {
      setGathering(false);
    }
  };

  const runProbe = (): void => {
    const subject: RuleDryRunSubject = {
      id: 'probe',
      ...(probe.source === '' ? {} : { source: probe.source }),
      ...(probe.path === '' ? {} : { path: probe.path }),
      ...(probe.filename === '' ? {} : { filename: probe.filename }),
      ...(probe.mime === '' ? {} : { mime: probe.mime }),
      ...(probe.text === '' ? {} : { text: probe.text }),
    };
    run([subject], { probe: probe.filename === '' ? probe.path === '' ? 'the subject you typed' : probe.path : probe.filename });
  };

  return (
    <Pane id="rules-dry-run" title="Dry run">
      <p className="section__note">
        {draft === null
          ? 'Runs the stored, enabled rules. Switch to the YAML view to try an unsaved edit.'
          : 'Runs the document in the editor, saved or not. It writes nothing: the evaluator is handed no database.'}
      </p>

      <div className="dry-run__controls">
        <button
          type="button"
          className="button button--primary"
          onClick={() => void runOverQueue()}
          disabled={gathering || dryRun.isPending}
        >
          {gathering ? 'Gathering the queue…' : 'Run over the review queue'}
        </button>
      </div>

      <fieldset className="field-group">
        <legend>Or try one subject</legend>
        {(
          [
            ['source', 'Source kind', 'folder, scanner, imap, webdav'],
            ['path', 'Path', 'scans/Acme GmbH/2026-07-02.pdf'],
            ['filename', 'Filename', 'invoice-114.pdf'],
            ['mime', 'MIME type', 'application/pdf'],
            ['text', 'Extracted text', 'What the OCR would have read'],
          ] as const
        ).map(([key, label, placeholder]) => (
          <div className="field" key={key}>
            <label className="field__label" htmlFor={`probe-${key}`}>
              {label}
            </label>
            <div className="field__control">
              <input
                id={`probe-${key}`}
                className="field__input"
                type="text"
                value={probe[key]}
                placeholder={placeholder}
                onChange={(event) => setProbe((current) => ({ ...current, [key]: event.target.value }))}
              />
            </div>
          </div>
        ))}
        <button type="button" className="button" onClick={runProbe} disabled={dryRun.isPending}>
          Run over this subject
        </button>
      </fieldset>

      {gatherError === null ? null : <ErrorState label="Could not gather the corpus" error={gatherError} />}
      {dryRun.isError ? <ErrorState label="The dry run failed" error={dryRun.error} /> : null}
      {dryRun.isPending ? <LoadingState label="Evaluating…" /> : null}

      {dryRun.data === undefined ? (
        <EmptyState
          title="No dry run yet"
          description="Evaluate the rules over the review queue, or over a subject you type. Either way nothing is written."
        />
      ) : (
        <DryRunReportView report={dryRun.data} labels={labels} />
      )}
    </Pane>
  );
};
