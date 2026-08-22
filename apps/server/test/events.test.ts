/**
 * The SSE stream at `/api/v1/events`.
 *
 * `fastify.inject()` cannot hold a streaming response open, so these tests listen on a real
 * loopback port and read the stream with `fetch`. That is the honest way to test SSE: the framing
 * — `id:`, `event:`, `data:`, blank line — is the contract, and a test that inspected the bus
 * directly would prove nothing about what a browser receives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus, renderSseFrame } from '../src/events.js';
import { harness } from './helpers.js';
import type { Harness } from './helpers.js';

/** Read frames off an event stream until `count` have arrived or the deadline passes. */
const readFrames = async (
  response: Response,
  count: number,
  timeoutMs = 5000,
): Promise<{ event: string; data: Record<string, unknown>; id: string }[]> => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; data: Record<string, unknown>; id: string }[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (frames.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');

      // Comment frames (the greeting and the heartbeats) start with a colon and carry no event.
      if (raw.startsWith(':')) continue;

      const fields = new Map<string, string>();
      for (const line of raw.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const data = fields.get('data');
      if (data === undefined) continue;
      frames.push({
        event: fields.get('event') ?? '',
        id: fields.get('id') ?? '',
        data: JSON.parse(data) as Record<string, unknown>,
      });
    }
  }

  await reader.cancel().catch(() => undefined);
  return frames;
};

describe('EventBus', () => {
  it('numbers envelopes monotonically and fans out to every subscriber', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.subscribe((envelope) => seen.push(envelope.sequence));

    bus.publish({ type: 'item.created', actor: { type: 'system' }, payload: { a: 1 } });
    bus.publish({ type: 'item.updated', actor: { type: 'system' }, payload: { a: 2 } });
    off();
    bus.publish({ type: 'item.trashed', actor: { type: 'system' }, payload: { a: 3 } });

    expect(seen).toEqual([1, 2]);
    expect(bus.sequence).toBe(3);
    expect(bus.subscriberCount).toBe(0);
  });

  it('does not let one subscriber throwing stop the others (§7.2)', () => {
    const errors: unknown[] = [];
    const bus = new EventBus((error) => errors.push(error));
    const seen: string[] = [];

    bus.subscribe(() => {
      throw new Error('handler exploded');
    });
    bus.subscribe((envelope) => seen.push(envelope.type));

    bus.publish({ type: 'item.created', actor: { type: 'system' }, payload: {} });

    expect(seen).toEqual(['item.created']);
    expect(errors.length).toBe(1);
  });

  it('frames an envelope as SSE', () => {
    const bus = new EventBus();
    const envelope = bus.publish({ type: 'item.created', actor: { type: 'system' }, payload: { x: 1 } });
    const frame = renderSseFrame(envelope);

    expect(frame).toContain('id: 1\n');
    expect(frame).toContain('event: item.created\n');
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(frame.split('data: ')[1] as string)).toMatchObject({ type: 'item.created' });
  });
});

describe('GET /api/v1/events', () => {
  let h: Harness;
  let origin: string;

  beforeEach(async () => {
    h = await harness();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const address = h.app.server.address();
    origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
  });

  afterEach(async () => {
    await h.close();
  });

  it('streams the events a write causes', async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/v1/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = readFrames(response, 2);

    // Give the subscription a moment to be registered before causing anything.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const created = await fetch(`${origin}/api/v1/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'article', title: 'Streamed' }),
    });
    const item = (await created.json()) as { id: string };

    await fetch(`${origin}/api/v1/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Streamed, revised' }),
    });

    const received = await frames;
    controller.abort();

    expect(received.map((frame) => frame.event)).toEqual(['item.created', 'item.updated']);
    expect(received[0]?.data).toMatchObject({ type: 'item.created', sequence: 1 });
    expect((received[0]?.data.payload as Record<string, unknown>).itemId).toBe(item.id);
    // Every envelope carries the request that caused it (§7.1).
    expect(received[0]?.data.requestId).toBeTypeOf('string');
    expect(received[1]?.id).toBe('2');
  });

  it('filters by event type when asked', async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/v1/events?types=item.updated`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const frames = readFrames(response, 1, 3000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const created = await fetch(`${origin}/api/v1/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'article', title: 'Filtered' }),
    });
    const item = (await created.json()) as { id: string };
    await fetch(`${origin}/api/v1/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Filtered, revised' }),
    });

    const received = await frames;
    controller.abort();

    expect(received.map((frame) => frame.event)).toEqual(['item.updated']);
  });

  it('drops the subscription when the client goes away', async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/v1/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.app.recueil.events.subscriberCount).toBe(1);

    controller.abort();
    await response.body?.cancel().catch(() => undefined);

    // The server notices the closed socket and unsubscribes.
    for (let attempt = 0; attempt < 50 && h.app.recueil.events.subscriberCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(h.app.recueil.events.subscriberCount).toBe(0);
  });
});
