/**
 * Bulk operations and idempotency (P9, `spec/data-model.md` §6.3 IK1–IK4, docs/api.qmd).
 *
 * "Replaying a key returns the original result rather than acting twice, which is what makes a
 * client-side write queue safe." The mobile shell and the CLI both queue writes, so this is not a
 * nicety: without it, a retried upload on a flaky connection duplicates records.
 */
import * as z from 'zod';

import { CountSchema, IdSchema } from '../primitives.js';
import { ProblemDetailsSchema } from './problem.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * The value of the `Idempotency-Key` header. The server stores it as `api:<token_id>:<value>`
 * (IK2), so the client's key only has to be unique per token, and a ULID or a UUID both work.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be printable ASCII without spaces')
  .meta({
    id: 'IdempotencyKey',
    title: 'IdempotencyKey',
    description:
      'Client-supplied key for a bulk write. Replaying a key returns the original result — ' +
      'including the original job — rather than enqueuing a second one (IK2).',
    examples: ['01J8F3Z9K4ABCDEFGHJKMNPQRS'],
    param: { in: 'header', name: 'Idempotency-Key', required: false },
  });

export const BulkOperationVerbSchema = z.enum(['create', 'update', 'replace', 'delete', 'restore']).meta({
  id: 'BulkOperationVerb',
});

export const BULK_MAX_OPERATIONS = 1000;

/**
 * One operation in a bulk request. `payload` is deliberately loose here: each endpoint narrows it
 * to its own create/update schema, and the narrowed pair is what the route registers.
 */
export const bulkOperationOf = <TSchema extends z.ZodType>(payload: TSchema, options: { id?: string } = {}) =>
  z
    .strictObject({
      op: BulkOperationVerbSchema,
      id: IdSchema.optional().meta({ description: 'Required for update, replace, delete and restore.' }),
      payload: payload.optional(),
      ref: z
        .string()
        .max(64)
        .optional()
        .meta({ description: 'Client-chosen label echoed in the result, so a queue can reconcile without relying on order.' }),
    })
    .meta({ ...(options.id === undefined ? {} : { id: options.id, title: options.id }), unusedIO: 'input' });

/** A bulk request: an array of operations plus the idempotency key that makes replaying it safe. */
export const bulkRequestOf = <TSchema extends z.ZodType>(operation: TSchema, options: { id?: string } = {}) =>
  z
    .strictObject({
      idempotencyKey: IdempotencyKeySchema.optional().meta({
        description: 'May be sent here instead of in the header. The header wins if both are present.',
      }),
      force: z
        .boolean()
        .optional()
        .meta({
          description:
            'Re-run work whose idempotency key already exists, by appending a run counter to the ' +
            'key. Nothing is ever silently duplicated and nothing silently skipped (IK3).',
        }),
      atomic: z
        .boolean()
        .optional()
        .meta({ description: 'When true the whole batch is one transaction: any rejection rolls all of it back.' }),
      operations: z.array(operation).min(1).max(BULK_MAX_OPERATIONS),
    })
    .meta({ ...(options.id === undefined ? {} : { id: options.id, title: options.id }), unusedIO: 'input' });

export const BulkOperationOutcomeSchema = z
  .strictObject({
    index: CountSchema.meta({ description: 'Position in the submitted array.' }),
    ref: z.string().max(64).optional(),
    status: z.enum(['created', 'updated', 'deleted', 'restored', 'unchanged', 'failed']),
    id: IdSchema.optional(),
    problem: ProblemDetailsSchema.optional().meta({ description: 'Present when, and only when, `status` is `failed`.' }),
  })
  .meta({ id: 'BulkOperationOutcome', title: 'BulkOperationOutcome' });

export const BulkResultSchema = z
  .strictObject({
    batchId: IdSchema.meta({ description: 'Groups the jobs this bulk call submitted.' }),
    jobId: IdSchema.optional().meta({ description: 'Set when the work was queued rather than done inline.' }),
    idempotencyKey: IdempotencyKeySchema.optional(),
    replayed: z
      .boolean()
      .meta({ description: 'True when this response is the stored result of an earlier identical call (IK2).' }),
    succeeded: CountSchema,
    failed: CountSchema,
    results: z.array(BulkOperationOutcomeSchema).max(BULK_MAX_OPERATIONS),
  })
  .meta({
    id: 'BulkResult',
    title: 'BulkResult',
    description: 'The outcome of a bulk write, per operation. Replaying the key returns this document unchanged.',
  });

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type BulkOperationOutcome = z.infer<typeof BulkOperationOutcomeSchema>;
export type BulkResult = z.infer<typeof BulkResultSchema>;
