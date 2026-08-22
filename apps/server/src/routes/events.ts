/**
 * `GET /api/v1/events` — the lifecycle event stream, as Server-Sent Events.
 *
 * SSE rather than WebSockets, for three reasons that all point the same way. The traffic is
 * one-directional — the server tells the client what happened, and the client asks questions
 * through the rest of the API. It is plain HTTP, so it inherits this server's bearer tokens, its
 * scopes and its reverse-proxy setup with nothing extra. And a browser's `EventSource` reconnects
 * by itself, which is the behaviour a UI wants and the behaviour a hand-rolled WebSocket client
 * usually gets wrong.
 *
 * Three properties of the stream, from `spec/hooks.md` §7.2:
 *
 * - **No replay.** A subscriber gets events from the moment it subscribes. `Last-Event-ID` is
 *   accepted and acknowledged, but there is no history to replay in v1 — §7.2 says so — and the
 *   honest response is to say so in the opening comment rather than to silently start from now
 *   while implying otherwise.
 * - **Order by `sequence`, not by `occurredAt`.** Timestamps have clock resolution and can tie.
 * - **A slow reader is disconnected, not waited for.** Delivery is best-effort and non-blocking:
 *   nothing a subscriber does may hold up a write that has already committed.
 *
 * A heartbeat comment goes out every twenty-five seconds. Idle SSE connections are killed by
 * proxies and by phone radios, and a stream that has been dead for four minutes without either end
 * noticing is worse than one that reconnects.
 */
import { API_BASE_PATH } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { EMITTED_EVENT_TYPES, LIFECYCLE_EVENT_TYPES, renderSseFrame } from '../events.js';
import { operation, problems } from '../openapi-kit.js';
import { LifecycleEventSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/events`;

/** How often a comment frame goes out to keep proxies and radios from dropping the connection. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

const EventsQuerySchema = z.strictObject({
  types: z
    .string()
    .max(512)
    .optional()
    .meta({
      description:
        'Comma-separated lifecycle event types to receive. Everything, when omitted.',
      examples: ['item.created,item.updated'],
    }),
});

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const { events } = app.recueil;

  /**
   * Every open stream, so a shutdown can close them all.
   *
   * One set and one `onClose` hook, registered once — not a hook per request, which would grow the
   * hook list for the lifetime of the process and make a long-running server slower with every
   * subscriber it had ever had.
   */
  const open = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const stop of [...open]) stop();
  });

  app.get(BASE, { config: { scope: 'events:read' } }, async (request, reply) => {
    const query = parseOrThrow(EventsQuerySchema, coerceQuery(request.query), 'query');
    const wanted =
      query.types === undefined
        ? null
        : new Set(
            query.types
              .split(',')
              .map((type) => type.trim())
              .filter((type) => type !== ''),
          );

    // Fastify must stop managing this reply: the response is written by hand, stays open for as
    // long as the client wants it, and is not a document Fastify can serialise or terminate.
    reply.hijack();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which turns an event stream into a file that
      // arrives when the request ends. This is the header that turns that off.
      'x-accel-buffering': 'no',
      'x-request-id': String(request.id),
    });

    // The opening frame is a comment, so it is not delivered as an event, and it says what the
    // stream will and will not do. `retry:` sets the browser's reconnection delay.
    reply.raw.write(
      `: subscribed at sequence ${events.sequence}; no history is replayed (spec/hooks.md §7.2)\n` +
        `retry: 3000\n\n`,
    );

    const unsubscribe = events.subscribe((envelope) => {
      if (wanted !== null && !wanted.has(envelope.type)) return;
      // `write` returning false means the socket buffer is full. Nothing is queued and nothing is
      // awaited: a subscriber that cannot keep up loses frames rather than holding up the server.
      reply.raw.write(renderSseFrame(envelope));
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);
    // An open stream must not keep the process alive through a shutdown.
    heartbeat.unref?.();

    const close = (): void => {
      if (!open.delete(close)) return;
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };
    open.add(close);
    request.raw.on('close', close);
    request.raw.on('error', close);
  });
};

export const eventPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'streamEvents',
      summary: 'Lifecycle event stream',
      description:
        'A Server-Sent Events stream of the lifecycle events of `spec/hooks.md` §7. Each frame ' +
        "carries the event type in its `event:` field and the envelope as JSON in `data:`, with " +
        'the monotonic `sequence` as the SSE id.\n\n' +
        `The twelve types are declared in the catalogue; this Phase 1 surface can cause ` +
        `${EMITTED_EVENT_TYPES.map((type) => `\`${type}\``).join(', ')}. The others ` +
        `(${LIFECYCLE_EVENT_TYPES.filter((type) => !EMITTED_EVENT_TYPES.includes(type))
          .map((type) => `\`${type}\``)
          .join(', ')}) arrive with the phases that implement them.\n\n` +
        'There is no replay: a subscriber receives events from the moment it subscribes (§7.2). ' +
        'Order by `sequence`, never by `occurredAt`, which has clock resolution and can tie.',
      tags: ['Platform'],
      scope: 'events:read',
      requestParams: {
        query: EventsQuerySchema,
        header: z.object({
          'last-event-id': z
            .string()
            .optional()
            .meta({ description: 'Accepted and acknowledged; there is no history to replay in v1 (§7.2).' }),
        }),
      },
      responses: {
        '200': {
          description: 'The stream. It stays open until the client closes it or the server shuts down.',
          content: { 'text/event-stream': { schema: LifecycleEventSchema } },
        },
        ...problems('401', '403', '422'),
      },
    }),
  },
};
