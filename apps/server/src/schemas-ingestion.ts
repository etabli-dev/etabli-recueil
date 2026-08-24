/**
 * The Phase 2 contract: ingestion sources, the work queue, the review queue, rules and storage.
 *
 * Split from `schemas.ts` for the same reason `schemas.ts` is split from `@recueil/schemas`: these
 * shapes belong to a surface rather than to the data model. An `IngestionSource` is not an entity
 * anybody else needs — `spec/data-model.md` has no table for it — and a `RuleDryRunReport` is the
 * return type of one endpoint.
 *
 * Three conventions, on top of the two `schemas.ts` states:
 *
 * - **A secret is write-only.** Every source and backend takes its credentials in a `secret` object
 *   on the *request* and answers with `secretNames`, the list of which credentials are held. There
 *   is no read path for a stored secret anywhere in this file, which is what makes "secrets stored
 *   out of the response body" a property of the contract rather than a promise in a handler.
 * - **The rule shapes are `@recueil/rules`' own.** `when` and `then` are that package's Zod
 *   schemas, unchanged, so the document describes exactly what the engine accepts and a rule that
 *   validates against the OpenAPI document is a rule the engine will run.
 * - **A report carries its evidence.** `TestConnectionResult` and `StorageHealthResult` both return
 *   the individual checks that were run, not a bare boolean, because "it works" with nothing behind
 *   it is the shape of claim the Phase 1 review found wanting.
 */
import {
  ConfidenceSchema,
  DocumentSchema,
  DocumentSourceKindSchema,
  IdSchema,
  ItemSchema,
  SlugSchema,
  TimestampSchema,
  pageOf,
} from '@recueil/schemas';
import {
  DedupActionSchema,
  DedupConditionSchema,
  IngestionActionSchema,
  IngestionConditionSchema,
  RuleIdSchema,
  RuleKindSchema,
  RuleLimitsSchema,
  RuleModeSchema,
} from '@recueil/rules';
import * as z from 'zod';

/* -------------------------------------------------------------------------------------------- */
/* Ingestion sources                                                                               */
/* -------------------------------------------------------------------------------------------- */

export const INGESTION_SOURCE_KINDS = ['folder', 'webdav', 'imap'] as const;

export const IngestionSourceKindSchema = z.enum(INGESTION_SOURCE_KINDS).meta({
  id: 'IngestionSourceKind',
  description:
    'The three places CONCEPT.md §5.3 names that are places rather than protocols. The scanner ' +
    'path is not a fourth: a Brother ADS-4700W is a folder or a mailbox depending on which of its ' +
    'destinations it is pointed at.',
});

/**
 * What happens to the original once the pipeline has committed it.
 *
 * `move` and `delete` destroy or relocate the only copy on the far side, and `@recueil/ingest-sources`
 * refuses either until the bytes have been re-read out of the content store and re-hashed. The
 * contract says so here because an operator choosing `delete` in a form should be told what it
 * rests on.
 */
export const ConsumePolicySchema = z
  .strictObject({
    mode: z.enum(['leave', 'move', 'delete']).meta({ description: 'Default `leave`.' }),
    to: z
      .string()
      .max(1024)
      .optional()
      .meta({
        description:
          'Required for `move`: a directory for a folder source, a collection for WebDAV, a ' +
          'mailbox for IMAP. Relative to the source root, and never allowed to escape it.',
      }),
  })
  .refine((value) => value.mode !== 'move' || (value.to !== undefined && value.to.trim() !== ''), {
    message: "the 'move' policy needs a destination",
    path: ['to'],
  })
  .meta({ id: 'ConsumePolicy', title: 'ConsumePolicy' });

const FolderSourceConfigSchema = z
  .strictObject({
    kind: z.literal('folder'),
    root: z
      .string()
      .min(1)
      .max(4096)
      .meta({ description: 'The watched directory. Absolute, existing, and inside RECUEIL_INGEST_ALLOWED_ROOTS when that is set.' }),
    recursive: z.boolean().optional(),
    skipHidden: z.boolean().optional(),
    exclude: z.array(z.string().max(255)).max(64).optional(),
    minimumAgeMillis: z
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .optional()
      .meta({ description: 'How long a file must be unchanged before it is offered. Guards against half-written scans.' }),
    watch: z.boolean().optional().meta({ description: 'Use filesystem notifications as well as the poll. Default true.' }),
  })
  .meta({ id: 'FolderSourceConfig', title: 'FolderSourceConfig' });

const WebDavSourceConfigSchema = z
  .strictObject({
    kind: z.literal('webdav'),
    url: z.url().max(2048).meta({ description: 'The collection to poll, as an absolute http(s) URL.' }),
    username: z.string().max(255).optional(),
    authKind: z.enum(['basic', 'bearer', 'none']).optional().meta({ description: 'Default `basic` when a username or password is given, `none` otherwise.' }),
    recursive: z.boolean().optional(),
    maxDepth: z.number().int().min(1).max(16).optional(),
    timeoutMillis: z.number().int().min(1000).max(600_000).optional(),
  })
  .meta({ id: 'WebDavSourceConfig', title: 'WebDavSourceConfig' });

const ImapSourceConfigSchema = z
  .strictObject({
    kind: z.literal('imap'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535).optional(),
    secure: z.boolean().optional().meta({ description: 'Implicit TLS on connect (port 993). Default true.' }),
    username: z.string().min(1).max(255),
    mailbox: z.string().max(255).optional().meta({ description: 'Default `INBOX`.' }),
    search: z.string().max(255).optional().meta({ description: 'The `UID SEARCH` criteria. Default `UNSEEN`.' }),
    markSeen: z.boolean().optional(),
    batchSize: z.number().int().min(1).max(500).optional(),
    timeoutMillis: z.number().int().min(1000).max(600_000).optional(),
  })
  .meta({ id: 'ImapSourceConfig', title: 'ImapSourceConfig' });

export const IngestionSourceConfigSchema = z
  .discriminatedUnion('kind', [FolderSourceConfigSchema, WebDavSourceConfigSchema, ImapSourceConfigSchema])
  .meta({
    id: 'IngestionSourceConfig',
    title: 'IngestionSourceConfig',
    description: 'Everything about a source that is safe to send back. Credentials are not in here.',
  });

/** The credentials a source may hold. Accepted on a write; never returned. */
export const IngestionSecretSchema = z
  .strictObject({
    password: z.string().min(1).max(4096).optional(),
    token: z.string().min(1).max(8192).optional(),
  })
  .meta({
    id: 'IngestionSecret',
    title: 'IngestionSecret',
    unusedIO: 'input',
    description:
      'Write-only. Stored encrypted under `RECUEIL_SECRET_KEY`; a server with no key configured ' +
      'refuses the write rather than storing a credential it cannot protect.',
  });

export const IngestionSourceSchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().min(1).max(255),
    kind: IngestionSourceKindSchema,
    enabled: z.boolean(),
    sourceKind: DocumentSourceKindSchema.meta({
      description: 'The `documents.source_kind` recorded for everything this source produces.',
    }),
    config: IngestionSourceConfigSchema,
    consume: ConsumePolicySchema,
    secretNames: z
      .array(z.string().max(64))
      .meta({ description: 'Which credentials are held, by name. The values are never returned.' }),
    lastRunJobId: IdSchema.nullable(),
    lastRunAt: TimestampSchema.nullable(),
    lastError: z.string().max(4096).nullable(),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'IngestionSource', title: 'IngestionSource' });

export const IngestionSourcePageSchema = pageOf(IngestionSourceSchema, { id: 'IngestionSourcePage' });

export const IngestionSourceCreateSchema = z
  .strictObject({
    name: z.string().min(1).max(255),
    config: IngestionSourceConfigSchema,
    enabled: z.boolean().optional().meta({ description: 'Default true.' }),
    sourceKind: DocumentSourceKindSchema.optional().meta({
      description:
        'Defaults to the source kind: a scanner drop directory is a folder source with `scanner` ' +
        'here, which is how CONCEPT.md §5.3 maps the four destinations of an ADS-4700W onto three ' +
        'sources.',
    }),
    consume: ConsumePolicySchema.optional(),
    secret: IngestionSecretSchema.optional(),
  })
  .meta({ id: 'IngestionSourceCreate', title: 'IngestionSourceCreate', unusedIO: 'input' });

export const IngestionSourceUpdateSchema = z
  .strictObject({
    name: z.string().min(1).max(255).optional(),
    config: IngestionSourceConfigSchema.optional(),
    enabled: z.boolean().optional(),
    sourceKind: DocumentSourceKindSchema.optional(),
    consume: ConsumePolicySchema.optional(),
    secret: IngestionSecretSchema.optional().meta({
      description: 'Replaces the stored credentials wholesale. Send `{}` to clear them.',
    }),
  })
  .meta({ id: 'IngestionSourceUpdate', title: 'IngestionSourceUpdate', unusedIO: 'input' });

export const ConnectionCheckSchema = z
  .strictObject({
    check: z.string().max(64).meta({ description: 'What was tried: `resolve`, `directory`, `options`, `list`, `login`, `select`.' }),
    ok: z.boolean(),
    detail: z.string().max(2048),
  })
  .meta({ id: 'ConnectionCheck', title: 'ConnectionCheck' });

export const TestConnectionResultSchema = z
  .strictObject({
    sourceId: IdSchema,
    kind: IngestionSourceKindSchema,
    ok: z.boolean(),
    checkedAt: TimestampSchema,
    durationMs: z.number().int().min(0),
    checks: z.array(ConnectionCheckSchema),
    detail: z.string().max(4096),
  })
  .meta({
    id: 'TestConnectionResult',
    title: 'TestConnectionResult',
    description:
      'What was actually tried, one row per check. `ok` is the conjunction of the rows rather ' +
      'than a separate opinion, so a green result names the evidence behind it.',
  });

export const SourceRunRequestSchema = z
  .strictObject({
    runLabel: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .meta({
        description:
          'Names the run. The same label resumes an unfinished one; a new label re-scans from the ' +
          'beginning (P9). Defaults to a timestamp.',
      }),
    limit: z.number().int().min(1).max(500).optional().meta({ description: 'How many candidates to take in one poll.' }),
  })
  .meta({ id: 'SourceRunRequest', title: 'SourceRunRequest', unusedIO: 'input' });

export const SourceRunAcceptedSchema = z
  .strictObject({
    sourceId: IdSchema,
    jobId: IdSchema.meta({ description: 'The `jobs` row this run writes to. Poll it at `/api/v1/ingestion/queue/{id}`.' }),
    runLabel: z.string().max(128),
    startedAt: TimestampSchema,
  })
  .meta({ id: 'SourceRunAccepted', title: 'SourceRunAccepted' });

/* -------------------------------------------------------------------------------------------- */
/* The work queue                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'waiting_review',
  'dead',
] as const;

export const JobStateSchema = z.enum(JOB_STATES).meta({
  id: 'JobState',
  description:
    '`waiting_review` is not a failure: IK6 says a job in that state has produced review-queue ' +
    'entries and will not proceed until they are resolved.',
});

export const IngestionJobSchema = z
  .strictObject({
    id: IdSchema,
    jobType: z.string().max(64),
    state: JobStateSchema,
    idempotencyKey: z.string().max(512).nullable(),
    params: z.record(z.string(), z.unknown()),
    priority: z.number().int(),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(0),
    progress: z.strictObject({
      done: z.number().int().min(0),
      total: z.number().int().min(0).nullable(),
    }),
    runAfter: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    heartbeatAt: TimestampSchema.nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z
      .strictObject({ code: z.string().max(128), message: z.string().max(4096) })
      .nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'IngestionJob', title: 'IngestionJob' });

export const IngestionJobPageSchema = pageOf(IngestionJobSchema, { id: 'IngestionJobPage' });

export const JobLogEntrySchema = z
  .strictObject({
    id: IdSchema,
    loggedAt: TimestampSchema,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string().max(8192),
    data: z.record(z.string(), z.unknown()).nullable(),
    subjectType: z.string().max(64).nullable(),
    subjectId: z.string().max(64).nullable(),
  })
  .meta({ id: 'JobLogEntry', title: 'JobLogEntry' });

export const StageTraceEntrySchema = z
  .strictObject({
    candidateKey: z.string().max(64),
    stage: z
      .string()
      .max(32)
      .meta({ description: 'One of the ten anchors of CONCEPT.md §5.3, or `commit` for the terminal row.' }),
    sha256: z.string().max(64).nullable(),
    payload: z.unknown().meta({ description: 'What the stage produced, read back verbatim when the run resumes.' }),
    createdAt: TimestampSchema,
  })
  .meta({ id: 'StageTraceEntry', title: 'StageTraceEntry' });

export const IngestionJobDetailSchema = z
  .strictObject({
    job: IngestionJobSchema,
    /** One entry per candidate per completed stage: the resume point, and the trace a human reads. */
    stages: z.array(StageTraceEntrySchema),
    log: z.array(JobLogEntrySchema),
    /** Open review-queue entries this run raised. Queried, not counted from the run's own tally. */
    reviewEntryIds: z.array(IdSchema),
  })
  .meta({
    id: 'IngestionJobDetail',
    title: 'IngestionJobDetail',
    description:
      'The job row with its stage trace. `stages` comes from `ingest_checkpoints`, which is what ' +
      'a resumed run reads, so the trace and the resume point cannot disagree.',
  });

export const JobRetryRequestSchema = z
  .strictObject({
    reason: z.string().max(1024).optional(),
  })
  .meta({ id: 'JobRetryRequest', title: 'JobRetryRequest', unusedIO: 'input' });

export const JobCancelRequestSchema = z
  .strictObject({
    reason: z.string().max(1024).optional(),
  })
  .meta({ id: 'JobCancelRequest', title: 'JobCancelRequest', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* The review queue (P3)                                                                           */
/* -------------------------------------------------------------------------------------------- */

export const ReviewStatusSchema = z
  .enum(['open', 'accepted', 'rejected', 'deferred', 'superseded'])
  .meta({ id: 'ReviewStatus' });

export const ReviewSubjectTypeSchema = z
  .enum([
    'document',
    'item',
    'attachment',
    'creator',
    'shadow_work',
    'merge_candidate',
    'ingest_batch',
    'check_result',
    'enrichment',
    'job',
  ])
  .meta({ id: 'ReviewSubjectType' });

export const ReviewProposedActionSchema = z
  .enum(['merge', 'link', 'create_item', 'set_fields', 'discard', 'retry', 'none'])
  .meta({ id: 'ReviewProposedAction' });

export const ReviewEntrySchema = z
  .strictObject({
    id: IdSchema,
    subjectType: ReviewSubjectTypeSchema,
    subjectId: z.string().max(64),
    secondarySubjectType: z.string().max(64).nullable(),
    secondarySubjectId: z.string().max(64).nullable(),
    reasonCode: z.string().max(64),
    explanation: z
      .string()
      .max(8192)
      .meta({ description: 'Stored when the entry was raised, not generated at render time (§6.1).' }),
    proposedAction: ReviewProposedActionSchema.nullable(),
    proposedPayload: z
      .unknown()
      .meta({ description: 'Exactly what accepting will execute (RQ1). Null when there is nothing to propose.' }),
    confidence: ConfidenceSchema.nullable(),
    severity: z.enum(['info', 'warning', 'blocker']),
    status: ReviewStatusSchema,
    sourceStage: z.string().max(64).nullable(),
    jobId: IdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
    resolutionNote: z.string().max(4096).nullable(),
    resolutionPayload: z.unknown(),
  })
  .meta({ id: 'ReviewEntry', title: 'ReviewEntry' });

export const ReviewEntryPageSchema = pageOf(ReviewEntrySchema, { id: 'ReviewEntryPage' });

/**
 * The edits an operator may make while accepting.
 *
 * Every field replaces its counterpart in the proposal rather than merging into it, except
 * `fields`, which is a patch: an editor that has to resend forty extracted fields to correct one
 * correspondent is an editor nobody uses, and a `null` value removes the field.
 */
export const ReviewEditsSchema = z
  .strictObject({
    itemType: SlugSchema.optional(),
    fields: z
      .record(z.string().max(128), z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]))
      .optional()
      .meta({ description: 'Dotted, facet-qualified paths: `bibliographic.title`, `office.correspondent`. Null removes.' }),
    tags: z.array(z.string().max(255)).max(200).optional(),
    collectionIds: z.array(IdSchema).max(200).optional(),
    customFields: z
      .record(z.string().max(128), z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]))
      .optional(),
    notes: z.array(z.string().max(100_000)).max(20).optional(),
  })
  .meta({ id: 'ReviewEdits', title: 'ReviewEdits', unusedIO: 'input' });

export const ReviewAcceptRequestSchema = z
  .strictObject({
    note: z.string().max(4096).optional().meta({ description: 'Recorded as `resolution_note` and in the audit log.' }),
    edits: ReviewEditsSchema.optional(),
  })
  .meta({ id: 'ReviewAcceptRequest', title: 'ReviewAcceptRequest', unusedIO: 'input' });

export const ReviewRejectRequestSchema = z
  .strictObject({
    note: z.string().max(4096).optional(),
  })
  .meta({ id: 'ReviewRejectRequest', title: 'ReviewRejectRequest', unusedIO: 'input' });

export const ReviewAcceptResultSchema = z
  .strictObject({
    entry: ReviewEntrySchema,
    itemId: IdSchema.nullable().meta({ description: 'Set when accepting created an item.' }),
    attachmentId: IdSchema.nullable(),
    warnings: z.array(z.string().max(2048)),
  })
  .meta({ id: 'ReviewAcceptResult', title: 'ReviewAcceptResult' });

export const ReviewBulkAcceptRequestSchema = z
  .strictObject({
    ids: z.array(IdSchema).min(1).max(500),
    note: z.string().max(4096).optional(),
  })
  .meta({ id: 'ReviewBulkAcceptRequest', title: 'ReviewBulkAcceptRequest', unusedIO: 'input' });

export const ReviewBulkAcceptResultSchema = z
  .strictObject({
    accepted: z.array(ReviewAcceptResultSchema),
    /** One row per entry that could not be accepted, with the reason. Nothing is silently skipped. */
    refused: z.array(
      z.strictObject({
        id: IdSchema,
        code: z.string().max(64),
        detail: z.string().max(2048),
      }),
    ),
  })
  .meta({
    id: 'ReviewBulkAcceptResult',
    title: 'ReviewBulkAcceptResult',
    description:
      'Each entry is accepted in its own transaction, so one refusal does not roll back the rest ' +
      'and the response says exactly which ones landed.',
  });

/* -------------------------------------------------------------------------------------------- */
/* Rules                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * One stored rule.
 *
 * `spec/data-model.md` O2 recommends "a table, with import/export to YAML"; this is that table's
 * row. `ruleId` is the author's stable handle — it is what a trace names and what
 * `item_tags.rule_ref` points at — and `id` is the ULID of the row, so renaming the handle is a
 * deliberate act with a visible consequence rather than a side effect of an edit.
 */
export const RuleSchema = z
  .strictObject({
    id: IdSchema,
    ruleId: RuleIdSchema,
    kind: RuleKindSchema,
    description: z.string().max(1024).nullable(),
    enabled: z.boolean(),
    priority: z.number().int(),
    when: z.unknown().meta({ description: 'The condition, in the rule format of `@recueil/rules`.' }),
    then: z.array(z.unknown()).meta({ description: 'The actions, in the rule format of `@recueil/rules`.' }),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'Rule', title: 'Rule' });

export const RulePageSchema = pageOf(RuleSchema, { id: 'RulePage' });

const IngestionRuleBodySchema = z.strictObject({
  kind: z.literal('ingestion'),
  when: IngestionConditionSchema,
  then: z.array(IngestionActionSchema).min(1).max(64),
});

const DedupRuleBodySchema = z.strictObject({
  kind: z.literal('dedup'),
  when: DedupConditionSchema,
  then: z.array(DedupActionSchema).min(1).max(64),
});

export const RuleCreateSchema = z
  .intersection(
    z.discriminatedUnion('kind', [IngestionRuleBodySchema, DedupRuleBodySchema]),
    z.object({
      ruleId: RuleIdSchema,
      description: z.string().max(1024).optional(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    }),
  )
  .meta({ id: 'RuleCreate', title: 'RuleCreate', unusedIO: 'input' });

/**
 * An update names no `kind`: the kind of a stored rule is fixed.
 *
 * Changing it would silently reinterpret `when` and `then` against a different vocabulary, and a
 * condition that means one thing under `ingestion` and another under `dedup` is precisely the sort
 * of edit that should be a delete and a create.
 */
export const RuleUpdateSchema = z
  .strictObject({
    description: z.string().max(1024).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    when: z.unknown().optional(),
    then: z.array(z.unknown()).min(1).max(64).optional(),
  })
  .meta({ id: 'RuleUpdate', title: 'RuleUpdate', unusedIO: 'input' });

const IngestionSubjectSchema = z
  .strictObject({
    id: z.string().min(1).max(256),
    source: z.string().max(64).optional(),
    sender: z.string().max(512).optional(),
    recipients: z.array(z.string().max(512)).max(64).optional(),
    subject: z.string().max(2048).optional(),
    path: z.string().max(4096).optional(),
    filename: z.string().max(1024).optional(),
    mime: z.string().max(255).optional(),
    text: z.string().max(1_000_000).optional(),
    itemType: z.string().max(64).optional(),
    tags: z.array(z.string().max(255)).max(200).optional(),
    resolvers: z
      .array(
        z.strictObject({
          resolver: z.string().max(64),
          outcome: z.enum(['hit', 'miss', 'ambiguous', 'error', 'skipped']),
          identifier: z.string().max(512).optional(),
          confidence: ConfidenceSchema.optional(),
        }),
      )
      .max(32)
      .optional(),
  })
  .meta({ id: 'IngestionRuleSubject', title: 'IngestionRuleSubject', unusedIO: 'input' });

export const RuleDryRunRequestSchema = z
  .strictObject({
    kind: RuleKindSchema.optional().meta({ description: 'Default `ingestion`. Ignored when `rules` is given.' }),
    mode: RuleModeSchema.optional(),
    limits: RuleLimitsSchema.optional(),
    /**
     * Rules to evaluate instead of the stored set.
     *
     * The whole point of a dry run is to answer "what would this do" before it is stored, so an
     * unsaved rule has to be runnable. Omit it to run the stored, enabled rules of `kind`.
     */
    rules: z.array(RuleCreateSchema).max(200).optional(),
    /** Include disabled stored rules. They are traced as skipped, which is itself informative. */
    includeDisabled: z.boolean().optional(),
    subjects: z.array(IngestionSubjectSchema).min(1).max(500),
    maxTraces: z.number().int().min(0).max(500).optional(),
  })
  .meta({
    id: 'RuleDryRunRequest',
    title: 'RuleDryRunRequest',
    unusedIO: 'input',
    description:
      'Evaluates rules over subjects and writes nothing. The evaluator is a pure function of the ' +
      'rule set and the subject, so there is no apply path this endpoint has to remember to ' +
      'switch off (CONCEPT.md §5.6).',
  });

export const RuleDryRunResponseSchema = z
  .strictObject({
    ruleSet: z.string().max(255),
    kind: z.string().max(32),
    mode: z.string().max(32),
    subjectCount: z.number().int().min(0),
    entries: z.array(
      z.strictObject({
        subjectId: z.string().max(256),
        outcome: z.unknown(),
        trace: z.unknown().optional(),
      }),
    ),
    rules: z.array(
      z.strictObject({
        ruleId: z.string().max(64),
        order: z.number().int().min(0),
        priority: z.number().int(),
        matched: z.number().int().min(0),
        notMatched: z.number().int().min(0),
        notReached: z.number().int().min(0),
        disabled: z.number().int().min(0),
        errors: z.number().int().min(0),
      }),
    ),
    unmatchedSubjectIds: z.array(z.string().max(256)),
    erroredSubjectIds: z.array(z.string().max(256)),
    warnings: z.array(z.string().max(2048)),
  })
  .meta({
    id: 'RuleDryRunResponse',
    title: 'RuleDryRunResponse',
    description:
      "The engine's own report: one entry per subject with its trace, and one row per rule " +
      'whatever its outcome — a rule that never fires is news.',
  });

/* -------------------------------------------------------------------------------------------- */
/* Storage backends                                                                                */
/* -------------------------------------------------------------------------------------------- */

const WebDavBackendConfigSchema = z
  .strictObject({
    kind: z.literal('webdav'),
    url: z.url().max(2048),
    username: z.string().max(255).optional(),
    authKind: z.enum(['basic', 'bearer', 'none']).optional(),
    writeStrategy: z.enum(['temp-move', 'direct-put']).optional(),
    verifyOnWrite: z.enum(['none', 'size', 'digest']).optional(),
    sendContentMd5: z.boolean().optional(),
    sendOcChecksum: z.boolean().optional(),
  })
  .meta({ id: 'WebDavBackendConfig', title: 'WebDavBackendConfig' });

const S3BackendConfigSchema = z
  .strictObject({
    kind: z.literal('s3'),
    bucket: z.string().min(1).max(255),
    region: z.string().max(64).optional(),
    endpoint: z.url().max(2048).optional(),
    forcePathStyle: z.boolean().optional(),
    prefix: z.string().max(255).optional(),
    accessKeyId: z.string().max(255).optional(),
    verifyOnWrite: z.enum(['none', 'size', 'digest']).optional(),
    multipartThreshold: z.number().int().min(5 * 1024 * 1024).max(5 * 1024 * 1024 * 1024).optional(),
    serverSideChecksums: z.boolean().optional(),
  })
  .meta({ id: 'S3BackendConfig', title: 'S3BackendConfig' });

export const StorageBackendConfigSchema = z
  .discriminatedUnion('kind', [WebDavBackendConfigSchema, S3BackendConfigSchema])
  .meta({ id: 'StorageBackendConfig', title: 'StorageBackendConfig' });

export const StorageBackendSchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().min(1).max(255),
    kind: z.enum(['webdav', 's3']),
    enabled: z.boolean(),
    config: StorageBackendConfigSchema,
    secretNames: z.array(z.string().max(64)),
    /** True when this is the backend the running process is actually writing through. */
    active: z.boolean(),
    lastCheckedAt: TimestampSchema.nullable(),
    lastStatus: z.enum(['ok', 'degraded', 'failed']).nullable(),
    lastDetail: z.string().max(4096).nullable(),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({
    // `StorageBackend` is already a component: the `documents.storage_backend` enum in
    // `@recueil/schemas`. This is a *configured* one, which is a different thing, so it gets a
    // different id rather than shadowing the vocabulary a document row points at.
    id: 'ConfiguredStorageBackend',
    title: 'ConfiguredStorageBackend',
    description:
      'A configured remote store. Configuring one does not rebind the running library: the store ' +
      'a process writes through is chosen at boot, because swapping it mid-request would strand ' +
      'every blob written before the swap.',
  });

export const StorageBackendPageSchema = pageOf(StorageBackendSchema, { id: 'ConfiguredStorageBackendPage' });

export const StorageBackendCreateSchema = z
  .strictObject({
    name: z.string().min(1).max(255),
    config: StorageBackendConfigSchema,
    enabled: z.boolean().optional(),
    secret: z
      .strictObject({
        password: z.string().min(1).max(4096).optional(),
        token: z.string().min(1).max(8192).optional(),
        secretAccessKey: z.string().min(1).max(4096).optional(),
        sessionToken: z.string().min(1).max(8192).optional(),
      })
      .optional(),
  })
  .meta({ id: 'ConfiguredStorageBackendCreate', title: 'ConfiguredStorageBackendCreate', unusedIO: 'input' });

export const StorageBackendUpdateSchema = z
  .strictObject({
    name: z.string().min(1).max(255).optional(),
    config: StorageBackendConfigSchema.optional(),
    enabled: z.boolean().optional(),
    secret: z
      .strictObject({
        password: z.string().min(1).max(4096).optional(),
        token: z.string().min(1).max(8192).optional(),
        secretAccessKey: z.string().min(1).max(4096).optional(),
        sessionToken: z.string().min(1).max(8192).optional(),
      })
      .optional(),
  })
  .meta({ id: 'ConfiguredStorageBackendUpdate', title: 'ConfiguredStorageBackendUpdate', unusedIO: 'input' });

export const StorageHealthResultSchema = z
  .strictObject({
    backendId: IdSchema,
    kind: z.enum(['webdav', 's3']),
    status: z.enum(['ok', 'degraded', 'failed']),
    checkedAt: TimestampSchema,
    durationMs: z.number().int().min(0),
    /**
     * `read` probes for a blob that is not there, which is a complete round trip that writes
     * nothing. `roundtrip` additionally writes a small probe blob, reads it back, verifies the
     * digest and deletes it — the only check that proves the store can actually hold a document.
     */
    mode: z.enum(['read', 'roundtrip']),
    checks: z.array(ConnectionCheckSchema),
    detail: z.string().max(4096),
  })
  .meta({ id: 'StorageHealthResult', title: 'StorageHealthResult' });

export const StorageHealthRequestSchema = z
  .strictObject({
    mode: z
      .enum(['read', 'roundtrip'])
      .optional()
      .meta({ description: 'Default `read`. `roundtrip` writes a probe blob and deletes it again.' }),
  })
  .meta({ id: 'StorageHealthRequest', title: 'StorageHealthRequest', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* The share-target upload                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const IngestUploadResultSchema = z
  .strictObject({
    outcome: z
      .enum(['ingested', 'duplicate', 'review', 'container', 'stopped', 'failed'])
      .meta({ description: 'The pipeline outcome, verbatim — the caller is told which of the six happened.' }),
    jobId: IdSchema,
    document: DocumentSchema.nullable(),
    item: ItemSchema.nullable().meta({ description: 'Set when the confidence gate auto-accepted (CONCEPT.md §5.3 stage 9).' }),
    reviewEntry: ReviewEntrySchema.nullable().meta({ description: 'Set when the gate routed it for a human decision (P3).' }),
    reasonCode: z.string().max(64).nullable(),
    detail: z.string().max(4096),
  })
  .meta({
    id: 'IngestUploadResult',
    title: 'IngestUploadResult',
    description:
      'One upload, one answer: the created item, or the review entry that says why there is not ' +
      'one. A share-target client renders one or the other and never has to poll to find out which.',
  });
