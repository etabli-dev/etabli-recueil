/**
 * The sources route.
 *
 * One search parameter, the selected source, so that "the mailbox that is failing" is a link that
 * can be pasted into an issue.
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { SourcesScreen } from '../sources/sources-screen.js';

export interface SourcesSearch {
  source?: string;
}

export const validateSourcesSearch = (raw: Record<string, unknown>): SourcesSearch =>
  typeof raw.source === 'string' && raw.source !== '' ? { source: raw.source } : {};

export const SourcesRoute = (): JSX.Element => {
  const search = useSearch({ strict: false }) as SourcesSearch;
  const navigate = useNavigate();

  const onSelect = useCallback(
    (id: string | null) => {
      void navigate({ to: '/sources', search: id === null ? {} : { source: id }, replace: true });
    },
    [navigate],
  );

  return <SourcesScreen selectedSourceId={search.source ?? null} onSelect={onSelect} />;
};
