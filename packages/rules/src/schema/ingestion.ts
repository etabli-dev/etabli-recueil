/**
 * The ingestion facet of the rule format — CONCEPT.md §5.3 stage 8.
 *
 * "Match on source, sender, path, text regex or resolver result, and set item type, collection,
 * tags and custom fields" is the whole brief, and the vocabulary below is that sentence made
 * checkable. Two things in it are worth stating out loud:
 *
 * - `route-to-review` writes the reason and the explanation the rule author chose, not a generated
 *   sentence. `spec/data-model.md` §6.1 requires the explanation to be stored so that a decision
 *   queued in 2026 still reads correctly in 2029, and a stored sentence that was assembled from a
 *   rule that has since been edited is not that.
 * - `set-confidence` exists because stage 9 is a confidence gate. A rule that recognises a scanner's
 *   own filing convention knows more than the heuristics do, and needs to be able to say so.
 */
import * as z from 'zod';

import { ConfidenceSchema, ItemTypeSchema, SlugSchema } from '@recueil/schemas';

import { MatcherSchema } from './matchers.js';
import { RuleFormatVersionSchema, RuleIdSchema, RuleLimitsSchema, RuleModeSchema, ruleSchema } from './common.js';

/* -------------------------------------------------------------------------------------------- */
/* Conditions                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export const RESOLVER_OUTCOMES = ['hit', 'miss', 'ambiguous', 'error', 'skipped'] as const;
export type ResolverOutcomeKind = (typeof RESOLVER_OUTCOMES)[number];

export const ResolverOutcomeKindSchema = z.enum(RESOLVER_OUTCOMES).meta({
  id: 'ResolverOutcomeKind',
  description:
    'What identifier resolution (CONCEPT.md §5.4) came back with for one source. `ambiguous` is ' +
    'the case P3 cares about: several candidates, none decisive.',
});

const fieldCondition = <Type extends string>(type: Type, description: string) =>
  z.strictObject({ type: z.literal(type), match: MatcherSchema }).meta({ description });

const SourceConditionSchema = fieldCondition('source', 'The ingestion source kind: upload, folder, webdav, imap, scanner, …');
const SenderConditionSchema = fieldCondition('sender', 'The mail sender, or the scanner or share identity that supplied the file.');
const RecipientConditionSchema = fieldCondition('recipient', 'Any one of the recipients. Matches when at least one does.');
const SubjectConditionSchema = fieldCondition('subject', 'The mail subject line.');
const PathConditionSchema = fieldCondition('path', 'The source path, lexically normalised before matching.');
const FilenameConditionSchema = fieldCondition('filename', 'The last segment of the source path.');
const MimeConditionSchema = fieldCondition('mime', 'The sniffed MIME type, for instance application/pdf.');
const TextConditionSchema = fieldCondition('text', 'The extracted text, from the text layer or from OCR.');
const ItemTypeConditionSchema = fieldCondition('item-type', 'The item type as it stands when the rule engine runs.');
const TagConditionSchema = fieldCondition('tag', 'Any tag already on the subject. Matches when at least one does.');

const ResolverConditionSchema = z
  .strictObject({
    type: z.literal('resolver'),
    resolver: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({ description: 'Restrict to one resolver, e.g. crossref. Omitted, any resolver satisfies the condition.' }),
    outcome: z.union([ResolverOutcomeKindSchema, z.array(ResolverOutcomeKindSchema).min(1)]),
    minConfidence: ConfidenceSchema.optional().meta({
      description: 'Also require the resolution to carry at least this much confidence.',
    }),
  })
  .meta({ description: 'The result of identifier resolution (CONCEPT.md §5.3 stage 7).' });

const AlwaysConditionSchema = z
  .strictObject({ type: z.literal('always') })
  .meta({ description: 'Matches everything. The honest way to write a catch-all or a default.' });

/** The leaf conditions, which is also the list the recursive union extends. */
const leafConditions = [
  SourceConditionSchema,
  SenderConditionSchema,
  RecipientConditionSchema,
  SubjectConditionSchema,
  PathConditionSchema,
  FilenameConditionSchema,
  MimeConditionSchema,
  TextConditionSchema,
  ItemTypeConditionSchema,
  TagConditionSchema,
  ResolverConditionSchema,
  AlwaysConditionSchema,
] as const;

type LeafCondition = z.infer<(typeof leafConditions)[number]>;

/** One leaf: a `type` naming what to read from the subject, and a matcher for it. */
export type IngestionLeafCondition = LeafCondition;

/**
 * A condition tree.
 *
 * A leaf carries a `type`; a composite is written as the bare key `all`, `any` or `not`, because
 * `- not: { type: tag, match: { equals: filed } }` is what a person writing YAML in a text box
 * produces, and `- { type: not, of: { … } }` is what a person translating a class diagram produces.
 *
 * Written out by hand rather than inferred because the type is recursive and TypeScript needs the
 * annotation before Zod can be asked for it.
 */
export type IngestionCondition =
  | IngestionLeafCondition
  | { all: IngestionCondition[] }
  | { any: IngestionCondition[] }
  | { not: IngestionCondition };

export const IngestionConditionSchema: z.ZodType<IngestionCondition> = z.lazy(() =>
  z
    .union([
      z.discriminatedUnion('type', [...leafConditions]),
      z
        .strictObject({ all: z.array(IngestionConditionSchema).min(1).max(64) })
        .meta({ description: 'Every member must match.' }),
      z
        .strictObject({ any: z.array(IngestionConditionSchema).min(1).max(64) })
        .meta({ description: 'At least one member must match.' }),
      z.strictObject({ not: IngestionConditionSchema }).meta({ description: 'The member must not match.' }),
    ])
    .meta({
      id: 'IngestionCondition',
      description: 'A condition tree. `all`, `any` and `not` compose the leaves; the leaves read the subject.',
    }),
) as z.ZodType<IngestionCondition>;

/* -------------------------------------------------------------------------------------------- */
/* Actions                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const REVIEW_SEVERITIES = ['info', 'warning', 'blocker'] as const;
export const ReviewSeveritySchema = z.enum(REVIEW_SEVERITIES).meta({ id: 'RuleReviewSeverity' });

export const REVIEW_PROPOSED_ACTIONS = ['merge', 'link', 'create_item', 'set_fields', 'discard', 'retry', 'none'] as const;
export const ReviewProposedActionSchema = z.enum(REVIEW_PROPOSED_ACTIONS).meta({
  id: 'RuleReviewProposedAction',
  description: 'The `proposed_action` vocabulary of `review_queue` (spec/data-model.md §6.1).',
});

/**
 * A string a rule writes into the library. `${name}` interpolates a named capture from a regex
 * condition that matched in the same rule; a name with no capture behind it skips the action and
 * says so in the trace, rather than writing the literal text.
 */
const TemplateTextSchema = z.string().min(1).max(1024);

const SetItemTypeActionSchema = z
  .strictObject({ type: z.literal('set-item-type'), itemType: ItemTypeSchema })
  .meta({ description: 'Set the item type. Open vocabulary; a plugin may have registered the value.' });

const AddToCollectionActionSchema = z
  .strictObject({
    type: z.literal('add-to-collection'),
    collection: TemplateTextSchema.meta({
      description: 'A collection path with `/` between levels, for instance Office/Invoices/2026.',
    }),
    create: z
      .boolean()
      .optional()
      .meta({ description: 'Default true: create the collection, and its parents, when it does not exist.' }),
  })
  .meta({ description: 'Add the item to a collection.' });

const AddTagsActionSchema = z
  .strictObject({ type: z.literal('add-tags'), tags: z.array(TemplateTextSchema).min(1).max(64) })
  .meta({ description: 'Add tags. They are recorded with scheme `automatic` and this rule as `rule_ref`.' });

const RuleFieldValueSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]).meta({
  id: 'RuleFieldValue',
  description: 'What a rule may write into a custom field. Interpolation applies to the string form.',
});

const SetCustomFieldActionSchema = z
  .strictObject({ type: z.literal('set-custom-field'), field: SlugSchema, value: RuleFieldValueSchema })
  .meta({ description: 'Set one custom field (CONCEPT.md §5.2, CustomField / FieldValue).' });

const SetCorrespondentActionSchema = z
  .strictObject({ type: z.literal('set-correspondent'), correspondent: TemplateTextSchema })
  .meta({ description: 'Set the office facet correspondent (spec/data-model.md §3.7).' });

const SetConfidenceActionSchema = z
  .strictObject({ type: z.literal('set-confidence'), confidence: ConfidenceSchema })
  .meta({ description: 'Set the confidence the gate at stage 9 will read.' });

const RouteToReviewActionSchema = z
  .strictObject({
    type: z.literal('route-to-review'),
    reasonCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/u, 'must be a lowercase snake_case reason code')
      .meta({ description: 'Open vocabulary; `rule_conflict` and friends come from spec/data-model.md §6.1.' }),
    explanation: TemplateTextSchema.meta({ description: 'The stored sentence a human will read. Name the evidence.' }),
    severity: ReviewSeveritySchema.optional(),
    proposedAction: ReviewProposedActionSchema.optional(),
  })
  .meta({ description: 'Queue the subject for a human decision (P3, "flag, never guess").' });

const StopActionSchema = z
  .strictObject({ type: z.literal('stop') })
  .meta({ description: 'Apply nothing further. Rules after this one are traced as not reached.' });

export const IngestionActionSchema = z
  .discriminatedUnion('type', [
    SetItemTypeActionSchema,
    AddToCollectionActionSchema,
    AddTagsActionSchema,
    SetCustomFieldActionSchema,
    SetCorrespondentActionSchema,
    SetConfidenceActionSchema,
    RouteToReviewActionSchema,
    StopActionSchema,
  ])
  .meta({ id: 'IngestionAction' });

export type IngestionAction = z.infer<typeof IngestionActionSchema>;
export type RuleFieldValue = z.infer<typeof RuleFieldValueSchema>;

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const IngestionRuleSchema = ruleSchema(IngestionConditionSchema, IngestionActionSchema, {
  id: 'IngestionRule',
  description: 'One ingestion rule: a condition tree and the actions to apply when it holds.',
});

export type IngestionRule = z.infer<typeof IngestionRuleSchema>;

export const IngestionRuleSetSchema = z
  .strictObject({
    version: RuleFormatVersionSchema,
    kind: z.literal('ingestion'),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(4096).optional(),
    mode: RuleModeSchema.optional(),
    limits: RuleLimitsSchema.optional(),
    rules: z.array(IngestionRuleSchema).max(2000),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of ctx.value.rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.issues.push({
          code: 'custom',
          input: rule.id,
          path: ['rules', index, 'id'],
          message: `duplicate rule id "${rule.id}"; ids are how a trace and a tag point back at a rule`,
        });
      }
      seen.add(rule.id);
    }
  })
  .meta({ id: 'IngestionRuleSet' });

export type IngestionRuleSet = z.infer<typeof IngestionRuleSetSchema>;

export { RuleIdSchema };
