/**
 * `/api/v1/ingestion/queue` — the pipeline's work queue.
 *
 * A job here is one of two things, and the detail view says which. An `ingest.source` job is one
 * poll of one configured source: the unit an operator asked for, and the unit they can cancel. An
 * `ingest.run` job is the pipeline's own record of a batch of candidates, minted by `claimRun`, and
 * it is the row that carries the stage checkpoints. A source poll that offered something has the
 * pipeline run as its child (`parent_job_id`, §6.3).
 *
 * **Retry resumes; it does not start over.** The job keeps its idempotency key, so the pipeline's
 * journal skips every candidate that already committed and picks up at the first stage that never
 * finished (IK4). That is the difference between re-running a twenty-minute OCR pass and not.
 *
 * **Cancel is honest about reach.** A run this process is executing gets its `AbortController`
 * aborted and closes its own job row. A row left `running` by a process that died has no signal to
 * deliver, so it is closed here and the audit says which of the two happened. Answering "cancelled"
 * for both would tell an operator their scanner import had stopped when it had not.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { pageInfo, resolvePageParams, sendJson } from '../http.js';
import { jobLogToWire, jobToWire } from '../ingestion/queue.js';
import { SOURCE_JOB_TYPE } from '../ingestion/runner.js';
import {
  idPath,
  jsonBody,
  jsonResponse,
  operation,
  pageQuery,
  problems,
} from '../openapi-kit.js';
import { ApiError } from '../problem.js';
import {
  IngestionJobDetailSchema,
  IngestionJobPageSchema,
  IngestionJobSchema,
  JobCancelRequestSchema,
  JobRetryRequestSchema,
  JobStateSchema,
} from '../schemas-ingestion.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/ingestion/queue`;

const QUEUE_TAGS = ['Ingestion'] as const;

const ListQueueQuerySchema = z.strictObject({
  ...pageQuery,
  state: JobStateSchema.optional(),
  jobType: z.enum(['ingest.source', 'ingest.run']).optional(),
  sourceId: IdSchema.optional().meta({ description: 'Only runs of this configured source.' }),
});

export const ingestionQueueRoutes: FastifyPluginAsync = async (app) => {
  const { ingestion } = app.recueil;

  app.get(BASE, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListQueueQuerySchema, coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);

    const result = ingestion.queue.list({
      limit: page.limit,
      order: page.order,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.jobType === undefined ? {} : { jobType: query.jobType }),
      ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
    });

    return sendJson(reply, IngestionJobPageSchema, {
      data: result.rows.map(jobToWire),
      page: pageInfo({
        nextCursor: result.nextCursor,
        hasMore: result.nextCursor !== null,
        limit: page.limit,
      }),
    });
  });

  app.get(`${BASE}/:id`, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const job = ingestion.queue.get(id);

    // The stage trace belongs to the pipeline run. Asked for a source job, follow the child so that
    // a caller who has only the id they were handed by `POST /sources/{id}/run` still gets it.
    const children = ingestion.queue.children(id);
    const traceJobId = children[0]?.id ?? id;

    return sendJson(reply, IngestionJobDetailSchema, {
      job: jobToWire(job),
      stages: ingestion.queue.stageTrace(traceJobId),
      log: [...ingestion.queue.logs(id), ...children.flatMap((child) => ingestion.queue.logs(child.id))]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(jobLogToWire),
      reviewEntryIds: [
        ...ingestion.queue.reviewEntryIds(id),
        ...children.flatMap((child) => ingestion.queue.reviewEntryIds(child.id)),
      ],
    });
  });

  app.post(`${BASE}/:id/retry`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(JobRetryRequestSchema, request.body ?? {}, 'body');
    const job = ingestion.queue.get(id);

    const retryable = ingestion.queue.retryability(job);
    if (!retryable.ok) {
      throw new ApiError(
        'https://recueil.org/problems/conflict',
        409,
        'Conflict',
        retryable.detail,
      );
    }

    // A source poll is retried by polling again under the same label, which resumes rather than
    // restarts. A bare pipeline run has no source to poll — it was an upload — so the row is
    // requeued and the caller is told so in the job's log rather than being promised a re-run this
    // server has no way to start.
    if (job.jobType === SOURCE_JOB_TYPE) {
      const params = job.params === null ? {} : (JSON.parse(job.params) as Record<string, unknown>);
      const sourceId = typeof params['sourceId'] === 'string' ? params['sourceId'] : null;
      const runLabel = typeof params['runLabel'] === 'string' ? params['runLabel'] : undefined;
      if (sourceId === null) {
        throw new ApiError(
          'https://recueil.org/problems/conflict',
          409,
          'Conflict',
          'This job does not name a source, so there is nothing to poll again.',
        );
      }

      // The audit line goes down now; the state transition belongs to the runner, which refuses a
      // source that already has a run in flight and would refuse this one if it had been requeued
      // first.
      ingestion.queue.auditRetry(id, request.actor, body.reason);
      const started = await ingestion.runner.startSourceRun(sourceId, {
        actor: request.actor,
        ...(runLabel === undefined ? {} : { runLabel }),
      });
      return sendJson(reply, IngestionJobSchema, jobToWire(ingestion.queue.get(started.jobId)), 202);
    }

    const requeued = ingestion.queue.markQueued(id, request.actor, body.reason);
    ingestion.runner.writeJobLog(
      id,
      'info',
      'the job was requeued by an operator. It was not started by a configured source, so nothing ' +
        'polls it: re-upload the file, or run the source that produced it.',
    );
    return sendJson(reply, IngestionJobSchema, jobToWire(requeued), 202);
  });

  app.post(`${BASE}/:id/cancel`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(JobCancelRequestSchema, request.body ?? {}, 'body');
    const job = ingestion.queue.get(id);

    if (job.state !== 'running' && job.state !== 'queued') {
      throw new ApiError(
        'https://recueil.org/problems/conflict',
        409,
        'Conflict',
        `The job is ${job.state} and has already finished. There is nothing to cancel.`,
      );
    }

    // Delivered to the running pipeline where we can reach it. The run closes its own row when the
    // abort lands, so this responds with the row as it stands and the state follows.
    const delivered = ingestion.runner.cancel(id, request.actor);
    if (!delivered) {
      const cancelled = ingestion.queue.markCancelled(id, request.actor, body.reason);
      return sendJson(reply, IngestionJobSchema, jobToWire(cancelled));
    }

    return sendJson(reply, IngestionJobSchema, jobToWire(ingestion.queue.get(id)), 202);
  });
};

export const ingestionQueuePaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listIngestionJobs',
      summary: 'The ingestion work queue',
      description:
        'Cursor-paged over the `jobs` rows this surface owns: `ingest.source` (one poll of one ' +
        'configured source) and `ingest.run` (the pipeline\'s own batch record). The cursor is the ' +
        'job id, which is a ULID, so a run inserting rows while you page cannot make one appear ' +
        'twice or not at all.\n\n' +
        '`waiting_review` is not a failure (IK6): the run produced review-queue entries and a person ' +
        'owes them a decision.',
      tags: QUEUE_TAGS,
      scope: 'ingestion:read',
      requestParams: { query: ListQueueQuerySchema },
      responses: {
        '200': jsonResponse('A page of jobs.', IngestionJobPageSchema),
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getIngestionJob',
      summary: 'One job, with its stage trace',
      description:
        'The job row, the stage checkpoints, the log and the review entries the run raised.\n\n' +
        '`stages` comes from `ingest_checkpoints` — the rows a *resumed* run reads to decide where ' +
        'to start — rather than from the run\'s narration, so the trace and the resume point cannot ' +
        'disagree. A finished candidate shows one `commit` row, because the pipeline compacts the ' +
        'intermediate ones once it commits; a candidate that stopped halfway shows where.\n\n' +
        '`reviewEntryIds` is queried from `review_queue` by job id, not read out of the run\'s ' +
        'result summary, so the two can be compared.',
      tags: QUEUE_TAGS,
      scope: 'ingestion:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The job and its trace.', IngestionJobDetailSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/retry`]: {
    post: operation({
      operationId: 'retryIngestionJob',
      summary: 'Run a finished job again',
      description:
        'Resumes rather than restarts: the job keeps its idempotency key, so the pipeline skips ' +
        'every candidate that already committed and picks up at the first stage that never ' +
        'finished (IK4). A running or queued job is refused with a 409 — cancel it first.',
      tags: QUEUE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: JobRetryRequestSchema } },
      },
      responses: {
        '202': jsonResponse('The job, as it now stands.', IngestionJobSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/cancel`]: {
    post: operation({
      operationId: 'cancelIngestionJob',
      summary: 'Stop a run',
      description:
        'A run this process is executing is aborted between candidates and inside its retry loop, ' +
        'and closes its own row: the response is 202 and the state follows within a moment. A row ' +
        'left `running` by a process that died has no signal to deliver, so it is closed here and ' +
        'the response is 200. Nothing already committed is undone — an ingest that reached stage 10 ' +
        'is a document in the library (P5).',
      tags: QUEUE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: JobCancelRequestSchema } },
      },
      responses: {
        '200': jsonResponse('The job was closed here; no run was reachable.', IngestionJobSchema),
        '202': jsonResponse('The abort was delivered to a run in flight.', IngestionJobSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
