/**
 * Creator — a person or organisation as an entity, with its identity-resolution state
 * (`spec/data-model.md` §5.1), and `ItemCreator`, its appearance on one item (§5.2).
 *
 * Affiliation lives on the appearance, not on the person, because it is a property of the
 * publication event. That is what makes bibliometrix `C1` and institutional collaboration
 * networks possible at all.
 */
import * as z from 'zod';

import {
  CountryCodeSchema,
  CountSchema,
  IdSchema,
  ShortTextSchema,
  TimestampSchema,
  isValidOrcid,
} from '../primitives.js';
import {
  CreatorKindSchema,
  CreatorRoleSchema,
  DisambiguationStatusSchema,
} from '../vocabularies.js';

export const OrcidSchema = z
  .string()
  .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, 'must be a hyphenated 16-character ORCID')
  .refine(isValidOrcid, 'ORCID check digit does not match')
  .meta({ id: 'Orcid', title: 'Orcid', examples: ['0000-0002-1825-0097'] });

export const RorSchema = z
  .string()
  .regex(/^0[0-9a-hjkmnp-z]{6}\d{2}$/, 'must be a ROR identifier')
  .meta({ id: 'Ror', title: 'Ror', examples: ['032000t02'] });

/** One observed spelling of a name, with where it came from and how often (CONCEPT.md §5.2). */
export const NameVariantSchema = z
  .strictObject({
    form: ShortTextSchema,
    source: z.string().max(96),
    count: CountSchema.optional(),
  })
  .meta({ id: 'NameVariant', title: 'NameVariant' });

const creatorWritableShape = {
  kind: CreatorKindSchema,
  familyName: ShortTextSchema.nullish(),
  givenName: ShortTextSchema.nullish(),
  namePrefix: z.string().max(64).nullish().meta({ description: '`van`, `de`, where the source separates it.' }),
  nameSuffix: z.string().max(64).nullish().meta({ description: '`Jr`, `III`.' }),
  literalName: ShortTextSchema.nullish().meta({
    description: 'Single-field name. Required for an organisation and for persons whose name does not split.',
  }),
  initials: z.string().max(32).nullish().meta({ description: 'bibliometrix AU uses the abbreviated form.' }),
  nameVariants: z.array(NameVariantSchema).max(256).optional(),
  orcid: OrcidSchema.nullish(),
  openalexAuthorId: z.string().regex(/^A\d{2,12}$/, 'must be an OpenAlex author id of the form A…').nullish(),
  semanticScholarAuthorId: z.string().max(32).nullish(),
  scopusAuthorId: z.string().max(32).nullish(),
  researcherId: z.string().max(32).nullish(),
  isni: z.string().regex(/^\d{15}[\dX]$/, 'must be a 16-character ISNI').nullish(),
  viaf: z.string().regex(/^\d{1,22}$/).nullish(),
  ror: RorSchema.nullish().meta({ description: 'Organisations only.' }),
  wikidataId: z.string().regex(/^Q\d+$/).nullish(),
} as const;

const creatorServerShape = {
  id: IdSchema,
  displayName: ShortTextSchema.meta({ description: 'Rendered once, on write.' }),
  sortName: ShortTextSchema.meta({ description: '`family, given` normalised — the dedup blocking key.' }),
  disambiguationStatus: DisambiguationStatusSchema,
  mergedIntoCreatorId: IdSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  trashedAt: TimestampSchema.nullish(),
} as const;

const checkCreatorName = (
  value: { kind?: string; familyName?: string | null; literalName?: string | null },
  ctx: z.RefinementCtx,
): void => {
  const has = (candidate: unknown): boolean => typeof candidate === 'string' && candidate.length > 0;
  if (!has(value.familyName) && !has(value.literalName)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a creator needs either a familyName or a literalName (ck_creators_name)',
      path: ['familyName'],
    });
  }
  if (value.kind === 'organisation' && !has(value.literalName)) {
    ctx.addIssue({
      code: 'custom',
      message: 'an organisation is named by its literalName (ck_creators_org)',
      path: ['literalName'],
    });
  }
};

export const CreatorSchema = z
  .strictObject({ ...creatorServerShape, ...creatorWritableShape })
  .superRefine(checkCreatorName)
  .meta({
    id: 'Creator',
    title: 'Creator',
    description:
      'A person or organisation. Two creators with different non-null ORCIDs are never merged ' +
      'automatically: the `author_consistency` check flags the conflict instead (CR2, P3).',
  });

export const CreatorCreateSchema = z
  .strictObject(creatorWritableShape)
  .superRefine(checkCreatorName)
  .meta({ id: 'CreatorCreate', title: 'CreatorCreate', unusedIO: 'input' });

export const CreatorUpdateSchema = z
  .strictObject(creatorWritableShape)
  .partial()
  .superRefine(checkCreatorName)
  .meta({ id: 'CreatorUpdate', title: 'CreatorUpdate', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* The appearance on an item                                                                       */
/* -------------------------------------------------------------------------------------------- */

const itemCreatorWritableShape = {
  creatorId: IdSchema,
  role: CreatorRoleSchema,
  rawName: ShortTextSchema.nullish().meta({
    description: 'Exactly as printed, kept for BibTeX fidelity and the `author_consistency` check.',
  }),
  affiliationRaw: ShortTextSchema.nullish().meta({ description: 'The affiliation as printed — bibliometrix C1.' }),
  affiliationRor: RorSchema.nullish(),
  affiliationCreatorId: IdSchema.nullish(),
  countryCode: CountryCodeSchema.nullish(),
  isCorresponding: z.boolean().optional(),
  contributionRoles: z
    .array(z.string().max(64))
    .max(32)
    .nullish()
    .meta({ description: 'CRediT taxonomy roles, when the source supplies them.' }),
} as const;

export const ItemCreatorSchema = z
  .strictObject({
    ordinal: CountSchema.meta({ description: 'Zero-based position in the author list; dense within an item (IC1).' }),
    creator: CreatorSchema.optional().meta({ description: 'The expanded creator record, when the caller asked for it.' }),
    createdAt: TimestampSchema,
    ...itemCreatorWritableShape,
  })
  .meta({
    id: 'ItemCreator',
    title: 'ItemCreator',
    description: "A creator's appearance on one item, with role, order and the affiliation as printed.",
  });

/**
 * Writing the author list. Order is the array order — the server assigns the dense `ordinal`
 * block in one transaction (IC1), so a client never computes positions.
 */
export const ItemCreatorInputSchema = z
  .strictObject({
    ...itemCreatorWritableShape,
    creatorId: IdSchema.optional().meta({ description: 'Omit to have the server resolve or create the creator from `creator`.' }),
    creator: CreatorCreateSchema.optional().meta({
      description: 'An inline creator to resolve against existing records and create if new.',
    }),
  })
  .superRefine((value, ctx) => {
    if (value.creatorId === undefined && value.creator === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'either creatorId or an inline creator is required',
        path: ['creatorId'],
      });
    }
  })
  .meta({ id: 'ItemCreatorInput', title: 'ItemCreatorInput', unusedIO: 'input' });

export type Creator = z.infer<typeof CreatorSchema>;
export type CreatorCreate = z.infer<typeof CreatorCreateSchema>;
export type CreatorUpdate = z.infer<typeof CreatorUpdateSchema>;
export type ItemCreator = z.infer<typeof ItemCreatorSchema>;
export type ItemCreatorInput = z.infer<typeof ItemCreatorInputSchema>;
