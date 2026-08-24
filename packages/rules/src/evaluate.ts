/**
 * The two calls a pipeline actually makes.
 *
 * `evaluateRules` is generic because the engine is; these two bind it to a facet so that a caller
 * in `apps/server` writes one line and gets a typed outcome. Both are pure: they take a value and
 * return a value, and the ingestion pipeline is what turns the outcome into writes inside its
 * single transaction (CONCEPT.md §5.3 stage 10).
 */
import { dedupFacet } from './dedup/facet.js';
import type { DedupOutcome } from './dedup/outcome.js';
import type { DedupPair } from './dedup/subject.js';
import { evaluateRules } from './engine.js';
import type { Evaluation, EvaluateOptions, RuleSetLike } from './engine.js';
import { ingestionFacet } from './ingestion/facet.js';
import type { IngestionOutcome } from './ingestion/outcome.js';
import type { IngestionSubject } from './ingestion/subject.js';
import type { DedupAction, DedupCondition } from './schema/dedup.js';
import type { IngestionAction, IngestionCondition } from './schema/ingestion.js';

/** Run an ingestion rule set over one subject — CONCEPT.md §5.3 stage 8. */
export const evaluateIngestion = (
  ruleSet: RuleSetLike<IngestionCondition, IngestionAction>,
  subject: IngestionSubject,
  options: EvaluateOptions = {},
): Evaluation<IngestionOutcome> => evaluateRules(ruleSet, subject, ingestionFacet, { subjectId: subject.id, ...options });

/** Run a dedup rule set over one candidate pair — CONCEPT.md §5.6. */
export const evaluateDedup = (
  ruleSet: RuleSetLike<DedupCondition, DedupAction>,
  pair: DedupPair,
  options: EvaluateOptions = {},
): Evaluation<DedupOutcome> => evaluateRules(ruleSet, pair, dedupFacet, { subjectId: pair.id, ...options });
