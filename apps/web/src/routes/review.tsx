/**
 * The review-queue route.
 *
 * The filter and the selected entry live in the URL for the reason they do on the library route: a
 * queue filtered to `severity=blocker` is a link, the back button behaves, and reloading after a
 * decision returns to the same place rather than to the top of the list.
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { ReviewWorkspace } from '../review/review-workspace.js';
import type { ReviewWorkspaceState } from '../review/review-workspace.js';
import type { ReviewSeverity, ReviewStatus } from '../api/ingestion.js';

export interface ReviewSearch {
  status: ReviewStatus;
  severity?: ReviewSeverity;
  reason?: string;
  entry?: string;
}

const STATUSES: readonly string[] = ['open', 'accepted', 'rejected', 'deferred', 'superseded'];
const SEVERITIES: readonly string[] = ['info', 'warning', 'blocker'];

/** Search parameters are user input: an unknown value falls back rather than throwing. */
export const validateReviewSearch = (raw: Record<string, unknown>): ReviewSearch => {
  const search: ReviewSearch = {
    status: typeof raw.status === 'string' && STATUSES.includes(raw.status) ? (raw.status as ReviewStatus) : 'open',
  };
  if (typeof raw.severity === 'string' && SEVERITIES.includes(raw.severity)) {
    search.severity = raw.severity as ReviewSeverity;
  }
  if (typeof raw.reason === 'string' && raw.reason !== '') search.reason = raw.reason;
  if (typeof raw.entry === 'string' && raw.entry !== '') search.entry = raw.entry;
  return search;
};

export const ReviewRoute = (): JSX.Element => {
  const search = useSearch({ strict: false }) as ReviewSearch;
  const navigate = useNavigate();

  const state: ReviewWorkspaceState = {
    status: search.status ?? 'open',
    severity: search.severity,
    reasonCode: search.reason,
    selectedEntryId: search.entry ?? null,
  };

  const onStateChange = useCallback(
    (change: Partial<ReviewWorkspaceState>) => {
      void navigate({
        to: '/review',
        search: (previous: Record<string, unknown>): ReviewSearch => {
          const current = validateReviewSearch(previous);
          const next: ReviewSearch = { status: change.status ?? current.status };

          const severity = 'severity' in change ? change.severity : current.severity;
          if (severity !== undefined) next.severity = severity;

          const reason = 'reasonCode' in change ? change.reasonCode : current.reason;
          if (reason !== undefined && reason !== '') next.reason = reason;

          const entry = 'selectedEntryId' in change ? change.selectedEntryId : current.entry;
          if (entry !== undefined && entry !== null) next.entry = entry;

          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  return <ReviewWorkspace state={state} onStateChange={onStateChange} />;
};
