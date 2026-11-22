/**
 * `/api/v1/reviews` — systematic reviews (CONCEPT §5.10, `spec/systematic-review.md` §7):
 * setup, search runs and their imports, deduplication, screening, full-text retrieval, the live
 * PRISMA 2020 counts and snapshots, extraction and risk of bias, and the exports R reads.
 */
import type { ExclusionReason, Recueil, RecordView, ReviewRow, ScreeningDecisionRow, SearchRunRow, UpdateReviewInput } from '@recueil/core';
import { NotFoundError, ROB_INSTRUMENTS, ValidationError } from '@recueil/core';
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import { extractionCsv, flowFromSnapshot, includedStudiesCsv, prismaCsv, prismaSvg, robvisCsv, screeningAuditCsv, storeAndImportSearchFile } from '@recueil/sr';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { idPath, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/reviews`;
const TAGS = ['Systematic reviews'] as const;
const READ = 'sr:read';
const WRITE = 'sr:write';

const ReasonSchema = z.strictObject({ code: z.string().regex(/^[a-z0-9_.-]{1,64}$/u), label: z.string().min(1).max(255), stage: z.enum(['title_abstract', 'full_text', 'any']) }).meta({ id: 'ExclusionReason' });

const ReviewSchema = z
  .object({
    id: z.string(),
    publicId: z.string(),
    title: z.string(),
    question: z.string().nullable(),
    protocol: z.record(z.string(), z.unknown()),
    registrationId: z.string().nullable(),
    registrationUrl: z.string().nullable(),
    status: z.string(),
    exclusionReasons: z.array(ReasonSchema),
    automationDisclosure: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Review', title: 'Review' });

const ReviewCreateSchema = z
  .strictObject({
    title: z.string().min(1).max(500),
    question: z.string().max(4000).nullish(),
    protocol: z.record(z.string(), z.unknown()).optional().meta({ description: 'PICO, eligibility criteria, planned analyses, deviations.' }),
    registrationId: z.string().max(255).nullish(),
    registrationUrl: z.string().max(2048).nullish(),
    exclusionReasons: z.array(ReasonSchema).max(100).optional(),
    automationDisclosure: z.boolean().optional().meta({ description: 'ADR-020: export which decisions were tool-assisted with the audit trail.' }),
  })
  .meta({ id: 'ReviewCreate', unusedIO: 'input' });

const ReviewUpdateSchema = ReviewCreateSchema.partial()
  .extend({ status: z.enum(['draft', 'searching', 'screening', 'full_text', 'extraction', 'analysis', 'complete', 'archived']).optional() })
  .meta({ id: 'ReviewUpdate', unusedIO: 'input' });

const SearchRunSchema = z
  .object({
    id: z.string(),
    sourceDatabase: z.string(),
    interface: z.string().nullable(),
    queryString: z.string(),
    queryTranslated: z.string().nullable(),
    filters: z.record(z.string(), z.unknown()),
    dateLimitFrom: z.string().nullable(),
    dateLimitTo: z.string().nullable(),
    executedAt: z.string(),
    recordsReturned: z.number().int().nullable(),
    recordsImported: z.number().int().nullable(),
    duplicatesRemoved: z.number().int().nullable(),
    sourceFileDocumentId: z.string().nullable(),
    rerunOfSearchRunId: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'SearchRun', title: 'SearchRun', description: 'One executed search, with what PRISMA-S asks to report.' });

const SearchRunCreateSchema = z
  .strictObject({
    sourceDatabase: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u).meta({ description: '`pubmed`, `embase`, `web_of_science`, `scopus`, `cochrane`, `registry`, `citation_search`, `manual`, …' }),
    interface: z.string().max(255).nullish(),
    queryString: z.string().min(1).max(100_000).meta({ description: 'Verbatim, in the syntax of the interface.' }),
    queryTranslated: z.string().max(100_000).nullish(),
    filters: z.record(z.string(), z.unknown()).optional(),
    dateLimitFrom: z.string().max(32).nullish(),
    dateLimitTo: z.string().max(32).nullish(),
    executedAt: z.string().max(40).optional(),
    recordsReturned: z.number().int().min(0).nullish().meta({ description: 'What the database reported; never recomputed (SR1).' }),
    rerunOfSearchRunId: IdSchema.nullish(),
    notes: z.string().max(10_000).nullish(),
  })
  .meta({ id: 'SearchRunCreate', unusedIO: 'input' });

const ImportBodySchema = z
  .strictObject({
    text: z.string().min(1).max(50_000_000).meta({ description: 'The export file as text: RIS, MEDLINE/NBIB, BibTeX or CSL-JSON.' }),
    format: z.enum(['ris', 'medline', 'bibtex', 'csl-json']).optional().meta({ description: 'Detected when omitted.' }),
    filename: z.string().max(255).optional(),
  })
  .meta({ id: 'SearchImport', unusedIO: 'input' });

const ImportSummarySchema = z
  .object({
    format: z.string(),
    parsed: z.number().int(),
    added: z.number().int(),
    sourceAdded: z.number().int(),
    repeated: z.number().int(),
    itemsCreated: z.number().int(),
    itemsReused: z.number().int(),
    failures: z.array(z.object({ index: z.number().int(), title: z.string().nullable(), reason: z.string() })),
    losses: z.number().int().meta({ description: 'Values the format carried that the contract could not.' }),
    returnedDiffers: z.boolean(),
    documentId: z.string(),
    searchRun: SearchRunSchema,
  })
  .meta({ id: 'SearchImportSummary' });

const DecisionSchema = z
  .object({
    id: z.string(),
    stage: z.string(),
    decision: z.string(),
    exclusionReasonCode: z.string().nullable(),
    exclusionReasonNote: z.string().nullable(),
    decidedAt: z.string(),
    screenerUserId: z.string(),
    isCurrent: z.boolean(),
    supersedesId: z.string().nullable(),
    toolAssisted: z.boolean(),
  })
  .meta({ id: 'ScreeningDecision', title: 'ScreeningDecision' });

const RecordSchema = z
  .object({
    id: z.string(),
    itemId: z.string(),
    stage: z.string(),
    dedupStatus: z.string(),
    duplicateOfId: z.string().nullable(),
    screeningStatus: z.string(),
    exclusionReasonCode: z.string().nullable(),
    retrievalStatus: z.string(),
    retrievalNote: z.string().nullable(),
    fullTextDocumentId: z.string().nullable(),
    extractionStatus: z.string(),
    isSnowballed: z.boolean(),
    studyGroupKey: z.string().nullable(),
    title: z.string().nullable(),
    abstract: z.string().nullable(),
    year: z.number().int().nullable(),
    venue: z.string().nullable(),
    doi: z.string().nullable(),
    pmid: z.string().nullable(),
    authors: z.array(z.string()),
    sources: z.array(z.string()),
    titleAbstract: DecisionSchema.nullable(),
    fullText: DecisionSchema.nullable(),
  })
  .meta({ id: 'ReviewRecord', title: 'ReviewRecord', description: 'One record considered in one review: the unit PRISMA counts.' });

const WorklistSchema = z.object({ total: z.number().int(), pending: z.number().int(), data: z.array(RecordSchema) }).meta({ id: 'ReviewWorklist' });

const DecideSchema = z
  .strictObject({
    stage: z.enum(['title_abstract', 'full_text']),
    decision: z.enum(['include', 'exclude', 'maybe']),
    reasonCode: z.string().max(64).nullish().meta({ description: 'One of the review’s exclusion reasons; required for a full-text exclusion.' }),
    reasonNote: z.string().max(4000).nullish(),
    durationMs: z.number().int().min(0).nullish(),
    toolDetail: z.record(z.string(), z.unknown()).nullish().meta({ description: 'What assisted. Kept only when the server classes the caller as a tool (SD2).' }),
  })
  .meta({ id: 'ScreeningDecide', unusedIO: 'input' });

const PrismaCellSchema = z
  .object({ stageKey: z.string(), count: z.number().int(), sourceLabel: z.string().nullable(), searchRunId: z.string().nullable(), exclusionReasonCode: z.string().nullable() })
  .meta({ id: 'PrismaCell' });

const PrismaSchema = z
  .object({
    cells: z.array(PrismaCellSchema),
    other: z.object({ identified: z.number().int(), sought: z.number().int(), notRetrieved: z.number().int(), assessed: z.number().int(), excluded: z.array(z.object({ code: z.string().nullable(), count: z.number().int() })), included: z.number().int() }),
  })
  .meta({ id: 'PrismaFlow', title: 'PrismaFlow', description: 'The PRISMA 2020 numbers, computed from the records (RR1).' });

const FormSchema = z
  .object({ id: z.string(), name: z.string(), version: z.number().int(), template: z.string().nullable(), status: z.string(), sections: z.array(z.unknown()), groups: z.array(z.unknown()) })
  .meta({ id: 'ExtractionForm', title: 'ExtractionForm' });

const FormFieldSchema = z.strictObject({ fieldKey: z.string().min(1).max(64), label: z.string().max(255).optional(), help: z.string().max(4000).optional(), required: z.boolean().optional(), group: z.string().max(32).optional() });
const FormDefinitionSchema = z.strictObject({
  sections: z.array(z.strictObject({ title: z.string().min(1).max(255), fields: z.array(FormFieldSchema).max(500) })).min(1).max(100),
  groups: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u), label: z.string().min(1).max(255) })).max(20).optional(),
});
const FormCreateSchema = z
  .union([
    z.strictObject({ template: z.enum(['rct', 'observational', 'diagnostic']), name: z.string().min(1).max(255).optional() }),
    FormDefinitionSchema.extend({ name: z.string().min(1).max(255) }),
  ])
  .meta({ id: 'ExtractionFormCreate', unusedIO: 'input', description: 'From a template, or a definition that references existing custom fields (EF1).' });

const ValueSchema = z
  .strictObject({
    formId: IdSchema,
    fieldKey: z.string().min(1).max(64),
    groupKey: z.string().max(100).nullish().meta({ description: '`outcome:mortality_30d` for a field in a repeatable group.' }),
    ordinal: z.number().int().min(0).optional(),
    content: z.record(z.string(), z.unknown()).nullish().meta({ description: 'A `FieldValueContent`, discriminated by `type`.' }),
    isBlank: z.boolean().optional().meta({ description: 'An explicit "not reported".' }),
  })
  .meta({ id: 'ExtractionValueWrite', unusedIO: 'input' });

const RobSchema = z
  .strictObject({
    tool: z.string().min(1).max(64),
    outcomeLabel: z.string().max(255).nullish(),
    armLabel: z.string().max(255).nullish(),
    signallingAnswers: z.record(z.string(), z.strictObject({ answer: z.string().max(16), support: z.string().max(10_000).optional(), quote: z.string().max(10_000).optional(), documentId: IdSchema.optional(), pageIndex: z.number().int().min(0).optional() })).optional(),
    domainJudgements: z.record(z.string(), z.strictObject({ judgement: z.string().max(32), rationale: z.string().max(10_000).optional() })),
    overallJudgement: z.string().max(32).nullish().meta({ description: 'Omitted: the instrument’s rule proposes one where it has a rule.' }),
    notes: z.string().max(10_000).nullish(),
  })
  .meta({ id: 'RobAssessmentWrite', unusedIO: 'input' });

const RobOutSchema = z
  .object({ id: z.string(), recordId: z.string(), tool: z.string(), toolVersion: z.string().nullable(), outcomeLabel: z.string().nullable(), domainJudgements: z.record(z.string(), z.unknown()), signallingAnswers: z.record(z.string(), z.unknown()), overallJudgement: z.string().nullable(), assessedAt: z.string(), isCurrent: z.boolean() })
  .meta({ id: 'RobAssessment', title: 'RobAssessment' });

const reviewToWire = (row: ReviewRow) => ({
  id: row.id,
  publicId: row.publicId,
  title: row.title,
  question: row.question,
  protocol: JSON.parse(row.protocol) as Record<string, unknown>,
  registrationId: row.registrationId,
  registrationUrl: row.registrationUrl,
  status: row.status,
  exclusionReasons: JSON.parse(row.exclusionReasons) as ExclusionReason[],
  automationDisclosure: row.automationDisclosure,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const runToWire = (row: SearchRunRow) => ({
  id: row.id,
  sourceDatabase: row.sourceDatabase,
  interface: row.interface,
  queryString: row.queryString,
  queryTranslated: row.queryTranslated,
  filters: JSON.parse(row.filters) as Record<string, unknown>,
  dateLimitFrom: row.dateLimitFrom,
  dateLimitTo: row.dateLimitTo,
  executedAt: row.executedAt,
  recordsReturned: row.recordsReturned,
  recordsImported: row.recordsImported,
  duplicatesRemoved: row.duplicatesRemoved,
  sourceFileDocumentId: row.sourceFileDocumentId,
  rerunOfSearchRunId: row.rerunOfSearchRunId,
  notes: row.notes,
});

const decisionToWire = (row: ScreeningDecisionRow | null) =>
  row === null
    ? null
    : {
        id: row.id,
        stage: row.stage,
        decision: row.decision,
        exclusionReasonCode: row.exclusionReasonCode,
        exclusionReasonNote: row.exclusionReasonNote,
        decidedAt: row.decidedAt,
        screenerUserId: row.screenerUserId,
        isCurrent: row.isCurrent,
        supersedesId: row.supersedesId,
        toolAssisted: row.toolAssisted,
      };

const recordToWire = (view: RecordView) => ({
  id: view.record.id,
  itemId: view.record.itemId,
  stage: view.record.stage,
  dedupStatus: view.record.dedupStatus,
  duplicateOfId: view.record.duplicateOfId,
  screeningStatus: view.record.screeningStatus,
  exclusionReasonCode: view.record.exclusionReasonCode,
  retrievalStatus: view.record.retrievalStatus,
  retrievalNote: view.record.retrievalNote,
  fullTextDocumentId: view.record.fullTextDocumentId,
  extractionStatus: view.record.extractionStatus,
  isSnowballed: view.record.isSnowballed,
  studyGroupKey: view.record.studyGroupKey,
  title: view.title,
  abstract: view.abstract,
  year: view.year,
  venue: view.venue,
  doi: view.doi,
  pmid: view.pmid,
  authors: view.authors,
  sources: view.sources,
  titleAbstract: decisionToWire(view.current.titleAbstract),
  fullText: decisionToWire(view.current.fullText),
});

const ReviewParams = z.object({ id: IdSchema });
const RecordParams = z.object({ id: IdSchema, recordId: IdSchema });
const RunParams = z.object({ id: IdSchema, runId: IdSchema });
const FormParams = z.object({ id: IdSchema, formId: IdSchema });

const WorklistQuery = z.object({
  stage: z.enum(['title_abstract', 'full_text']).optional().meta({ description: 'Default `title_abstract`.' }),
  status: z.enum(['pending', 'decided', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const SnapshotQuery = z.object({ snapshot: z.string().max(40).optional().meta({ description: 'A frozen snapshot’s `snapshotAt`; the live counts when omitted.' }) });
const ShapeQuery = z.object({ shape: z.enum(['long', 'wide']).optional() });
const ToolParams = z.object({ id: IdSchema, tool: z.string().regex(/^[a-z0-9_]{2,64}$/u) });

const reasonLabels = (recueil: Recueil, reviewId: string): Record<string, string> => Object.fromEntries(recueil.reviews.reasons(reviewId).map((reason) => [reason.code, reason.label]));

const csv = (filename: string) => ({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` });

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  /** A record of this review, or 404: a record id from another review is not found here. */
  const recordOf = (reviewId: string, recordId: string) => {
    const record = recueil.reviews.record(recordId);
    if (record.reviewId !== reviewId) throw new NotFoundError('review_record', recordId);
    return record;
  };

  app.get(BASE, { config: { scope: READ } }, async (_request, reply) => reply.send({ data: recueil.reviews.list().map(reviewToWire) }));

  app.post(BASE, { config: { scope: WRITE } }, async (request, reply) => {
    const body = parseOrThrow(ReviewCreateSchema, request.body, 'body');
    const created = recueil.reviews.create(
      {
        title: body.title,
        ...(body.question === undefined ? {} : { question: body.question }),
        ...(body.protocol === undefined ? {} : { protocol: body.protocol }),
        ...(body.registrationId === undefined ? {} : { registrationId: body.registrationId }),
        ...(body.registrationUrl === undefined ? {} : { registrationUrl: body.registrationUrl }),
        ...(body.exclusionReasons === undefined ? {} : { exclusionReasons: body.exclusionReasons }),
        ...(body.automationDisclosure === undefined ? {} : { automationDisclosure: body.automationDisclosure }),
      },
      request.actor,
    );
    return reply.code(201).header('location', `${BASE}/${created.id}`).send(reviewToWire(created));
  });

  app.get(`${BASE}/:id`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    return reply.send(reviewToWire(recueil.reviews.get(id)));
  });

  app.patch(`${BASE}/:id`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const body = parseOrThrow(ReviewUpdateSchema, request.body, 'body');
    const patch = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    return reply.send(reviewToWire(recueil.reviews.update(id, patch as UpdateReviewInput, request.actor)));
  });

  app.delete(`${BASE}/:id`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    recueil.reviews.trash(id, request.actor);
    return reply.code(204).send();
  });

  /* Search runs ------------------------------------------------------------------------------ */

  app.get(`${BASE}/:id/searches`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    recueil.reviews.get(id);
    return reply.send({ data: recueil.reviews.searchRuns(id).map(runToWire) });
  });

  app.post(`${BASE}/:id/searches`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const body = parseOrThrow(SearchRunCreateSchema, request.body, 'body');
    const run = recueil.reviews.addSearchRun(id, Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as typeof body, request.actor);
    return reply.code(201).send(runToWire(run));
  });

  app.delete(`${BASE}/:id/searches/:runId`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, runId } = parseOrThrow(RunParams, request.params, 'path');
    if (recueil.reviews.searchRun(runId).reviewId !== id) throw new NotFoundError('search_run', runId);
    recueil.reviews.deleteSearchRun(runId, request.actor);
    return reply.code(204).send();
  });

  app.post(`${BASE}/:id/searches/:runId/import`, { config: { scope: WRITE }, bodyLimit: 60 * 1024 * 1024 }, async (request, reply) => {
    const { id, runId } = parseOrThrow(RunParams, request.params, 'path');
    const body = parseOrThrow(ImportBodySchema, request.body, 'body');
    if (recueil.reviews.searchRun(runId).reviewId !== id) throw new NotFoundError('search_run', runId);
    const summary = await storeAndImportSearchFile(recueil, runId, body.text, {
      actor: request.actor,
      ...(body.format === undefined ? {} : { format: body.format }),
      ...(body.filename === undefined ? {} : { filename: body.filename }),
    });
    return reply.send({ ...summary, losses: summary.losses.length, searchRun: runToWire(recueil.reviews.searchRun(runId)) });
  });

  /* Records, dedup and screening ------------------------------------------------------------- */

  app.post(`${BASE}/:id/dedup`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ dryRun: z.boolean().optional(), threshold: z.number().min(0.5).max(1).optional() }), request.body ?? {}, 'body');
    return reply.send(recueil.reviews.dedup(id, request.actor, { ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }), ...(body.threshold === undefined ? {} : { threshold: body.threshold }) }));
  });

  app.get(`${BASE}/:id/records`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const query = parseOrThrow(WorklistQuery, coerceQuery(request.query), 'query');
    const list = recueil.reviews.worklist(id, query.stage ?? 'title_abstract', {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return reply.send({ total: list.total, pending: list.pending, data: list.records.map(recordToWire) });
  });

  app.get(`${BASE}/:id/records/:recordId`, { config: { scope: READ } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    recordOf(id, recordId);
    return reply.send({ ...recordToWire(recueil.reviews.view(recordId)), decisions: recueil.reviews.decisions(recordId).map(decisionToWire) });
  });

  app.post(`${BASE}/:id/records/:recordId/decisions`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(DecideSchema, request.body, 'body');
    recordOf(id, recordId);
    recueil.reviews.decide(
      recordId,
      {
        stage: body.stage,
        decision: body.decision,
        ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
        ...(body.reasonNote === undefined ? {} : { reasonNote: body.reasonNote }),
        ...(body.durationMs === undefined ? {} : { durationMs: body.durationMs }),
        ...(body.toolDetail === undefined ? {} : { toolDetail: body.toolDetail }),
      },
      request.actor,
    );
    return reply.code(201).send(recordToWire(recueil.reviews.view(recordId)));
  });

  app.post(`${BASE}/:id/records/:recordId/undo`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ stage: z.enum(['title_abstract', 'full_text']) }), request.body, 'body');
    recordOf(id, recordId);
    recueil.reviews.undo(recordId, body.stage, request.actor);
    return reply.send(recordToWire(recueil.reviews.view(recordId)));
  });

  app.put(`${BASE}/:id/records/:recordId/retrieval`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ status: z.enum(['not_attempted', 'sought', 'retrieved', 'not_retrieved']), note: z.string().max(4000).nullish(), documentId: IdSchema.nullish() }), request.body, 'body');
    recordOf(id, recordId);
    recueil.reviews.setRetrieval(recordId, { status: body.status, ...(body.note === undefined ? {} : { note: body.note }), ...(body.documentId === undefined ? {} : { documentId: body.documentId }) }, request.actor);
    return reply.send(recordToWire(recueil.reviews.view(recordId)));
  });

  app.put(`${BASE}/:id/records/:recordId/duplicate`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ duplicateOfId: IdSchema.nullable() }), request.body, 'body');
    recordOf(id, recordId);
    if (body.duplicateOfId === null) recueil.reviews.undoDuplicate(recordId, request.actor);
    else recueil.reviews.markDuplicate(recordId, body.duplicateOfId, request.actor);
    return reply.send(recordToWire(recueil.reviews.view(recordId)));
  });

  app.put(`${BASE}/:id/records/:recordId/study-group`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ key: z.string().max(255).nullable() }), request.body, 'body');
    recordOf(id, recordId);
    recueil.reviews.setStudyGroup(recordId, body.key, request.actor);
    return reply.send(recordToWire(recueil.reviews.view(recordId)));
  });

  /* PRISMA ----------------------------------------------------------------------------------- */

  const flowFor = (id: string, snapshot: string | undefined) => (snapshot === undefined ? recueil.reviews.prisma(id) : flowFromSnapshot(recueil.reviews.snapshot(id, snapshot)));

  app.get(`${BASE}/:id/prisma`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const { snapshot } = parseOrThrow(SnapshotQuery, coerceQuery(request.query), 'query');
    return reply.send(flowFor(id, snapshot));
  });

  app.get(`${BASE}/:id/prisma.csv`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const { snapshot } = parseOrThrow(SnapshotQuery, coerceQuery(request.query), 'query');
    return reply.headers(csv('prisma.csv')).send(prismaCsv(flowFor(id, snapshot), reasonLabels(recueil, id)));
  });

  app.get(`${BASE}/:id/prisma.svg`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const { snapshot } = parseOrThrow(SnapshotQuery, coerceQuery(request.query), 'query');
    return reply.header('content-type', 'image/svg+xml; charset=utf-8').send(prismaSvg(flowFor(id, snapshot), recueil.reviews.get(id).title, reasonLabels(recueil, id)));
  });

  app.get(`${BASE}/:id/prisma/snapshots`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    recueil.reviews.get(id);
    return reply.send({ data: recueil.reviews.snapshots(id) });
  });

  app.post(`${BASE}/:id/prisma/snapshots`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const body = parseOrThrow(z.strictObject({ label: z.string().max(255).nullish() }), request.body ?? {}, 'body');
    return reply.code(201).send(recueil.reviews.freezePrisma(id, body.label ?? null, request.actor));
  });

  /* Extraction ------------------------------------------------------------------------------- */

  const formToWire = (form: ReturnType<Recueil['extraction']['form']>) => {
    const definition = recueil.extraction.definition(form);
    return { id: form.id, name: form.name, version: form.version, template: form.template, status: form.status, sections: definition.sections, groups: definition.groups ?? [] };
  };

  app.get(`${BASE}/:id/forms`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    recueil.reviews.get(id);
    return reply.send({ data: recueil.extraction.forms(id).map(formToWire) });
  });

  app.post(`${BASE}/:id/forms`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const body = parseOrThrow(FormCreateSchema, request.body, 'body');
    const form =
      'template' in body
        ? recueil.extraction.createFromTemplate(id, body.template, request.actor, body.name)
        : recueil.extraction.createForm(id, { name: body.name, sections: body.sections, ...(body.groups === undefined ? {} : { groups: body.groups }) }, request.actor);
    return reply.code(201).send(formToWire(form));
  });

  app.put(`${BASE}/:id/forms/:formId`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, formId } = parseOrThrow(FormParams, request.params, 'path');
    const body = parseOrThrow(FormDefinitionSchema, request.body, 'body');
    if (recueil.extraction.form(formId).reviewId !== id) throw new NotFoundError('extraction_form', formId);
    return reply.send(formToWire(recueil.extraction.updateForm(formId, { sections: body.sections, ...(body.groups === undefined ? {} : { groups: body.groups }) }, request.actor)));
  });

  app.get(`${BASE}/:id/records/:recordId/values`, { config: { scope: READ } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    recordOf(id, recordId);
    return reply.send({
      data: recueil.extraction.values(recordId).map((value) => ({ fieldKey: value.field.fieldKey, groupKey: value.row.groupKey, ordinal: value.row.ordinal, formId: value.row.extractionFormId, content: value.content, isBlank: value.row.isBlank })),
    });
  });

  app.put(`${BASE}/:id/records/:recordId/values`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(ValueSchema, request.body, 'body');
    recordOf(id, recordId);
    const value = recueil.extraction.setValue(
      recordId,
      body.formId,
      {
        fieldKey: body.fieldKey,
        ...(body.groupKey === undefined ? {} : { groupKey: body.groupKey }),
        ...(body.ordinal === undefined ? {} : { ordinal: body.ordinal }),
        ...(body.content == null ? {} : { content: body.content as never }),
        ...(body.isBlank === undefined ? {} : { isBlank: body.isBlank }),
      },
      request.actor,
    );
    return reply.send({ fieldKey: value.field.fieldKey, groupKey: value.row.groupKey, ordinal: value.row.ordinal, formId: value.row.extractionFormId, content: value.content, isBlank: value.row.isBlank });
  });

  app.post(`${BASE}/:id/records/:recordId/extraction/complete`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    recordOf(id, recordId);
    recueil.extraction.complete(recordId, request.actor);
    return reply.send(recordToWire(recueil.reviews.view(recordId)));
  });

  app.get(`${BASE}/:id/extraction.csv`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const { shape } = parseOrThrow(ShapeQuery, coerceQuery(request.query), 'query');
    return reply.headers(csv(`extraction-${shape ?? 'long'}.csv`)).send(extractionCsv(recueil, id, shape ?? 'long'));
  });

  app.get(`${BASE}/:id/included.csv`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    recueil.reviews.get(id);
    return reply.headers(csv('included.csv')).send(includedStudiesCsv(recueil, id));
  });

  app.get(`${BASE}/:id/audit.csv`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    return reply.headers(csv('screening-audit.csv')).send(screeningAuditCsv(recueil, id));
  });

  /* Risk of bias ----------------------------------------------------------------------------- */

  const robToWire = (row: ReturnType<Recueil['extraction']['assess']>) => ({
    id: row.id,
    recordId: row.reviewRecordId,
    tool: row.tool,
    toolVersion: row.toolVersion,
    outcomeLabel: row.outcomeLabel,
    domainJudgements: JSON.parse(row.domainJudgements) as Record<string, unknown>,
    signallingAnswers: JSON.parse(row.signallingAnswers) as Record<string, unknown>,
    overallJudgement: row.overallJudgement,
    assessedAt: row.assessedAt,
    isCurrent: row.isCurrent,
  });

  app.get(`${API_BASE_PATH}/sr/instruments`, { config: { scope: READ } }, async (_request, reply) => reply.send({ data: Object.values(ROB_INSTRUMENTS) }));

  app.post(`${BASE}/:id/records/:recordId/rob`, { config: { scope: WRITE } }, async (request, reply) => {
    const { id, recordId } = parseOrThrow(RecordParams, request.params, 'path');
    const body = parseOrThrow(RobSchema, request.body, 'body');
    recordOf(id, recordId);
    const row = recueil.extraction.assess(
      recordId,
      {
        tool: body.tool,
        domainJudgements: body.domainJudgements,
        ...(body.outcomeLabel === undefined ? {} : { outcomeLabel: body.outcomeLabel }),
        ...(body.armLabel === undefined ? {} : { armLabel: body.armLabel }),
        ...(body.signallingAnswers === undefined ? {} : { signallingAnswers: body.signallingAnswers }),
        ...(body.overallJudgement === undefined ? {} : { overallJudgement: body.overallJudgement }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
      },
      request.actor,
    );
    return reply.code(201).send(robToWire(row));
  });

  app.get(`${BASE}/:id/rob`, { config: { scope: READ } }, async (request, reply) => {
    const { id } = parseOrThrow(ReviewParams, request.params, 'path');
    const query = parseOrThrow(z.object({ tool: z.string().max(64).optional() }), coerceQuery(request.query), 'query');
    recueil.reviews.get(id);
    return reply.send({ data: recueil.extraction.assessments(id, query.tool === undefined ? {} : { tool: query.tool }).map(robToWire) });
  });

  app.get(`${BASE}/:id/rob/:tool/robvis.csv`, { config: { scope: READ } }, async (request, reply) => {
    const { id, tool } = parseOrThrow(ToolParams, request.params, 'path');
    recueil.reviews.get(id);
    if (ROB_INSTRUMENTS[tool] === undefined) throw new ValidationError(`Unknown risk-of-bias tool '${tool}'.`);
    return reply.headers(csv(`robvis-${tool}.csv`)).send(robvisCsv(recueil, id, tool));
  });
};

/* -------------------------------------------------------------------------------------------- */
/* OpenAPI                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const recordPath = () => ({ path: RecordParams });
const csvResponse = (description: string) => ({ '200': { description, content: { 'text/csv': { schema: z.string() } } }, ...problems('401', '403', '404', '422') });
const op = (input: Omit<Parameters<typeof operation>[0], 'tags'>) => operation({ ...input, tags: TAGS });

export const reviewPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: op({ operationId: 'listReviews', summary: 'List reviews', description: 'Newest first.', scope: READ, responses: { '200': jsonResponse('The reviews.', z.object({ data: z.array(ReviewSchema) })), ...problems('401', '403') } }),
    post: op({ operationId: 'createReview', summary: 'Create a review', description: 'Protocol, registration, the ordered exclusion reasons and the automation disclosure setting.', scope: WRITE, requestBody: jsonBody(ReviewCreateSchema), responses: { '201': jsonResponse('The review.', ReviewSchema), ...problems('400', '401', '403', '422') } }),
  },
  [`${BASE}/{id}`]: {
    get: op({ operationId: 'getReview', summary: 'A review', description: 'Its setup.', scope: READ, requestParams: { path: idPath() }, responses: { '200': jsonResponse('The review.', ReviewSchema), ...problems('401', '403', '404') } }),
    patch: op({ operationId: 'updateReview', summary: 'Update a review', description: 'A reason that decisions use cannot be removed (409).', scope: WRITE, requestParams: { path: idPath() }, requestBody: jsonBody(ReviewUpdateSchema), responses: { '200': jsonResponse('The review.', ReviewSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
    delete: op({ operationId: 'trashReview', summary: 'Trash a review', description: 'The library items it holds are untouched.', scope: WRITE, requestParams: { path: idPath() }, responses: { '204': { description: 'Trashed.' }, ...problems('401', '403', '404') } }),
  },
  [`${BASE}/{id}/searches`]: {
    get: op({ operationId: 'listSearchRuns', summary: 'Search runs', description: 'In the order they were executed.', scope: READ, requestParams: { path: idPath() }, responses: { '200': jsonResponse('The runs.', z.object({ data: z.array(SearchRunSchema) })), ...problems('401', '403', '404') } }),
    post: op({ operationId: 'createSearchRun', summary: 'Record a search run', description: 'Database, interface, verbatim query, limits and the number the database reported (PRISMA-S).', scope: WRITE, requestParams: { path: idPath() }, requestBody: jsonBody(SearchRunCreateSchema), responses: { '201': jsonResponse('The run.', SearchRunSchema), ...problems('400', '401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/searches/{runId}`]: {
    delete: op({ operationId: 'deleteSearchRun', summary: 'Delete a search run', description: 'Refused once records are attributed to it (SR2).', scope: WRITE, requestParams: { path: RunParams }, responses: { '204': { description: 'Deleted.' }, ...problems('401', '403', '404', '409') } }),
  },
  [`${BASE}/{id}/searches/{runId}/import`]: {
    post: op({ operationId: 'importSearchRun', summary: 'Import a search export', description: 'Keeps the file as a document (P10), matches items by DOI and PMID, and adds a second source to records another search already found.', scope: WRITE, requestParams: { path: RunParams }, requestBody: jsonBody(ImportBodySchema), responses: { '200': jsonResponse('What arrived.', ImportSummarySchema), ...problems('400', '401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/dedup`]: {
    post: op({ operationId: 'dedupReview', summary: 'Find duplicates within the review', description: 'Near-identical title, year within one, compatible first author. Duplicates are marked, never deleted (RR3).', scope: WRITE, requestParams: { path: idPath() }, requestBody: jsonBody(z.object({ dryRun: z.boolean().optional(), threshold: z.number().optional() }).meta({ id: 'ReviewDedup', unusedIO: 'input' })), responses: { '200': jsonResponse('The pairs.', z.object({ pairs: z.array(z.object({ duplicateId: z.string(), masterId: z.string(), similarity: z.number() })) })), ...problems('401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/records`]: {
    get: op({ operationId: 'listReviewRecords', summary: 'The screening worklist', description: 'Unique records for a stage, pending first; full text lists records that passed title/abstract.', scope: READ, requestParams: { path: idPath(), query: WorklistQuery }, responses: { '200': jsonResponse('The worklist.', WorklistSchema), ...problems('401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}`]: {
    get: op({ operationId: 'getReviewRecord', summary: 'A record', description: 'With its sources and every decision, oldest first.', scope: READ, requestParams: recordPath(), responses: { '200': jsonResponse('The record.', RecordSchema.extend({ decisions: z.array(DecisionSchema) })), ...problems('401', '403', '404') } }),
  },
  [`${BASE}/{id}/records/{recordId}/decisions`]: {
    post: op({ operationId: 'decideReviewRecord', summary: 'Record a screening decision', description: 'Append-only; a change supersedes the current decision (SD1). A full-text exclusion needs a reason.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(DecideSchema), responses: { '201': jsonResponse('The record after the decision.', RecordSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/undo`]: {
    post: op({ operationId: 'undoReviewDecision', summary: 'Undo the current decision of a stage', description: 'Restores the previous decision as a new row.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(z.object({ stage: z.enum(['title_abstract', 'full_text']) }).meta({ id: 'ScreeningUndo', unusedIO: 'input' })), responses: { '200': jsonResponse('The record.', RecordSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/retrieval`]: {
    put: op({ operationId: 'setReviewRetrieval', summary: 'Full-text retrieval status', description: 'The PRISMA "sought / not retrieved" pair.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(z.object({ status: z.string(), note: z.string().nullish(), documentId: z.string().nullish() }).meta({ id: 'ReviewRetrieval', unusedIO: 'input' })), responses: { '200': jsonResponse('The record.', RecordSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/duplicate`]: {
    put: op({ operationId: 'setReviewDuplicate', summary: 'Mark or unmark a duplicate', description: '`duplicateOfId: null` reverses a wrong call.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(z.object({ duplicateOfId: z.string().nullable() }).meta({ id: 'ReviewDuplicate', unusedIO: 'input' })), responses: { '200': jsonResponse('The record.', RecordSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/study-group`]: {
    put: op({ operationId: 'setReviewStudyGroup', summary: 'Group reports of one study', description: 'PRISMA counts studies and reports separately.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(z.object({ key: z.string().nullable() }).meta({ id: 'ReviewStudyGroup', unusedIO: 'input' })), responses: { '200': jsonResponse('The record.', RecordSchema), ...problems('400', '401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/prisma`]: {
    get: op({ operationId: 'getReviewPrisma', summary: 'PRISMA 2020 counts', description: 'Live, or a frozen snapshot.', scope: READ, requestParams: { path: idPath(), query: SnapshotQuery }, responses: { '200': jsonResponse('The flow.', PrismaSchema), ...problems('401', '403', '404') } }),
  },
  [`${BASE}/{id}/prisma.csv`]: {
    get: op({ operationId: 'exportReviewPrisma', summary: 'PRISMA counts for the PRISMA2020 R package', description: '`data,n` keyed by the names of the package’s template CSV.', scope: READ, requestParams: { path: idPath(), query: SnapshotQuery }, responses: csvResponse('The counts.') }),
  },
  [`${BASE}/{id}/prisma.svg`]: {
    get: op({ operationId: 'drawReviewPrisma', summary: 'A draft PRISMA flow diagram', description: 'For a quick look; publication diagrams come from PRISMA2020.', scope: READ, requestParams: { path: idPath(), query: SnapshotQuery }, responses: { '200': { description: 'SVG.', content: { 'image/svg+xml': { schema: z.string() } } }, ...problems('401', '403', '404') } }),
  },
  [`${BASE}/{id}/prisma/snapshots`]: {
    get: op({ operationId: 'listPrismaSnapshots', summary: 'Frozen PRISMA snapshots', description: 'Oldest first.', scope: READ, requestParams: { path: idPath() }, responses: { '200': jsonResponse('The snapshots.', z.object({ data: z.array(z.object({ snapshotAt: z.string(), label: z.string().nullable() })) })), ...problems('401', '403', '404') } }),
    post: op({ operationId: 'freezePrisma', summary: 'Freeze the PRISMA counts', description: 'The numbers printed in a manuscript, reproducible later (PC1).', scope: WRITE, requestParams: { path: idPath() }, requestBody: jsonBody(z.object({ label: z.string().nullish() }).meta({ id: 'PrismaFreeze', unusedIO: 'input' })), responses: { '201': jsonResponse('The snapshot.', z.object({ snapshotAt: z.string(), cells: z.array(PrismaCellSchema) })), ...problems('401', '403', '404', '422') } }),
  },
  [`${BASE}/{id}/forms`]: {
    get: op({ operationId: 'listExtractionForms', summary: 'Extraction forms', description: 'Every version.', scope: READ, requestParams: { path: idPath() }, responses: { '200': jsonResponse('The forms.', z.object({ data: z.array(FormSchema) })), ...problems('401', '403', '404') } }),
    post: op({ operationId: 'createExtractionForm', summary: 'Create an extraction form', description: 'From a template, which creates the review-scoped fields it needs, or from a definition (EF1).', scope: WRITE, requestParams: { path: idPath() }, requestBody: jsonBody(FormCreateSchema), responses: { '201': jsonResponse('The form.', FormSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/forms/{formId}`]: {
    put: op({ operationId: 'updateExtractionForm', summary: 'Change a form', description: 'A locked form becomes a new version; values keep the version they were entered under (EF2).', scope: WRITE, requestParams: { path: FormParams }, requestBody: jsonBody(FormDefinitionSchema.meta({ id: 'ExtractionFormDefinition', unusedIO: 'input' })), responses: { '200': jsonResponse('The form.', FormSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/values`]: {
    get: op({ operationId: 'listExtractionValues', summary: 'Extracted values of a record', description: 'This review’s values only.', scope: READ, requestParams: recordPath(), responses: { '200': jsonResponse('The values.', z.object({ data: z.array(z.record(z.string(), z.unknown())) })), ...problems('401', '403', '404') } }),
    put: op({ operationId: 'writeExtractionValue', summary: 'Write one extracted value', description: 'Included studies only; a field in a repeatable group needs its group key.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(ValueSchema), responses: { '200': jsonResponse('The value.', z.record(z.string(), z.unknown())), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/records/{recordId}/extraction/complete`]: {
    post: op({ operationId: 'completeExtraction', summary: 'Complete a record’s extraction', description: 'Checks required fields and locks the forms used (EF2).', scope: WRITE, requestParams: recordPath(), responses: { '200': jsonResponse('The record.', RecordSchema), ...problems('401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/extraction.csv`]: {
    get: op({ operationId: 'exportExtraction', summary: 'Extraction data', description: '`long`: one row per value. `wide`: one row per study and group, field keys as columns (the `metafor::escalc()` shape).', scope: READ, requestParams: { path: idPath(), query: ShapeQuery }, responses: csvResponse('The table.') }),
  },
  [`${BASE}/{id}/included.csv`]: {
    get: op({ operationId: 'exportIncludedStudies', summary: 'Included studies', description: 'Study label, bibliographic core and extraction status.', scope: READ, requestParams: { path: idPath() }, responses: csvResponse('The table.') }),
  },
  [`${BASE}/{id}/audit.csv`]: {
    get: op({ operationId: 'exportScreeningAudit', summary: 'The screening audit trail', description: 'Every decision; with automation disclosure on, which were tool-assisted (ADR-020).', scope: READ, requestParams: { path: idPath() }, responses: csvResponse('The decisions.') }),
  },
  [`${API_BASE_PATH}/sr/instruments`]: {
    get: op({ operationId: 'listRobInstruments', summary: 'Risk-of-bias instruments', description: 'RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa: domains, signalling questions, levels.', scope: READ, responses: { '200': jsonResponse('The instruments.', z.object({ data: z.array(z.record(z.string(), z.unknown())) })), ...problems('401', '403') } }),
  },
  [`${BASE}/{id}/records/{recordId}/rob`]: {
    post: op({ operationId: 'assessRiskOfBias', summary: 'Assess risk of bias', description: 'Supersedes the current assessment for the same tool and outcome. The overall judgement is proposed by the instrument’s rule when omitted.', scope: WRITE, requestParams: recordPath(), requestBody: jsonBody(RobSchema), responses: { '201': jsonResponse('The assessment.', RobOutSchema), ...problems('400', '401', '403', '404', '409', '422') } }),
  },
  [`${BASE}/{id}/rob`]: {
    get: op({ operationId: 'listRiskOfBias', summary: 'Current risk-of-bias assessments', description: 'Optionally one tool.', scope: READ, requestParams: { path: idPath(), query: z.object({ tool: z.string().optional() }) }, responses: { '200': jsonResponse('The assessments.', z.object({ data: z.array(RobOutSchema) })), ...problems('401', '403', '404') } }),
  },
  [`${BASE}/{id}/rob/{tool}/robvis.csv`]: {
    get: op({ operationId: 'exportRobvis', summary: 'robvis input', description: '`Study, D1 … Dn, Overall, Weight` with robvis’s labels (RB1).', scope: READ, requestParams: { path: ToolParams }, responses: csvResponse('The table.') }),
  },
};

