/**
 * `/api/v1/rules` — the ingestion and dedup rule table, and the dry run.
 *
 * `spec/data-model.md` O2 leaves open whether rules are a table or a file and recommends "a table,
 * with import/export to YAML". This is that table, one row per rule, each holding one
 * `@recueil/rules` rule in the engine's own format — so the document the API validated, the row in
 * the table and the value the engine evaluates are the same value.
 *
 * **The dry run changes nothing, structurally.** `evaluateRules` is a pure function from a rule set
 * and a plain subject to a plain outcome: it is handed no database, no storage and no HTTP client,
 * so there is no apply path this endpoint has to remember to switch off. That is why the dry run is
 * a prediction worth having rather than a promise.
 *
 * **A dry run can run rules that are not stored.** The whole point is to answer "what would this
 * do" before saving it, so `rules` in the request body replaces the stored set for that call.
 *
 * **Stored rules really run.** The pipeline is given the stored ingestion set through
 * `StoredRuleEvaluator` (`ingestion/rules-store.ts`), so what a dry run predicts is what an upload
 * or a source poll will do — not a parallel implementation that happens to agree today.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { dryRun, ingestionFacet } from '@recueil/rules';
import type { IngestionAction, IngestionCondition, IngestionSubject, RuleSetLike } from '@recueil/rules';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson, wholeList } from '../http.js';
import { ruleToWire } from '../ingestion/rules-store.js';
import {
  idPath,
  jsonBody,
  jsonResponse,
  operation,
  problems,
} from '../openapi-kit.js';
import {
  RuleCreateSchema,
  RuleDryRunRequestSchema,
  RuleDryRunResponseSchema,
  RulePageSchema,
  RuleSchema,
  RuleUpdateSchema,
} from '../schemas-ingestion.js';
import { coerceQuery, parseOrThrow, refuse } from '../validate.js';

const BASE = `${API_BASE_PATH}/rules`;

const RULE_TAGS = ['Rules'] as const;

const ListRulesQuerySchema = z.strictObject({
  kind: z.enum(['ingestion', 'dedup']).optional(),
  enabled: z.coerce.boolean().optional(),
});

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  const { ingestion } = app.recueil;

  app.get(BASE, { config: { scope: 'rules:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListRulesQuerySchema, coerceQuery(request.query), 'query');
    const rows = ingestion.rules.list({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
    });
    return sendJson(reply, RulePageSchema, wholeList(rows.map(ruleToWire)));
  });

  app.post(BASE, { config: { scope: 'rules:write' } }, async (request, reply) => {
    const body = parseOrThrow(RuleCreateSchema, request.body, 'body');
    const row = ingestion.rules.create(
      {
        ruleId: body.ruleId,
        kind: body.kind,
        when: body.when,
        then: [...body.then],
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      },
      request.actor,
    );
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, RuleSchema, ruleToWire(row), 201);
  });

  app.post(`${BASE}/dry-run`, { config: { scope: 'rules:read' } }, async (request, reply) => {
    const body = parseOrThrow(RuleDryRunRequestSchema, request.body, 'body');
    const kind = body.kind ?? 'ingestion';

    if (kind === 'dedup') {
      // The dedup facet's subject is a *pair* of records, not an ingestion subject, and this
      // endpoint takes ingestion subjects. Refusing is honest; evaluating dedup rules against a
      // subject shaped for the other facet would produce a report about nothing.
      refuse(
        'body.kind',
        "must be 'ingestion': a dedup dry run takes candidate pairs, which this endpoint does not " +
          'accept yet. It arrives with the dedup engine in Phase 3.',
      );
    }

    const ruleSet: RuleSetLike<IngestionCondition, IngestionAction> =
      body.rules === undefined
        ? ingestion.rules.ruleSet('ingestion', {
            ...(body.includeDisabled === undefined ? {} : { includeDisabled: body.includeDisabled }),
            ...(body.mode === undefined ? {} : { mode: body.mode }),
            ...(body.limits === undefined ? {} : { limits: body.limits }),
          })
        : {
            kind: 'ingestion',
            name: 'inline',
            ...(body.mode === undefined ? {} : { mode: body.mode }),
            ...(body.limits === undefined ? {} : { limits: body.limits }),
            rules: body.rules.map((rule) => ({
              id: rule.ruleId,
              ...(rule.description === undefined ? {} : { description: rule.description }),
              ...(rule.enabled === undefined ? {} : { enabled: rule.enabled }),
              ...(rule.priority === undefined ? {} : { priority: rule.priority }),
              when: rule.when as IngestionCondition,
              then: rule.then as IngestionAction[],
            })),
          };

    const report = dryRun(
      ruleSet,
      body.subjects as readonly IngestionSubject[],
      ingestionFacet,
      body.maxTraces === undefined ? {} : { maxTraces: body.maxTraces },
    );

    return sendJson(reply, RuleDryRunResponseSchema, {
      ruleSet: report.ruleSet,
      kind: report.kind,
      mode: report.mode,
      subjectCount: report.subjectCount,
      entries: report.entries.map((entry) => ({
        subjectId: entry.subjectId,
        outcome: entry.outcome,
        ...(entry.trace === undefined ? {} : { trace: entry.trace }),
      })),
      rules: report.rules.map((statistics) => ({ ...statistics })),
      unmatchedSubjectIds: [...report.unmatchedSubjectIds],
      erroredSubjectIds: [...report.erroredSubjectIds],
      warnings: [...report.warnings],
    });
  });

  app.get(`${BASE}/:id`, { config: { scope: 'rules:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, RuleSchema, ruleToWire(ingestion.rules.get(id)));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'rules:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(RuleUpdateSchema, request.body, 'body');
    const row = ingestion.rules.update(
      id,
      {
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.when === undefined ? {} : { when: body.when }),
        ...(body.then === undefined ? {} : { then: [...body.then] }),
      },
      request.actor,
    );
    return sendJson(reply, RuleSchema, ruleToWire(row));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'rules:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    ingestion.rules.remove(id, request.actor);
    return reply.code(204).send();
  });
};

export const rulePaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listRules',
      summary: 'List rules',
      description:
        'In evaluation order: ascending priority then rule id, which is the order the engine uses, ' +
        'so a list a UI renders is a list that predicts precedence.',
      tags: RULE_TAGS,
      scope: 'rules:read',
      requestParams: { query: ListRulesQuerySchema },
      responses: {
        '200': jsonResponse('The rules.', RulePageSchema),
        ...problems('401', '403', '422'),
      },
    }),
    post: operation({
      operationId: 'createRule',
      summary: 'Create a rule',
      description:
        "Validated against `@recueil/rules`' own schema, so what this endpoint accepts and what the " +
        'engine can run are the same set by construction. `ruleId` is the author\'s stable handle — ' +
        'it is what a trace names and what `item_tags.rule_ref` points at — and is unique per kind.\n\n' +
        'No pattern in a rule is run through a backtracking engine: the regular expressions and the ' +
        'globs compile to a linear-time Pike VM with a step budget, because a rule set arrives over ' +
        'the API.',
      tags: RULE_TAGS,
      scope: 'rules:write',
      requestBody: jsonBody(RuleCreateSchema),
      responses: {
        '201': jsonResponse('The rule.', RuleSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/dry-run`]: {
    post: operation({
      operationId: 'dryRunRules',
      summary: 'What would these rules do?',
      description:
        'Evaluates a rule set over subjects and writes nothing — structurally, not by a flag: the ' +
        'evaluator is a pure function of the rule set and the subject.\n\n' +
        'Omit `rules` to run the stored, enabled ingestion rules; supply it to try a rule that has ' +
        'not been saved. The response is the engine\'s own report: one entry per subject with its ' +
        'full trace of which conditions matched on what evidence, and one row per rule whatever its ' +
        'outcome — a rule that never fires is news.',
      tags: RULE_TAGS,
      scope: 'rules:read',
      requestBody: jsonBody(RuleDryRunRequestSchema),
      responses: {
        '200': jsonResponse('The report.', RuleDryRunResponseSchema),
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getRule',
      summary: 'Fetch one rule',
      description: 'The row, with its condition and actions as stored.',
      tags: RULE_TAGS,
      scope: 'rules:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The rule.', RuleSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateRule',
      summary: 'Change a rule',
      description:
        'The kind cannot change: a condition means one thing under `ingestion` and another under ' +
        '`dedup`, and reinterpreting one as the other silently is exactly the edit that should be a ' +
        'delete and a create. Everything else is re-validated against the engine\'s schema.',
      tags: RULE_TAGS,
      scope: 'rules:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(RuleUpdateSchema),
      responses: {
        '200': jsonResponse('The updated rule.', RuleSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'deleteRule',
      summary: 'Remove a rule',
      description:
        'What the rule already did is untouched: a tag it applied keeps its `rule_ref`, which now ' +
        'names a rule that exists only in the audit log. That is the correct record of history, and ' +
        'the log carries the whole definition.',
      tags: RULE_TAGS,
      scope: 'rules:write',
      requestParams: { path: idPath() },
      responses: {
        '204': { description: 'Removed.' },
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
