/** The ingestion facet of the rule engine — CONCEPT.md §5.3 stage 8. */
export { ingestionFacet } from './facet.js';
export { IngestionDraft } from './outcome.js';
export type {
  Attributed,
  AttributedField,
  CollectionAssignment,
  IngestionOutcome,
  OutcomeConflict,
  ReviewRequest,
} from './outcome.js';
export type { IngestionSubject, ResolverOutcome } from './subject.js';
