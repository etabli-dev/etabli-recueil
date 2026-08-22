/**
 * `@recueil/schemas` — the shared contract.
 *
 * Every Zod schema in Recueil lives here, and every other package in the monorepo imports them
 * rather than declaring its own: the server validates with them, the OpenAPI document is generated
 * from them, and the TypeScript client, the MCP tool definitions and the Python models are all
 * generated from that document (P6, CONCEPT.md §5.12).
 *
 * Scope: Phase 1's core of the data model — documents, items and their two facets, attachments,
 * collections, tags, custom fields, notes, annotations and creators — plus the envelopes every
 * endpoint shares. The graph, analytics and systematic-review entities are specified in
 * `spec/data-model.md` and arrive with the phases that serve them.
 *
 * Conventions:
 *
 * - The database is `lower_snake_case` (`spec/data-model.md` §1.2); this contract is `camelCase`.
 *   The mapping is mechanical and belongs to `packages/core`.
 * - `Create` and `Update` variants exist wherever they differ from the read shape — server-issued
 *   ids, timestamps and version counters are absent from both, and `Update` is partial.
 * - Nullable columns are `nullish` on the wire, so a server may omit a field or send `null` and
 *   both mean "no value".
 * - Prose is British English, matching CONCEPT.md. The one deliberate exception is where an
 *   external identifier spells it otherwise: the CSL-JSON key is `license`, ours is `licence`.
 */

/* Primitives and vocabularies -------------------------------------------------------------- */
export * from './primitives.js';
export * from './vocabularies.js';
export * from './provenance.js';

/* Entities ---------------------------------------------------------------------------------- */
export * from './entities/document.js';
export * from './entities/item.js';
export * from './entities/bibliographic.js';
export * from './entities/office.js';
export * from './entities/attachment.js';
export * from './entities/collection.js';
export * from './entities/tag.js';
export * from './entities/custom-field.js';
export * from './entities/note.js';
export * from './entities/annotation.js';
export * from './entities/creator.js';

/* Envelopes --------------------------------------------------------------------------------- */
export * from './envelopes/pagination.js';
export * from './envelopes/problem.js';
export * from './envelopes/bulk.js';
export * from './envelopes/health.js';

/* OpenAPI ----------------------------------------------------------------------------------- */
export * from './openapi/index.js';
