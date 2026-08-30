/**
 * `@recueil/rules` — the ingestion and deduplication rule engine.
 *
 * CONCEPT.md §5.3 stage 8 asks for a rule engine that matches on source, sender, path, text and
 * resolver result and sets item type, collection, tags and custom fields. §5.6 asks for dedup rules
 * "editable as YAML/JSON in the UI" with "a dry-run report before execution". They are one thing:
 * a declarative, versioned rule format with a deterministic evaluator, an explicable trace and a
 * dry run, pointed at two different subjects.
 *
 * The four properties worth knowing before using it:
 *
 * - **Declarative and versioned.** A rule set is a YAML or JSON document with a `version` and a
 *   `kind`, validated by a Zod schema and by the JSON Schema generated from it, which the UI and
 *   the API both hold. `spec/data-model.md` O2 leaves the table-or-file question open; this format
 *   is designed to be either, and to round-trip between them.
 * - **Deterministic.** Rules run in priority order, ties broken by the order they are written. The
 *   evaluator reads no clock, no random source and no filesystem, so the same set over the same
 *   subject gives the same answer and the same trace every time.
 * - **Explicable.** Every evaluation returns a trace of which rules fired, which did not, on what
 *   evidence, and what each action did or declined to do. That trace is what makes a review-queue
 *   entry (`spec/data-model.md` §6.1) something a human can act on.
 * - **Safe on hostile input.** No pattern in a rule set is run through a backtracking engine. The
 *   regular expressions and the globs are compiled to a Pike VM whose cost is bounded by input
 *   length times program size, with a step budget and a wall-clock allowance on top. The pattern is
 *   hostile too — it is typed into an editor and POSTed — so it is bounded at compile time by
 *   length, nesting depth, repetition count, program size and compilation work, each with a named
 *   refusal. `safeMatch` is the bounded matcher other packages should use in place of `RegExp`.
 *
 * The engine decides; it never writes. Applying an outcome is the ingestion pipeline's job, inside
 * the single transaction of stage 10, and that separation is what makes the dry run a prediction
 * rather than a promise.
 */

/* The rule format ------------------------------------------------------------------------------ */
export { RULE_FORMAT_VERSION, SUPPORTED_RULE_FORMAT_VERSIONS } from './version.js';
export { RuleSetSchema } from './schema/index.js';
export type { RuleSet } from './schema/index.js';
export {
  RULE_KINDS,
  RULE_MODES,
  RuleIdSchema,
  RuleKindSchema,
  RuleLimitsSchema,
  RuleModeSchema,
  ruleSchema,
} from './schema/common.js';
export type { RuleKind, RuleLimits, RuleMode } from './schema/common.js';
export { MatcherSchema } from './schema/matchers.js';
export type { GlobMatcher, Matcher, RegexMatcher } from './schema/matchers.js';
export {
  IngestionActionSchema,
  IngestionConditionSchema,
  IngestionRuleSchema,
  IngestionRuleSetSchema,
  RESOLVER_OUTCOMES,
  REVIEW_PROPOSED_ACTIONS,
  REVIEW_SEVERITIES,
  ResolverOutcomeKindSchema,
  ReviewProposedActionSchema,
  ReviewSeveritySchema,
} from './schema/ingestion.js';
export type {
  IngestionAction,
  IngestionCondition,
  IngestionLeafCondition,
  IngestionRule,
  IngestionRuleSet,
  ResolverOutcomeKind,
  RuleFieldValue,
} from './schema/ingestion.js';
export {
  DEDUP_FIELDS,
  DEDUP_SIDES,
  DedupActionSchema,
  DedupConditionSchema,
  DedupFieldSchema,
  DedupRuleSchema,
  DedupRuleSetSchema,
  DedupSideSchema,
  MERGE_WINNERS,
  MergeWinnerSchema,
} from './schema/dedup.js';
export type { DedupAction, DedupCondition, DedupLeafCondition, DedupRule, DedupRuleSet, MergeWinner } from './schema/dedup.js';

/* Reading and validating a rule set ------------------------------------------------------------ */
export {
  flattenIssues,
  formatIssues,
  loadRuleSet,
  MAX_DOCUMENT_DEPTH,
  MAX_RULE_SET_CHARS,
  parseRuleSet,
  parseRuleSetOrThrow,
  RuleSetError,
} from './parse.js';
export type { ParseRuleSetOptions, RuleSetIssue, RuleSetParse } from './parse.js';
export { RULE_SET_SCHEMA_ID, ruleSetJsonSchema } from './json-schema.js';

/* Evaluation ----------------------------------------------------------------------------------- */
export { DEFAULT_LIMITS, evaluateRules, MAX_CONDITION_DEPTH, resolveLimits, sortRules, traceHasError } from './engine.js';
export type {
  ActionContext,
  EvaluateOptions,
  Evaluation,
  EvaluationContext,
  ResolvedLimits,
  RuleFacet,
  RuleLike,
  RuleSetLike,
} from './engine.js';
export { evaluateDedup, evaluateIngestion } from './evaluate.js';

/* The trace ------------------------------------------------------------------------------------ */
export { renderTrace } from './trace.js';
export type { ActionOutcome, ActionTrace, ConditionTrace, EvaluationTrace, RuleOutcome, RuleTrace } from './trace.js';

/* The facets ------------------------------------------------------------------------------------ */
export * from './ingestion/index.js';
export * from './dedup/index.js';

/* Dry run and reports --------------------------------------------------------------------------- */
export { dryRun, dryRunDedup, dryRunIngestion, summariseDedup, summariseIngestion } from './dry-run.js';
export type { DedupSummary, DryRunEntry, DryRunOptions, DryRunReport, IngestionSummary, RuleStatistics } from './dry-run.js';
export { renderDedupReport, renderIngestionReport } from './report.js';

/* Matching primitives, for a caller that needs one on its own ------------------------------------ */
export { applyMatcher, applyMatcherToAny, describeMatcher } from './match.js';
export type { MatchResult } from './match.js';
export { globRegex, globToPattern } from './glob.js';
export { basename, normalisePath } from './path.js';
export type { NormalisedPath } from './path.js';
export { hasPlaceholder, interpolate, MAX_INTERPOLATED } from './interpolate.js';
export type { Interpolation } from './interpolate.js';

/* The linear-time regular expression engine ------------------------------------------------------ */
export {
  DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  isRegexLimitError,
  MAX_COMPILE_STEPS,
  MAX_DEPTH,
  MAX_PATTERN_LENGTH,
  MAX_PROGRAM,
  MAX_REPEAT,
  RegexBudgetError,
  RegexInputTooLongError,
  RegexSyntaxError,
  RegexTimeoutError,
  regexLimitName,
  SafeRegex,
  safeMatch,
  safeRegex,
  safeTest,
  SUPPORTED_FLAGS,
} from './regex/index.js';
export type { CodePointInput, RegexLimitError, SafeMatchResult, SafeRegexOptions, VmMatch } from './regex/index.js';
