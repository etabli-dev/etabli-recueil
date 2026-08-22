/**
 * The OpenAPI 3.1 document, generated from the Zod schemas the server validates with.
 *
 * P6 says the OpenAPI spec is the contract, and docs/api.qmd promises the document and the
 * implementation "are the same source". That promise only holds if nobody hand-edits
 * `spec/openapi.yaml`, and if the file names every operation a server answers. This package owns
 * the schemas and the operations the contract shares; it cannot know which routes a given server
 * registers, so `createOpenApiDocument` takes a `paths` object to merge over its own and
 * `apps/server` passes the path items declared beside its handlers.
 *
 * The committed file is therefore written by `pnpm --filter @recueil/server run openapi`. The tests
 * here check that its components are the ones generated below; `apps/server/test/openapi.test.ts`
 * checks the file is byte-for-byte what the server renders.
 */
import { stringify } from 'yaml';
import { createDocument } from 'zod-openapi';
import type { ZodOpenApiObject, ZodOpenApiPathsObject } from 'zod-openapi';

import { componentSchemas } from './components.js';
import { paths as defaultPaths } from './paths.js';

/** The OpenAPI version the document declares. */
export const OPENAPI_VERSION = '3.1.0' as const;

/** The generated document, in the shape `createDocument` returns. */
export type OpenApiDocument = ReturnType<typeof createDocument>;

type ServerObject = NonNullable<ZodOpenApiObject['servers']>[number];

/** The API major version. Bumping it is a breaking change and a new path prefix. */
export const API_VERSION = 'v1' as const;

export interface OpenApiDocumentOptions {
  /** The Recueil release this document describes. Defaults to the package version. */
  readonly version?: string;
  /** Extra path items, merged over the built-in ones. This is how Phase 1 routes arrive. */
  readonly paths?: ZodOpenApiPathsObject;
  /** Servers to advertise. Defaults to the local development server. */
  readonly servers?: ServerObject[];
}

const DEFAULT_SERVERS: ServerObject[] = [
  { url: 'http://localhost:3000', description: 'Local server, or the Tauri sidecar in local mode' },
  { url: 'https://recueil.example.org', description: 'A self-hosted deployment behind a reverse proxy' },
];

/**
 * Build the document object. Exported separately from the YAML writer so that a test, the MCP
 * server and the TypeScript client generator can all consume it without touching the file system.
 */
export const createOpenApiDocument = (options: OpenApiDocumentOptions = {}): OpenApiDocument => {
  const specification: ZodOpenApiObject = {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Recueil API',
      version: options.version ?? '0.0.0',
      summary: 'Self-hosted document and reference management, API-first.',
      description:
        'The REST contract of a Recueil server. Nothing in Recueil is UI-only (P6): the web UI, ' +
        'the CLI, the MCP server and the R and Python packages are all clients of these ' +
        'endpoints, with no privileged back channel.\n\n' +
        'This document is generated from the Zod schemas in `@recueil/schemas`, which are the ' +
        'same schemas the server validates requests with, so the two cannot drift.\n\n' +
        'Phase 0 declares the schemas and the `/health` operation; the resource paths arrive with ' +
        'the features that serve them, from Phase 1 onwards (CONCEPT.md §7).',
      license: {
        name: 'AGPL-3.0-or-later',
        identifier: 'AGPL-3.0-or-later',
      },
      contact: {
        name: 'Recueil',
        url: 'https://github.com/etabli/recueil',
      },
    },
    externalDocs: {
      description: 'Concept, data model and ADRs',
      url: 'https://github.com/etabli/recueil/tree/main/spec',
    },
    servers: options.servers ?? DEFAULT_SERVERS,
    tags: [
      { name: 'System', description: 'Health, version and administrative endpoints.' },
      { name: 'Library', description: 'Items, documents, attachments, collections, tags, notes, annotations, creators.' },
      { name: 'Search', description: 'Boolean and per-field queries, facets, saved searches.' },
      { name: 'Quality', description: 'The verification engine and both deduplication layers.' },
      { name: 'Ingestion', description: 'Sources, the pipeline and the review queue.' },
      { name: 'Graph', description: 'Citation and derived networks, shadow works, budgeted expansion.' },
      { name: 'Analytics', description: 'The Parquet bundle for R, Python and DuckDB.' },
      { name: 'Systematic review', description: 'The PRISMA workflow.' },
      { name: 'Platform', description: 'Plugins, jobs, export.' },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      schemas: { ...componentSchemas },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A scoped API token. Scopes are resource-and-verb pairs (`items:read`, `sr:write`, ' +
            '`admin:*`), and every mutation is attributed in the audit log to the token that made it.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'recueil_session',
          description: 'Session authentication for the web UI. Programmatic clients use a bearer token.',
        },
      },
    },
    paths: { ...defaultPaths, ...options.paths },
  };

  return createDocument(specification);
};

/** The document as YAML, which is the form `spec/openapi.yaml` is committed in. */
export const renderOpenApiYaml = (options: OpenApiDocumentOptions = {}): string => {
  const header = [
    '# Recueil — OpenAPI 3.1 contract.',
    '#',
    '# GENERATED FILE. Do not edit by hand.',
    '# Regenerate with: pnpm --filter @recueil/schemas run openapi',
    '#',
    '# The source of truth is the Zod schemas in packages/schemas/src, which are the schemas the',
    '# server validates with (P6, docs/api.qmd).',
    '',
  ].join('\n');

  const body = stringify(createOpenApiDocument(options), {
    lineWidth: 100,
    singleQuote: true,
    aliasDuplicateObjects: false,
  });

  return `${header}${body}`;
};
