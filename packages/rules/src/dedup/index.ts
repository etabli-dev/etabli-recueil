/** The deduplication facet of the rule engine — CONCEPT.md §5.6. */
export { dedupFacet } from './facet.js';
export { DedupDraft } from './outcome.js';
export type { DedupDecision, DedupOutcome } from './outcome.js';
export { nameOverlap, normaliseForComparison, similarity } from './similarity.js';
export type { DedupField, DedupPair, DedupSide } from './subject.js';
