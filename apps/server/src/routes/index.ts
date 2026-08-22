/**
 * Every route group, registered once, and every path item, collected once.
 *
 * The two exports here are two halves of the same promise. `apiRoutes` is what the application
 * registers; `apiPaths` is what the OpenAPI document declares. They are assembled from the same
 * list, in the same order, from modules that each export both — so a route group cannot be served
 * without being described, and `test/openapi.test.ts` closes the remaining gap by walking Fastify's
 * own route table and failing on anything the document does not name (P6).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';

import { attachmentPaths, attachmentRoutes } from './attachments.js';
import { collectionPaths, collectionRoutes } from './collections.js';
import { connectorPaths, connectorRoutes } from './connector.js';
import { creatorPaths, creatorRoutes } from './creators.js';
import { customFieldPaths, customFieldRoutes } from './custom-fields.js';
import { documentPaths, documentRoutes } from './documents.js';
import { eventPaths, eventRoutes } from './events.js';
import { exportPaths, exportRoutes } from './export.js';
import { itemPaths, itemRoutes } from './items.js';
import { notePaths, noteRoutes } from './notes.js';
import { searchPaths, searchRoutes } from './search.js';
import { tagPaths, tagRoutes } from './tags.js';
import { tokenPaths, tokenRoutes } from './tokens.js';
import { trashPaths, trashRoutes } from './trash.js';

/** In registration order. Fastify's router is order-independent; a reader is not. */
const GROUPS: readonly { plugin: FastifyPluginAsync; paths: ZodOpenApiPathsObject }[] = [
  { plugin: itemRoutes, paths: itemPaths },
  { plugin: documentRoutes, paths: documentPaths },
  { plugin: attachmentRoutes, paths: attachmentPaths },
  { plugin: collectionRoutes, paths: collectionPaths },
  { plugin: tagRoutes, paths: tagPaths },
  { plugin: noteRoutes, paths: notePaths },
  { plugin: customFieldRoutes, paths: customFieldPaths },
  { plugin: creatorRoutes, paths: creatorPaths },
  { plugin: searchRoutes, paths: searchPaths },
  { plugin: exportRoutes, paths: exportPaths },
  { plugin: trashRoutes, paths: trashPaths },
  { plugin: tokenRoutes, paths: tokenPaths },
  { plugin: eventRoutes, paths: eventPaths },
  { plugin: connectorRoutes, paths: connectorPaths },
];

/**
 * The path items of every route group, merged.
 *
 * A later group may add an operation to a path an earlier one declared — `/items/{id}/attachments`
 * has its `get` from `items.ts` and its `post` from `attachments.ts` — so the merge is per path
 * item rather than a plain object spread, which would drop the earlier operation.
 */
export const apiPaths: ZodOpenApiPathsObject = GROUPS.reduce<ZodOpenApiPathsObject>((merged, group) => {
  for (const [path, item] of Object.entries(group.paths)) {
    merged[path] = { ...(merged[path] ?? {}), ...item };
  }
  return merged;
}, {});

export const apiRoutes: FastifyPluginAsync = async (app) => {
  for (const group of GROUPS) app.register(group.plugin);
};
