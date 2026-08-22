/**
 * The health response (CONCEPT.md §5.15, and the Phase 0 exit criterion: "`recueil serve` returns
 * health with an empty library").
 *
 * `/health` is unauthenticated and cheap, because a container health check runs it every few
 * seconds (deploy/docker-compose.yml). Anything expensive — counting rows, reaching a sidecar —
 * is cached by the server and reported with the time it was last measured, never computed inline.
 */
import * as z from 'zod';

import { CountSchema, TimestampSchema } from '../primitives.js';

export const HEALTH_STATUSES = ['ok', 'degraded', 'error'] as const;

export const HealthStatusSchema = z.enum(HEALTH_STATUSES).meta({
  id: 'HealthStatus',
  title: 'HealthStatus',
  description:
    '`ok` — everything required is working. `degraded` — an optional component (a sidecar, a ' +
    'resolver) is down but the library is serving. `error` — the library is not serving.',
});

/** One thing that can be up or down: the database, the file store, a sidecar, the job queue. */
export const ComponentHealthSchema = z
  .strictObject({
    name: z
      .string()
      .max(64)
      .meta({ description: 'Stable component name.', examples: ['database', 'storage', 'jobs', 'search'] }),
    status: HealthStatusSchema,
    required: z
      .boolean()
      .meta({ description: 'Whether a failure here makes the whole response `error` rather than `degraded`.' }),
    detail: z.string().max(1024).optional(),
    latencyMs: z.number().min(0).optional(),
    checkedAt: TimestampSchema.optional().meta({ description: 'When this component was last probed.' }),
  })
  .meta({ id: 'ComponentHealth', title: 'ComponentHealth' });

/** Enough of a library summary to satisfy the Phase 0 exit criterion, and no more. */
export const LibrarySummarySchema = z
  .strictObject({
    items: CountSchema,
    documents: CountSchema,
    attachments: CountSchema,
    collections: CountSchema,
    countedAt: TimestampSchema.optional(),
  })
  .meta({
    id: 'LibrarySummary',
    title: 'LibrarySummary',
    description: 'Live record counts. Zero across the board is a healthy empty library, not a fault.',
  });

export const HealthResponseSchema = z
  .strictObject({
    status: HealthStatusSchema,
    name: z.literal('recueil'),
    version: z
      .string()
      .max(64)
      .meta({ description: 'The server version.', examples: ['0.1.0'] }),
    apiVersion: z.string().max(16).meta({ description: 'The REST API major version this server serves.', examples: ['v1'] }),
    checkedAt: TimestampSchema,
    startedAt: TimestampSchema,
    uptimeSeconds: z.number().min(0),
    mode: z
      .enum(['server', 'sidecar'])
      .meta({ description: 'Docker and local mode run identical code; the shell differs (CONCEPT.md §5.1).' }),
    components: z.array(ComponentHealthSchema).max(64),
    library: LibrarySummarySchema.optional(),
  })
  .meta({
    id: 'HealthResponse',
    title: 'HealthResponse',
    description:
      'The response of `GET /health`. Unauthenticated, cheap, and safe to poll: measurements ' +
      'that cost anything are cached and reported with the time they were taken.',
  });

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;
export type LibrarySummary = z.infer<typeof LibrarySummarySchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
