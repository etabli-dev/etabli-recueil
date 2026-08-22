/**
 * `/api/v1/fields` — user- and plugin-defined typed fields, and their values
 * (`spec/data-model.md` §4.6, §4.7).
 *
 * One mechanism carries three things: Paperless-ngx custom fields, user-defined library fields and
 * systematic-review extraction variables. That is why CONCEPT.md §5.10 can say extraction forms are
 * "generated from custom-field schemas" rather than describing a second machinery.
 *
 * Two refusals are the interesting part of the resource, and both are deliberate:
 *
 * - **CF1.** `dataType` and `fieldKey` are immutable. They are absent from the update schema
 *   entirely, so changing a type is a create-plus-migrate operation and never an in-place
 *   alteration that would silently reinterpret every stored value.
 * - **CF2.** A field with values cannot be removed. Deleting the definition would orphan typed data
 *   that no longer knows what it means.
 *
 * A value is a discriminated union on the field's type (`FieldValueContent`), so a `number` sent to
 * a `date` field is refused at the boundary rather than in the analytics export (FV1).
 */
import {
  API_BASE_PATH,
  CustomFieldCreateSchema,
  CustomFieldSchema,
  CustomFieldUpdateSchema,
  FieldValueSchema,
  IdSchema,
  SlugSchema,
} from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson, wholeList } from '../http.js';
import { idPath, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { CustomFieldPageSchema, FieldValuePageSchema, FieldValueWriteSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';
import { customFieldToWire, fieldValueToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/fields`;
const ITEM_BASE = `${API_BASE_PATH}/items`;

const FIELD_TAGS = ['Library'] as const;

export const customFieldRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  /* ---- definitions -------------------------------------------------------------------------- */

  app.get(BASE, { config: { scope: 'fields:read' } }, async (request, reply) => {
    const query = parseOrThrow(
      z.object({ scope: z.enum(['library', 'review']).optional() }),
      coerceQuery(request.query),
      'query',
    );
    const rows = recueil.customFields.listFields({
      ...(query.scope === undefined ? {} : { scope: query.scope }),
    });
    return sendJson(reply, CustomFieldPageSchema, wholeList(rows.map(customFieldToWire)));
  });

  app.post(BASE, { config: { scope: 'fields:write' } }, async (request, reply) => {
    const body = parseOrThrow(CustomFieldCreateSchema, request.body, 'body');
    const row = recueil.customFields.define(
      {
        fieldKey: body.fieldKey,
        name: body.name,
        dataType: body.dataType,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.config === undefined ? {} : { config: body.config as Record<string, unknown> }),
        ...(body.appliesToItemTypes === undefined ? {} : { appliesToItemTypes: body.appliesToItemTypes }),
        ...(body.isRequired === undefined ? {} : { isRequired: body.isRequired }),
        ...(body.isRepeatable === undefined ? {} : { isRepeatable: body.isRepeatable }),
        ...(body.scope === undefined ? {} : { scope: body.scope }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      request.actor,
    );
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, CustomFieldSchema, customFieldToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'fields:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, CustomFieldSchema, customFieldToWire(recueil.customFields.getField(id)));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'fields:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CustomFieldUpdateSchema, request.body, 'body');
    const row = recueil.customFields.updateField(
      id,
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.config === undefined ? {} : { config: body.config as Record<string, unknown> }),
        ...(body.appliesToItemTypes === undefined ? {} : { appliesToItemTypes: body.appliesToItemTypes }),
        ...(body.isRequired === undefined ? {} : { isRequired: body.isRequired }),
        ...(body.isRepeatable === undefined ? {} : { isRepeatable: body.isRepeatable }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      request.actor,
    );
    return sendJson(reply, CustomFieldSchema, customFieldToWire(row));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'fields:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    recueil.customFields.removeField(id, request.actor);
    return reply.code(204).send();
  });

  /* ---- values on an item ---------------------------------------------------------------------- */

  app.get(`${ITEM_BASE}/:id/field-values`, { config: { scope: 'fields:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    recueil.library.getItem(id, { includeTrashed: true });
    return sendJson(
      reply,
      FieldValuePageSchema,
      wholeList(recueil.customFields.listValues(id).map(fieldValueToWire)),
    );
  });

  app.put(`${ITEM_BASE}/:id/field-values/:fieldKey`, { config: { scope: 'fields:write' } }, async (request, reply) => {
    const { id, fieldKey } = parseOrThrow(
      z.object({ id: IdSchema, fieldKey: SlugSchema }),
      request.params,
      'path',
    );
    const body = parseOrThrow(FieldValueWriteSchema, request.body, 'body');
    const written = recueil.customFields.setValue(
      {
        itemId: id,
        fieldKey,
        ...(body.content === undefined ? {} : { content: body.content }),
        ...(body.groupKey === undefined ? {} : { groupKey: body.groupKey }),
        ...(body.ordinal === undefined ? {} : { ordinal: body.ordinal }),
        ...(body.isBlank === undefined ? {} : { isBlank: body.isBlank }),
      },
      request.actor,
    );
    return sendJson(reply, FieldValueSchema, fieldValueToWire(written));
  });

  app.delete(`${ITEM_BASE}/:id/field-values/:fieldKey`, { config: { scope: 'fields:write' } }, async (request, reply) => {
    const { id, fieldKey } = parseOrThrow(
      z.object({ id: IdSchema, fieldKey: SlugSchema }),
      request.params,
      'path',
    );
    const query = parseOrThrow(
      z.object({ groupKey: z.string().max(128).optional(), ordinal: z.coerce.number().int().min(0).optional() }),
      coerceQuery(request.query),
      'query',
    );
    recueil.customFields.clearValue(
      {
        itemId: id,
        fieldKey,
        ...(query.groupKey === undefined ? {} : { groupKey: query.groupKey }),
        ...(query.ordinal === undefined ? {} : { ordinal: query.ordinal }),
      },
      request.actor,
    );
    return reply.code(204).send();
  });
};

export const customFieldPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listCustomFields',
      summary: 'List field definitions',
      description: '`scope: "review"` fields appear only on extraction forms (CONCEPT.md §5.10).',
      tags: FIELD_TAGS,
      scope: 'fields:read',
      requestParams: { query: z.object({ scope: z.enum(['library', 'review']).optional() }) },
      responses: {
        '200': jsonResponse('The definitions.', CustomFieldPageSchema),
        ...problems('401', '403', '422'),
      },
    }),
    post: operation({
      operationId: 'defineCustomField',
      summary: 'Define a custom field',
      description:
        'The `fieldKey` is the slug the API, the exports and the Parquet column all use, and it is ' +
        'unique and immutable. So is `dataType` (CF1): once any value exists, changing the type ' +
        'would reinterpret stored data, so it is a create-plus-migrate operation instead.',
      tags: FIELD_TAGS,
      scope: 'fields:write',
      requestBody: jsonBody(CustomFieldCreateSchema),
      responses: {
        '201': jsonResponse('The definition.', CustomFieldSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getCustomField',
      summary: 'Fetch one field definition',
      description: 'The definition, with its type configuration.',
      tags: FIELD_TAGS,
      scope: 'fields:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The definition.', CustomFieldSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateCustomField',
      summary: 'Update a field definition',
      description: '`fieldKey` and `dataType` are absent from this schema by design: both are immutable (CF1).',
      tags: FIELD_TAGS,
      scope: 'fields:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CustomFieldUpdateSchema),
      responses: {
        '200': jsonResponse('The updated definition.', CustomFieldSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'removeCustomField',
      summary: 'Remove a field definition',
      description: 'Refused while any value exists (CF2): deleting the definition would orphan typed data.',
      tags: FIELD_TAGS,
      scope: 'fields:write',
      requestParams: { path: idPath() },
      responses: { '204': { description: 'Removed.' }, ...problems('401', '403', '404', '409', '422') },
    }),
  },
  [`${ITEM_BASE}/{id}/field-values`]: {
    get: operation({
      operationId: 'listItemFieldValues',
      summary: 'The custom-field values on an item',
      description: 'Each decoded into the typed union its field declares.',
      tags: FIELD_TAGS,
      scope: 'fields:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The values.', FieldValuePageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${ITEM_BASE}/{id}/field-values/{fieldKey}`]: {
    put: operation({
      operationId: 'setItemFieldValue',
      summary: 'Set a custom-field value',
      description:
        'The value is a discriminated union on the field\'s data type, so a `number` sent to a ' +
        '`date` field is refused here rather than surfacing in the analytics export (FV1). ' +
        '`isBlank: true` records an explicit "not reported", which is a different fact from "not ' +
        'yet extracted" — the latter is the absence of the row.',
      tags: FIELD_TAGS,
      scope: 'fields:write',
      requestParams: { path: z.object({ id: IdSchema, fieldKey: SlugSchema }) },
      requestBody: jsonBody(FieldValueWriteSchema),
      responses: {
        '200': jsonResponse('The stored value.', FieldValueSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'clearItemFieldValue',
      summary: 'Clear a custom-field value',
      description: 'Removes the row, which is "not extracted" — distinct from `isBlank`, which is "not reported".',
      tags: FIELD_TAGS,
      scope: 'fields:write',
      requestParams: {
        path: z.object({ id: IdSchema, fieldKey: SlugSchema }),
        query: z.object({
          groupKey: z.string().max(128).optional(),
          ordinal: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: { '204': { description: 'Cleared.' }, ...problems('401', '403', '404', '422') },
    }),
  },
};
