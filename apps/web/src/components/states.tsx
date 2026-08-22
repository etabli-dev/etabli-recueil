/**
 * Loading, empty and error states.
 *
 * These are the three states a request is in most of the time, and they are the three most
 * commonly faked. A spinner that never resolves, an empty list that looks like a loading list, and
 * an error that says "something went wrong" are all ways of not telling the user what happened.
 *
 * So: the loading state announces itself to assistive technology, the empty state says what is
 * empty and what to do about it, and the error state prints the problem document — title, detail,
 * the stable `type` URI, the field-level errors and the trace id that finds the server log line
 * (docs/api.qmd, "Conventions").
 */
import type { ReactNode } from 'react';

import { isApiError } from '../api/problem.js';
import type { ProblemDetails } from '../api/problem.js';

export interface LoadingStateProps {
  /** What is loading, in the user's terms: "Loading the library…". */
  label: string;
}

export const LoadingState = ({ label }: LoadingStateProps): JSX.Element => (
  <div className="state state--loading" role="status" aria-live="polite">
    <span className="state__spinner" aria-hidden="true" />
    <p className="state__title">{label}</p>
  </div>
);

export interface EmptyStateProps {
  title: string;
  /** Why it is empty and what would change that. Never omitted: an unexplained void is a bug report. */
  description: string;
  action?: ReactNode;
}

export const EmptyState = ({ title, description, action }: EmptyStateProps): JSX.Element => (
  <div className="state state--empty">
    <p className="state__title">{title}</p>
    <p className="state__description">{description}</p>
    {action === undefined ? null : <div className="state__action">{action}</div>}
  </div>
);

export interface ErrorStateProps {
  /** What the client was doing, so the problem has a subject: "Could not load the library". */
  label: string;
  error: unknown;
  onRetry?: () => void;
}

/**
 * The failure of one request, rendered from its problem document.
 *
 * Anything that is not an `ApiError` is still rendered rather than swallowed — a bug in a component
 * is a thing the user should be told about too, and a blank pane is the worst possible report.
 */
export const ErrorState = ({ label, error, onRetry }: ErrorStateProps): JSX.Element => {
  const problem = toProblem(error);
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{label}</p>
      <p className="state__problem-title">{problem.title}</p>
      {problem.detail === undefined ? null : (
        <p className="state__description" data-testid="problem-detail">
          {problem.detail}
        </p>
      )}
      {problem.errors === undefined ? null : (
        <ul className="state__field-errors">
          {problem.errors.map((fieldError) => (
            <li key={`${fieldError.path}:${fieldError.message}`}>
              <code>{fieldError.path}</code> {fieldError.message}
            </li>
          ))}
        </ul>
      )}
      <dl className="state__meta">
        <dt>Type</dt>
        <dd>
          <code data-testid="problem-type">{problem.type}</code>
        </dd>
        <dt>Status</dt>
        <dd>{problem.status === 0 ? 'no response' : problem.status}</dd>
        {problem.traceId === undefined ? null : (
          <>
            <dt>Trace</dt>
            <dd>
              <code data-testid="problem-trace">{problem.traceId}</code>
            </dd>
          </>
        )}
      </dl>
      {onRetry === undefined ? null : (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
};

/** Every failure becomes a problem document, so the error state has exactly one shape to render. */
export const toProblem = (error: unknown): ProblemDetails => {
  if (isApiError(error)) return error.problem;
  if (error instanceof Error) {
    return {
      type: 'https://recueil.org/problems/client',
      title: 'The interface failed',
      status: 0,
      detail: error.message,
    };
  }
  return {
    type: 'https://recueil.org/problems/client',
    title: 'The interface failed',
    status: 0,
    detail: String(error),
  };
};
