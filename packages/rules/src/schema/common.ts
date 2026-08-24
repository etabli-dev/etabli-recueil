/**
 * The envelope: the parts of a rule set that do not depend on what is being matched.
 *
 * `spec/data-model.md` O2 leaves open whether rules live in a table or a file, and recommends a
 * table with import and export to YAML. That is exactly the shape this format is built for: the
 * envelope carries a version so a stored rule set can be read by a later engine, an `id` per rule
 * so a tag can point back at the rule that added it (`item_tags.rule_ref`, §3.13), and a `priority`
 * so precedence is a stored number rather than a row order that a UI drag can silently change.
 */
import * as z from 'zod';

import { RULE_FORMAT_VERSION } from '../version.js';

/**
 * A stable handle for one rule.
 *
 * Kebab-case rather than the snake_case `SlugSchema` of `@recueil/schemas`, because a rule id is a
 * human-written label that appears in a trace and in `item_tags.rule_ref`, not a database
 * identifier. It is the rule author's job to keep it stable: renaming one orphans the provenance of
 * everything it has already tagged.
 */
export const RuleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u, 'must be a lowercase kebab or snake identifier')
  .meta({ id: 'RuleId', examples: ['acme-invoices', 'scanner-inbox'] });

export const RULE_MODES = ['first-match', 'all-match'] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const RuleModeSchema = z.enum(RULE_MODES).meta({
  id: 'RuleMode',
  description:
    '`all-match`: every rule whose condition holds contributes, in precedence order, and a later ' +
    'rule overwrites a scalar an earlier one set (the overwrite is recorded as a conflict). ' +
    '`first-match`: evaluation stops at the first rule whose condition holds.',
});

export const RULE_KINDS = ['ingestion', 'dedup'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RuleKindSchema = z.enum(RULE_KINDS).meta({
  id: 'RuleKind',
  description:
    'Which pipeline the set belongs to: `ingestion` is CONCEPT.md §5.3 stage 8, `dedup` is §5.6. ' +
    'The envelope, the precedence, the trace and the dry run are shared; the conditions and the ' +
    'actions are not, because they see different subjects.',
});

export const RuleLimitsSchema = z
  .strictObject({
    maxSteps: z
      .number()
      .int()
      .min(1000)
      .max(200_000_000)
      .optional()
      .meta({ description: 'Simulation steps allowed for one pattern against one value.' }),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .meta({ description: 'Wall-clock milliseconds allowed for one pattern against one value.' }),
    maxTextLength: z
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .optional()
      .meta({
        description:
          'Longest extracted text a `text` condition will read. Beyond it the text is truncated ' +
          'and the trace says so, because a silent truncation is a wrong answer.',
      }),
  })
  .meta({ id: 'RuleLimits' });

export type RuleLimits = z.infer<typeof RuleLimitsSchema>;

/** The version stamped on a rule set this build writes. */
export const RuleFormatVersionSchema = z.literal(RULE_FORMAT_VERSION).meta({
  id: 'RuleFormatVersion',
  description: 'The rule format version. Bumped only for a change a version-1 reader cannot handle.',
});

/**
 * Build the `rules` array schema for one facet.
 *
 * Taking the condition and action schemas as arguments is what "one rule representation serves
 * both" means in practice: the ingestion and dedup sets differ in two type parameters and nothing
 * else, so the precedence, the trace and the dry run are written once.
 */
export const ruleSchema = <Condition extends z.ZodType, Action extends z.ZodType>(
  condition: Condition,
  action: Action,
  meta: { readonly id: string; readonly description: string },
) =>
  z
    .strictObject({
      id: RuleIdSchema,
      description: z.string().max(1024).optional(),
      enabled: z.boolean().optional().meta({ description: 'Default true. A disabled rule is traced as skipped, not omitted.' }),
      priority: z
        .number()
        .int()
        .min(-1_000_000)
        .max(1_000_000)
        .optional()
        .meta({
          description:
            'Higher runs first. Default 0. Rules of equal priority run in the order they are ' +
            'written, so a rule set with no priorities at all is still deterministic.',
        }),
      when: condition,
      then: z.array(action).min(1).max(64),
    })
    .meta(meta);
