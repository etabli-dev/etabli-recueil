/**
 * Compatibility, tested against the real client code rather than against our own opinion of it.
 *
 * `connector.test.ts` asserts what Recueil's handlers do. That is necessary and it is not a
 * compatibility claim: every assertion in it is Recueil agreeing with Recueil. ADR-0006's whole
 * bargain is that an **unmodified** extension talks to this server, and the only honest way to test
 * that without a browser is to run the extension's own code over this server's own responses.
 *
 * So the oracles here are verbatim excerpts of upstream, captured at pinned commits and stored in
 * `fixtures/zotero-connector/` with their provenance. Each one is evaluated as source and handed a
 * response that came out of `fastify.inject()`. When upstream dereferences a field Recueil does not
 * send, this file fails with the same `TypeError` the progress window would throw in the browser.
 *
 * What this still does not prove: that the extension sends the request bodies we assume, and that
 * no endpoint we do not implement is required for a capture to complete. Both need a browser. The
 * README says so.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';

import { harness } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', 'fixtures', 'zotero-connector');

const upstream = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** An `xhr`-shaped view of a Fastify inject response, which is what the excerpts consume. */
const asXhr = (response: LightMyRequestResponse): Record<string, unknown> => ({
  status: response.statusCode,
  response: response.payload,
  responseText: response.payload,
  getResponseHeader: (name: string): string | null => {
    const value = response.headers[name.toLowerCase()];
    if (value === undefined) return null;
    return Array.isArray(value) ? (value[0] ?? null) : String(value);
  },
});

/* ------------------------------------------------------------------------------------------- */
/* C2 — `getSelectedCollection` must carry `targets`                                              */
/* ------------------------------------------------------------------------------------------- */

interface ProgressWindowCall {
  prefix: unknown;
  target: unknown;
  targets: unknown;
  tags: unknown;
}

/**
 * Load the extension's `updateFromClient` and run it against a real response.
 *
 * The fixture is the function declaration exactly as upstream writes it; everything it closes over
 * is passed in, so nothing in the excerpt itself is rewritten.
 */
const runUpdateFromClient = async (response: LightMyRequestResponse): Promise<ProgressWindowCall> => {
  const source = upstream('progressWindow_inject.updateFromClient.js');
  const calls: ProgressWindowCall[] = [];

  const Zotero = {
    Connector: {
      callMethod: async (): Promise<unknown> => JSON.parse(response.payload),
    },
    getString: (key: string): string => key,
  };

  const factory = new Function(
    'Zotero',
    'changeHeadline',
    'lastSuccessfulTarget',
    'isFilesEditable',
    'setTimeout',
    `${source}\nreturn updateFromClient;`,
  ) as (
    zotero: unknown,
    changeHeadline: (...args: unknown[]) => void,
    lastSuccessfulTarget: unknown,
    isFilesEditable: boolean,
    setTimeoutFn: typeof setTimeout,
  ) => (prefix?: string) => Promise<void>;

  const updateFromClient = factory(
    Zotero,
    (prefix: unknown, target: unknown, targets: unknown, tags: unknown) => {
      calls.push({ prefix, target, targets, tags });
    },
    null,
    false,
    setTimeout,
  );

  await updateFromClient();
  expect(calls).toHaveLength(1);
  return calls[0] as ProgressWindowCall;
};

describe('the connector progress window, running upstream code over our response', () => {
  it('renders a save target without throwing on the unguarded response.targets dereference', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/getSelectedCollection',
        payload: { switchToReadableLibrary: true },
      });
      expect(response.statusCode).toBe(200);

      // Before the fix this line threw:
      //   TypeError: Cannot read properties of undefined (reading 'filter')
      // at upstream progressWindow_inject.js:153.
      const call = await runUpdateFromClient(response);

      // Upstream's "legacy response for libraries" branch: `id` is null, so the target id is
      // `"L" + libraryID`, and that has to be one of the ids in `targets` or the picker shows a
      // selection that is not in its own list.
      expect(call.target).toMatchObject({ id: 'L1', filesEditable: true });
      expect(Array.isArray(call.targets)).toBe(true);
      const targets = call.targets as { id: string; name: string; level: number }[];
      expect(targets.length).toBeGreaterThanOrEqual(1);
      expect(targets.map((row) => row.id)).toContain('L1');
      for (const target of targets) {
        expect(target.level).toBeTypeOf('number');
        expect(target.name).toBeTypeOf('string');
      }

      // `ping` advertises `supportsTagsAutocomplete`, so the tag map has to survive upstream's
      // unwrap: `Object.entries(response.tags).forEach(([id, arr]) => arr.map(item => item.tag))`.
      expect(call.tags).toEqual({ L1: [] });
    } finally {
      await h.close();
    }
  });

  it('sends every field the Zotero client itself sends on this endpoint', async () => {
    // The upstream client's own response builder, captured verbatim. Anything it assigns to
    // `response` is a field the extension may read; a field missing here is a field that only
    // happens to be unused today.
    const builder = upstream('server_connector.GetSelectedCollection.js');
    const assigned = new Set<string>();
    // Three forms appear in the excerpt: `response.x = …`, `x: …` inside the object literal, and
    // the ES2015 shorthand `x` on a line of its own (upstream writes `editable` that way).
    for (const match of builder.matchAll(/^\s*(?:response\.(\w+)\s*=|(\w+)\s*:|(\w+),?\s*$)/gmu)) {
      assigned.add((match[1] ?? match[2] ?? match[3]) as string);
    }
    // Guard the extraction itself: if upstream is re-captured and the regular expression stops
    // matching, this test must fail rather than pass over an empty set.
    expect(assigned.size).toBeGreaterThanOrEqual(8);

    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/getSelectedCollection',
        payload: {},
      });
      const payload = JSON.parse(response.payload) as Record<string, unknown>;

      // `editable` and `filesEditable` come from the object literal; the rest are assigned later.
      for (const field of ['libraryID', 'libraryName', 'libraryEditable', 'filesEditable', 'editable', 'id', 'name', 'targets', 'tags']) {
        expect(assigned.has(field), `upstream no longer sends '${field}'`).toBe(true);
        expect(Object.hasOwn(payload, field), `Recueil does not send '${field}'`).toBe(true);
      }
    } finally {
      await h.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* C3 — every `/connector/` response carries `X-Zotero-Version`, 404s included                    */
/* ------------------------------------------------------------------------------------------- */

interface OnlineStateOutcome {
  isOnline: boolean | null;
  stateChanges: number;
  error: string | null;
}

/**
 * Run the extension's transport over a response and report what it concluded.
 *
 * The excerpt is the body of `Zotero.Connector.callMethod`'s `try`, up to and including the branch
 * that decides the client is offline.
 */
const runOnlineState = async (response: LightMyRequestResponse): Promise<OnlineStateOutcome> => {
  const source = upstream('connector.callMethod.online-state.js');

  class CommunicationError extends Error {}
  const state = { isOnline: true as boolean | null, clientVersion: null as string | null, stateChanges: 0 };
  const Zotero = {
    HTTP: { request: async (): Promise<unknown> => asXhr(response) },
    Connector: {
      CommunicationError,
      get isOnline(): boolean | null {
        return state.isOnline;
      },
      set isOnline(value: boolean | null) {
        state.isOnline = value;
      },
      set clientVersion(value: string | null) {
        state.clientVersion = value;
      },
      get clientVersion(): string | null {
        return state.clientVersion;
      },
      onStateChange: (): void => {
        state.stateChanges += 1;
      },
    },
  };

  const run = new Function(
    'Zotero',
    'httpMethod',
    'uri',
    'options',
    `return (async () => {\n${source}\nreturn null;\n})();`,
  ) as (zotero: unknown, httpMethod: string, uri: string, options: unknown) => Promise<unknown>;

  let error: string | null = null;
  try {
    await run(Zotero, 'POST', 'http://127.0.0.1:23119/connector/x', {});
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return { isOnline: state.isOnline, stateChanges: state.stateChanges, error };
};

describe('the connector transport, running upstream code over our responses', () => {
  it('does not conclude that Zotero is offline when an unimplemented sub-call 404s', async () => {
    const h = await harness();
    try {
      // `/connector/getTranslators` is a real endpoint of the protocol that Recueil does not
      // answer, so it falls through to the application's `notFoundHandler`. Before the fix the
      // header hook lived inside the connector plugin, Fastify's encapsulation kept it away from
      // the root handler, and this 404 flipped the extension's *global* online state.
      const missing = await h.app.inject({
        method: 'POST',
        url: '/connector/getTranslators',
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['x-zotero-version']).toBe('7.0.0');

      const outcome = await runOnlineState(missing);
      expect(outcome.isOnline).toBe(true);
      expect(outcome.stateChanges).toBe(0);
      expect(outcome.error).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('carries the header on the handshake, on a save, and on a rejected save alike', async () => {
    const h = await harness();
    try {
      const responses = [
        await h.app.inject({ method: 'GET', url: '/connector/ping' }),
        await h.app.inject({ method: 'POST', url: '/connector/ping', payload: {} }),
        await h.app.inject({ method: 'POST', url: '/connector/getSelectedCollection', payload: {} }),
        await h.app.inject({
          method: 'POST',
          url: '/connector/saveItems',
          payload: { items: [{ itemType: 'webpage', title: 'A page', url: 'https://example.org/' }] },
        }),
        // 422: a body the schema refuses. Still a `/connector/` response, so still headered.
        await h.app.inject({ method: 'POST', url: '/connector/saveItems', payload: { items: [] } }),
        await h.app.inject({ method: 'POST', url: '/connector/nothing-here', payload: {} }),
        await h.app.inject({ method: 'GET', url: '/connector/nothing-here' }),
      ];

      for (const response of responses) {
        expect(
          response.headers['x-zotero-version'],
          `${response.statusCode} response lacks x-zotero-version`,
        ).toBe('7.0.0');
      }
      // And every one of them, run through the extension's transport, leaves it online.
      for (const response of responses) {
        expect((await runOnlineState(response)).isOnline).toBe(true);
      }
    } finally {
      await h.close();
    }
  });

  it('is a header only the connector surface claims', async () => {
    const h = await harness();
    try {
      const elsewhere = await h.app.inject({ method: 'GET', url: '/health' });
      expect(elsewhere.headers['x-zotero-version']).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* M5 — `/connector/sessionProgress` is not part of the protocol                                  */
/* ------------------------------------------------------------------------------------------- */

describe('the endpoints the Zotero client actually serves', () => {
  it('does not include sessionProgress, so Recueil does not answer it either', async () => {
    const endpoints = upstream('server_connector.endpoints.txt')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    // Guard the fixture: an empty or truncated capture must fail rather than vacuously pass.
    expect(endpoints.length).toBeGreaterThanOrEqual(15);
    expect(endpoints).toContain('/connector/ping');
    expect(endpoints).toContain('/connector/getSelectedCollection');
    expect(endpoints).not.toContain('/connector/sessionProgress');

    const h = await harness();
    try {
      const gone = await h.app.inject({
        method: 'POST',
        url: '/connector/sessionProgress',
        payload: { sessionID: 'anything' },
      });
      expect(gone.statusCode).toBe(404);
      // Still headered, so removing it cannot take the extension offline either.
      expect(gone.headers['x-zotero-version']).toBe('7.0.0');
    } finally {
      await h.close();
    }
  });

  it('answers every endpoint it does claim to implement', async () => {
    const endpoints = new Set(
      upstream('server_connector.endpoints.txt')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    );

    const h = await harness();
    try {
      const served = h.routes
        .map((route) => route.url)
        .filter((url) => url.startsWith('/connector/'));
      expect(served.length).toBeGreaterThan(0);
      for (const url of served) {
        expect(endpoints.has(url), `${url} is not an endpoint the Zotero client serves`).toBe(true);
      }
    } finally {
      await h.close();
    }
  });
});
