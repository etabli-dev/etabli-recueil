/**
 * The deduplication facet of the rule format — CONCEPT.md §5.6.
 *
 * §5.6 asks for merge rules "editable as YAML/JSON in the UI" with "a dry-run report before
 * execution". That is the same requirement as stage 8's rule engine pointed at a different subject,
 * so it is the same format: the envelope, the precedence, the trace and the dry run are shared, and
 * only the conditions and the actions differ. The subject here is a *pair* — the candidate and the
 * record it might duplicate — which is why every condition reads two sides.
 *
 * The engine in this package decides; it does not merge. An action is a decision plus the winner
 * rule that produced it, and the dedup engine of Phase 3 is what carries it out. That split is what
 * makes a dry run meaningful rather than a promise.
 */
import * as z from 'zod';

import { ConfidenceSchema } from '@recueil/schemas';

import { MatcherSchema } from './matchers.js';
import { RuleFormatVersionSchema, RuleLimitsSchema, RuleModeSchema, ruleSchema } from './common.js';
import { ReviewSeveritySchema } from './ingestion.js';

const SimilaritySchema = z.number().min(0).max(1);

export const DEDUP_SIDES = ['left', 'right', 'either', 'both'] as const;
export const DedupSideSchema = z.enum(DEDUP_SIDES).meta({
  id: 'DedupSide',
  description: '`left` is the candidate, `right` is the record already in the library.',
});

export const DEDUP_FIELDS = ['source', 'item-type', 'title', 'venue', 'correspondent', 'container'] as const;
export const DedupFieldSchema = z.enum(DEDUP_FIELDS).meta({ id: 'DedupField' });

const IdentifierMatchConditionSchema = z
  .strictObject({
    type: z.literal('identifier-match'),
    identifier: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .meta({ description: 'doi, pmid, pmcid, arxiv, isbn, … Omitted, any shared identifier satisfies the condition.' }),
  })
  .meta({
    description:
      'Both sides carry the same value for an identifier. Compared with `=`, because invariant B1 ' +
      '(spec/data-model.md §3.5) stores identifiers normalised; this rule engine does not re-normalise ' +
      'and would be wrong to, since it cannot see whether the caller honoured B1.',
  });

const IdentifierConflictConditionSchema = z
  .strictObject({
    type: z.literal('identifier-conflict'),
    identifier: z.string().min(1).max(32).optional(),
  })
  .meta({ description: 'Both sides carry the same identifier key with different values — strong evidence against a merge.' });

const FileHashMatchConditionSchema = z
  .strictObject({ type: z.literal('file-hash-match') })
  .meta({ description: 'The two sides share a document hash: the file layer of §5.6, byte-identical.' });

const TitleSimilarityConditionSchema = z
  .strictObject({ type: z.literal('title-similarity'), atLeast: SimilaritySchema })
  .meta({ description: 'Trigram Jaccard similarity of the normalised titles is at least this.' });

const VenueSimilarityConditionSchema = z
  .strictObject({ type: z.literal('venue-similarity'), atLeast: SimilaritySchema })
  .meta({ description: 'Trigram Jaccard similarity of the normalised venues is at least this.' });

const CreatorSimilarityConditionSchema = z
  .strictObject({
    type: z.literal('creator-similarity'),
    atLeast: SimilaritySchema,
    firstOnly: z.boolean().optional().meta({ description: 'Compare only the first creator, which is the §5.6 fuzzy rule.' }),
  })
  .meta({ description: 'Overlap of the normalised creator names.' });

const YearWithinConditionSchema = z
  .strictObject({ type: z.literal('year-within'), years: z.number().int().min(0).max(50) })
  .meta({ description: 'The two years differ by at most this. §5.6 uses ± 1.' });

const FieldConditionSchema = z
  .strictObject({ type: z.literal('field'), field: DedupFieldSchema, side: DedupSideSchema.optional(), match: MatcherSchema })
  .meta({ description: 'Match one field on one or both sides. `side` defaults to `either`.' });

const SameFieldConditionSchema = z
  .strictObject({ type: z.literal('same-field'), field: DedupFieldSchema })
  .meta({ description: 'The two sides agree on a field, compared after case and whitespace normalisation.' });

const AlwaysConditionSchema = z.strictObject({ type: z.literal('always') }).meta({ description: 'Matches every pair.' });

const leafConditions = [
  IdentifierMatchConditionSchema,
  IdentifierConflictConditionSchema,
  FileHashMatchConditionSchema,
  TitleSimilarityConditionSchema,
  VenueSimilarityConditionSchema,
  CreatorSimilarityConditionSchema,
  YearWithinConditionSchema,
  FieldConditionSchema,
  SameFieldConditionSchema,
  AlwaysConditionSchema,
] as const;

type LeafCondition = z.infer<(typeof leafConditions)[number]>;

export type DedupLeafCondition = LeafCondition;

export type DedupCondition =
  | DedupLeafCondition
  | { all: DedupCondition[] }
  | { any: DedupCondition[] }
  | { not: DedupCondition };

export const DedupConditionSchema: z.ZodType<DedupCondition> = z.lazy(() =>
  z
    .union([
      z.discriminatedUnion('type', [...leafConditions]),
      z.strictObject({ all: z.array(DedupConditionSchema).min(1).max(64) }),
      z.strictObject({ any: z.array(DedupConditionSchema).min(1).max(64) }),
      z.strictObject({ not: DedupConditionSchema }),
    ])
    .meta({
      id: 'DedupCondition',
      description: 'A condition tree. `all`, `any` and `not` compose the leaves; the leaves read the pair.',
    }),
) as z.ZodType<DedupCondition>;

/* -------------------------------------------------------------------------------------------- */
/* Actions                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const MERGE_WINNERS = ['newest', 'oldest', 'most-complete', 'left', 'right'] as const;
export const MergeWinnerSchema = z.enum(MERGE_WINNERS).meta({
  id: 'MergeWinner',
  description: 'The winner rule of CONCEPT.md §5.6: newest dateAdded, oldest, most complete, or a named side.',
});

const MergeActionSchema = z
  .strictObject({ type: z.literal('merge'), winner: MergeWinnerSchema })
  .meta({ description: 'Propose a merge. The loser goes to trash with a reversible merge record; this rule set does not do that.' });

const LinkActionSchema = z
  .strictObject({ type: z.literal('link') })
  .meta({ description: 'Propose attaching the candidate document to the existing item rather than creating a second one.' });

const FlagActionSchema = z
  .strictObject({
    type: z.literal('flag'),
    reasonCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/u, 'must be a lowercase snake_case reason code')
      .optional(),
    explanation: z.string().min(1).max(1024),
    severity: ReviewSeveritySchema.optional(),
  })
  .meta({ description: 'Route the pair to the review queue with a stored explanation, deciding nothing.' });

const IgnoreActionSchema = z
  .strictObject({ type: z.literal('ignore') })
  .meta({ description: 'Declare the pair not a duplicate, so a later pass does not raise it again.' });

const SetConfidenceActionSchema = z
  .strictObject({ type: z.literal('set-confidence'), confidence: ConfidenceSchema })
  .meta({ description: 'Attach a confidence to the decision.' });

const StopActionSchema = z.strictObject({ type: z.literal('stop') }).meta({ description: 'Apply nothing further.' });

export const DedupActionSchema = z
  .discriminatedUnion('type', [
    MergeActionSchema,
    LinkActionSchema,
    FlagActionSchema,
    IgnoreActionSchema,
    SetConfidenceActionSchema,
    StopActionSchema,
  ])
  .meta({ id: 'DedupAction' });

export type DedupAction = z.infer<typeof DedupActionSchema>;
export type MergeWinner = z.infer<typeof MergeWinnerSchema>;

export const DedupRuleSchema = ruleSchema(DedupConditionSchema, DedupActionSchema, {
  id: 'DedupRule',
  description: 'One deduplication rule: a condition over a candidate pair and the decision it proposes.',
});

export type DedupRule = z.infer<typeof DedupRuleSchema>;

export const DedupRuleSetSchema = z
  .strictObject({
    version: RuleFormatVersionSchema,
    kind: z.literal('dedup'),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(4096).optional(),
    mode: RuleModeSchema.optional(),
    limits: RuleLimitsSchema.optional(),
    rules: z.array(DedupRuleSchema).max(2000),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of ctx.value.rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.issues.push({
          code: 'custom',
          input: rule.id,
          path: ['rules', index, 'id'],
          message: `duplicate rule id "${rule.id}"; ids are how a trace and a merge record point back at a rule`,
        });
      }
      seen.add(rule.id);
    }
  })
  .meta({ id: 'DedupRuleSet' });

export type DedupRuleSet = z.infer<typeof DedupRuleSetSchema>;
