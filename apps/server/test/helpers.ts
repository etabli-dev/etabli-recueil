/**
 * Test fixtures: a real library in a temporary directory, and an application built on it.
 *
 * Nothing here is mocked. The Phase 0 exit criterion is about what a running server reports, so a
 * test that stubbed the database would be testing the stub — the counts in `/health` have to come
 * out of SQLite or they prove nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ServerConfig } from '../src/config.js';

/** One registered route, with the parts of its `config` this surface cares about. */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly scope?: string;
  readonly public?: boolean;
  readonly allowQueryToken?: boolean;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly recueil: Recueil;
  readonly config: ServerConfig;
  readonly root: string;
  /**
   * Every route Fastify registered, collected by an `onRoute` hook.
   *
   * `printRoutes` renders a tree and drops the `config`, and the scope enforcement lives in the
   * config — so a test that wants to assert "every route declares a scope" has to see this.
   */
  readonly routes: readonly RegisteredRoute[];
  close(): Promise<void>;
}

/** A configuration pointing at a fresh temporary directory, parsed through the real parser. */
export const temporaryConfig = (overrides: NodeJS.ProcessEnv = {}): { config: ServerConfig; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-server-'));
  const config = loadConfig({
    RECUEIL_PORT: '0',
    RECUEIL_HOST: '127.0.0.1',
    RECUEIL_DATABASE_URL: `file:${join(root, 'recueil.db')}`,
    RECUEIL_STORAGE_PATH: join(root, 'storage'),
    RECUEIL_LOG_LEVEL: 'silent',
    ...overrides,
  });
  return { config, root };
};

export interface HarnessOptions {
  /** Environment overrides, parsed through the real configuration parser. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Register extra routes before the instance is made ready. Fastify refuses new routes after
   * `ready()`, so a test that needs a handler of its own has to hand it over here.
   */
  readonly routes?: (app: FastifyInstance) => void;
}

/** Build an application over a fresh library. `close` drops the database and the temporary tree. */
export const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const { config, root } = temporaryConfig(options.env);
  const recueil = createRecueil({ databaseUrl: config.databaseUrl, storagePath: config.storagePath });
  const app = buildApp({ config, recueil, version: '0.1.0-test' });

  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    const routeConfig = (route.config ?? {}) as {
      scope?: string;
      public?: boolean;
      allowQueryToken?: boolean;
    };
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routes.push({
        method,
        url: route.url,
        ...(routeConfig.scope === undefined ? {} : { scope: routeConfig.scope }),
        ...(routeConfig.public === undefined ? {} : { public: routeConfig.public }),
        ...(routeConfig.allowQueryToken === undefined
          ? {}
          : { allowQueryToken: routeConfig.allowQueryToken }),
      });
    }
  });

  options.routes?.(app);

  await app.ready();

  return {
    app,
    recueil,
    config,
    root,
    routes,
    close: async () => {
      await app.close();
      recueil.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Phase 1 fixtures                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** Parse a response body as JSON without the `any` that `response.json()` hands back. */
export const body = <TValue = Record<string, unknown>>(response: {
  payload: string;
}): TValue => JSON.parse(response.payload) as TValue;

/** A minimal, valid `ItemCreate` body, with whatever the caller wants layered on top. */
export const itemPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemType: 'article',
  title: 'A randomised controlled trial of something',
  bibliographic: {
    title: 'A randomised controlled trial of something',
    containerTitle: 'The Lancet',
    issuedDate: '2019',
    issuedYear: 2019,
    doi: '10.1016/s0140-6736(19)30041-8',
  },
  ...overrides,
});

/** Create an item through the API and return its body. Fails loudly rather than returning junk. */
export const createItem = async (
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/v1/items',
    payload: itemPayload(overrides),
  });
  if (response.statusCode !== 201) {
    throw new Error(`could not create the fixture item: ${response.statusCode} ${response.payload}`);
  }
  return body(response);
};

/** A multipart body with one file part and any number of fields, as bytes on the wire. */
export const multipart = (
  file: { name: string; filename: string; contentType: string; bytes: Buffer | string },
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = `----recueiltest${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
    Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Phase 2 fixtures                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * A 32-byte credential-encryption key, as base64.
 *
 * Fixed rather than random, because a test that fails should fail the same way twice. It is a test
 * key and nothing is encrypted with it that outlives the temporary directory.
 */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

/** A temporary directory, removed by the returned function. For watched-folder fixtures. */
export const temporaryDirectory = (prefix = 'recueil-consume-'): { path: string; remove: () => void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
};

/** Start the harness on a loopback port and return its origin. For the streaming endpoints. */
export const listen = async (h: Harness): Promise<string> => {
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  return typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
};

/**
 * Read frames off an SSE response until `count` have arrived or the deadline passes.
 *
 * The framing is the contract — `id:`, `event:`, `data:`, blank line — so a test that inspected the
 * bus directly would prove nothing about what a browser receives.
 */
export const readSseFrames = async (
  response: Response,
  count: number,
  timeoutMs = 8000,
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
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
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
