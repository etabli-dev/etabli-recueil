/**
 * The rules route.
 *
 * The editor itself is loaded on demand: it imports `@recueil/rules`, which brings the rule schema,
 * the YAML parser and the linear-time regular-expression engine with it. That is the right price
 * for validating in the browser with the same parser the pipeline runs, and the wrong thing to make
 * every session pay on the library view.
 */
import { Suspense, lazy, useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { LoadingState } from '../components/states.js';

const RulesEditor = lazy(async () => {
  const module_ = await import('../rules/rules-editor.js');
  return { default: module_.RulesEditor };
});

export interface RulesSearch {
  /** Which rule is open in the form. */
  rule?: string;
}

export const validateRulesSearch = (raw: Record<string, unknown>): RulesSearch =>
  typeof raw.rule === 'string' && raw.rule !== '' ? { rule: raw.rule } : {};

export const RulesRoute = (): JSX.Element => {
  const search = useSearch({ strict: false }) as RulesSearch;
  const navigate = useNavigate();

  const onSelect = useCallback(
    (id: string | null) => {
      void navigate({ to: '/rules', search: id === null ? {} : { rule: id }, replace: true });
    },
    [navigate],
  );

  return (
    <Suspense fallback={<LoadingState label="Loading the rules editor…" />}>
      <RulesEditor selectedRuleId={search.rule ?? null} onSelect={onSelect} />
    </Suspense>
  );
};
