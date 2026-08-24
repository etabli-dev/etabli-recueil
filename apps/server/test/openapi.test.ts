/**
 * `/openapi.json`.
 *
 * P6 makes the document the contract, so "it returns 200" is not the test. The test is that the
 * thing served is a well-formed OpenAPI 3.1 document whose every internal reference resolves and
 * whose declared operations are the operations this server actually answers — because a contract
 * that describes a route nobody serves, or omits one everybody calls, is worse than no contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderSpecYaml } from '../src/openapi.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { harness } from './helpers.js';

/** Walk the document and collect every `$ref` string, wherever it is nested. */
const collectRefs = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof nested === 'string') found.push(nested);
      else collectRefs(nested, found);
    }
  }
  return found;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

describe('GET /openapi.json', () => {
  it('serves a valid OpenAPI 3.1 document', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/u);

      const document = response.json() as Record<string, any>;

      // The three members OpenAPI 3.1 requires of a document, plus the version constraint.
      expect(document.openapi).toMatch(/^3\.1\.\d+$/u);
      expect(document.info).toBeTypeOf('object');
      expect(document.info.title).toBe('Recueil API');
      expect(typeof document.info.version).toBe('string');
      expect(document.info.license.identifier).toBe('AGPL-3.0-or-later');
      expect(document.paths).toBeTypeOf('object');

      // Every path is a path template, and every operation on it declares responses.
      for (const [path, item] of Object.entries(document.paths as Record<string, any>)) {
        expect(path.startsWith('/'), `path '${path}' is not rooted`).toBe(true);
        const operations = Object.entries(item).filter(([method]) => HTTP_METHODS.includes(method));
        expect(operations.length, `path '${path}' declares no operation`).toBeGreaterThan(0);
        for (const [method, operation] of operations) {
          const declared = operation as Record<string, any>;
          expect(declared.responses, `${method.toUpperCase()} ${path} declares no responses`).toBeTypeOf(
            'object',
          );
          expect(typeof declared.operationId).toBe('string');
        }
      }
    } finally {
      await h.close();
    }
  });

  it('resolves every internal reference', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });
      const document = response.json() as Record<string, any>;

      const refs = [...new Set(collectRefs(document))];
      expect(refs.length).toBeGreaterThan(0);

      for (const ref of refs) {
        expect(ref.startsWith('#/'), `external reference '${ref}' is not self-contained`).toBe(true);
        const resolved = ref
          .slice(2)
          .split('/')
          .map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
          .reduce<unknown>(
            (node, segment) =>
              node !== null && typeof node === 'object'
                ? (node as Record<string, unknown>)[segment]
                : undefined,
            document,
          );
        expect(resolved, `'${ref}' does not resolve`).toBeDefined();
      }
    } finally {
      await h.close();
    }
  });

  it('declares the operations this server actually answers', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });
      const document = response.json() as Record<string, any>;

      for (const path of ['/health', '/api/v1/system/info', '/openapi.json']) {
        expect(document.paths[path], `the document does not declare ${path}`).toBeDefined();
        const served = await h.app.inject({ method: 'GET', url: path });
        expect(served.statusCode, `${path} is declared but not served`).toBe(200);
      }
    } finally {
      await h.close();
    }
  });

  it('publishes the health schema the server actually sends', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });
      const document = response.json() as Record<string, any>;

      const health =
        document.paths['/health'].get.responses['200'].content['application/json'].schema;
      expect(health.$ref).toBe('#/components/schemas/ServerHealthResponse');

      const schema = document.components.schemas.ServerHealthResponse;
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties)).toEqual(
        expect.arrayContaining(['status', 'version', 'uptimeSeconds', 'database', 'storage', 'library']),
      );
      expect(schema.required).toEqual(expect.arrayContaining(['database', 'storage']));

      // And the document it publishes accepts the body it serves.
      const served = (await h.app.inject({ method: 'GET', url: '/health' })).json() as Record<string, unknown>;
      const properties = Object.keys(schema.properties as Record<string, unknown>);
      for (const key of Object.keys(served)) {
        expect(properties, `/health sends '${key}', which the document does not declare`).toContain(key);
      }
    } finally {
      await h.close();
    }
  });

  it('reports the running version', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;
      expect(document.info.version).toBe('0.1.0-test');
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/system/info', () => {
  it('says what this server is', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/system/info' });
      expect(response.statusCode).toBe(200);

      const info = response.json() as Record<string, any>;
      expect(info.name).toBe('recueil');
      expect(info.version).toBe('0.1.0-test');
      expect(info.apiVersion).toBe('v1');
      expect(info.apiBasePath).toBe('/api/v1');
      expect(info.openapi).toEqual({ version: '3.1.0', url: '/openapi.json' });
      expect(info.storageBackend).toBe('local');
      expect(info.licence).toBe('AGPL-3.0-or-later');
      expect(info.runtime.node).toBe(process.versions.node);
    } finally {
      await h.close();
    }
  });
});

/* ============================================================================================== */
/* The contract covers what the server serves                                                       */
/* ============================================================================================== */

/**
 * Fastify's `:param` becomes OpenAPI's `{param}`.
 *
 * The two spellings are the only difference between the route table and the path list, so this is
 * all it takes to compare them — and comparing them is the whole point of the tests below (P6).
 */
const toTemplate = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');

/** The methods a route may declare that the document need not describe. */
const IMPLICIT_METHODS = new Set(['HEAD', 'OPTIONS']);

describe('the document and the route table', () => {
  it('declares every route the server registers', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;

      const undeclared: string[] = [];
      for (const route of h.routes) {
        if (IMPLICIT_METHODS.has(route.method)) continue;
        const template = toTemplate(route.url);
        const item = document.paths[template] as Record<string, unknown> | undefined;
        if (item === undefined || item[route.method.toLowerCase()] === undefined) {
          undeclared.push(`${route.method} ${template}`);
        }
      }

      expect(undeclared).toEqual([]);
      // A guard against the check passing because the route table was empty.
      expect(h.routes.filter((route) => !IMPLICIT_METHODS.has(route.method)).length).toBeGreaterThan(60);
    } finally {
      await h.close();
    }
  });

  it('serves no operation the router does not answer', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;

      const registered = new Set(
        h.routes.map((route) => `${route.method} ${toTemplate(route.url)}`),
      );

      const unserved: string[] = [];
      for (const [path, item] of Object.entries(document.paths as Record<string, any>)) {
        for (const method of Object.keys(item)) {
          if (!HTTP_METHODS.includes(method)) continue;
          if (!registered.has(`${method.toUpperCase()} ${path}`)) {
            unserved.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }

      expect(unserved).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('gives every operation a unique operationId', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;

      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const [path, item] of Object.entries(document.paths as Record<string, any>)) {
        for (const [method, operation] of Object.entries(item)) {
          if (!HTTP_METHODS.includes(method)) continue;
          const id = (operation as { operationId: string }).operationId;
          const previous = seen.get(id);
          if (previous !== undefined) duplicates.push(`${id}: ${previous} and ${method} ${path}`);
          seen.set(id, `${method} ${path}`);
        }
      }

      expect(duplicates).toEqual([]);
      expect(seen.size).toBeGreaterThan(60);
    } finally {
      await h.close();
    }
  });

  it('describes the Phase 1 resource groups', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;

      for (const path of [
        '/api/v1/items',
        '/api/v1/items/{id}',
        '/api/v1/documents',
        '/api/v1/documents/{id}/content',
        '/api/v1/attachments/{id}',
        '/api/v1/collections/tree',
        '/api/v1/collections/{id}/bibliography.bib',
        '/api/v1/saved-searches/{id}/bibliography.bib',
        '/api/v1/tags',
        '/api/v1/notes',
        '/api/v1/fields',
        '/api/v1/creators',
        '/api/v1/search',
        '/api/v1/export/{format}',
        '/api/v1/trash',
        '/api/v1/tokens',
        '/api/v1/events',
        '/connector/ping',
        '/connector/saveItems',
      ]) {
        expect(document.paths[path], `the document does not declare ${path}`).toBeDefined();
      }
    } finally {
      await h.close();
    }
  });
});

describe('the errors the shared body pipeline can produce', () => {
  /**
   * M7. The content-type check and the JSON parser sit in front of every handler, so 415 and 400
   * are outcomes of *every* body-taking operation whether or not its author declared them. A
   * generated client with no case for a status the server returns is a client that throws on it.
   */
  it('declares 400 and 415 on every operation that takes a body', async () => {
    const h = await harness();
    try {
      const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json() as Record<
        string,
        any
      >;

      const bodyTaking: string[] = [];
      const missing: string[] = [];
      for (const [path, item] of Object.entries(document.paths as Record<string, any>)) {
        for (const [method, declared] of Object.entries(item as Record<string, any>)) {
          if (!HTTP_METHODS.includes(method)) continue;
          if ((declared as Record<string, unknown>).requestBody === undefined) continue;
          bodyTaking.push(`${method.toUpperCase()} ${path}`);
          const responses = (declared as { responses: Record<string, unknown> }).responses;
          for (const status of ['400', '415']) {
            if (responses[status] === undefined) missing.push(`${method.toUpperCase()} ${path} → ${status}`);
          }
        }
      }

      // A guard against the check passing because nothing was found to check.
      expect(bodyTaking.length).toBeGreaterThanOrEqual(30);
      expect(missing).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('really returns them, so the declaration is not a courtesy', async () => {
    const h = await harness();
    try {
      // `application/xml` has no parser on this application, so Fastify refuses it before the
      // handler. (`text/plain` does have one, and reaches the handler's Zod check as a 422.)
      const wrongType = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers: { 'content-type': 'application/xml' },
        payload: '<item/>',
      });
      expect(wrongType.statusCode).toBe(415);
      expect(wrongType.headers['content-type']).toMatch(/application\/problem\+json/u);

      const noType = await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: 'anything' });
      expect(noType.statusCode).toBe(415);

      const unparseable = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers: { 'content-type': 'application/json' },
        payload: '{"itemType": "article",',
      });
      expect(unparseable.statusCode).toBe(400);
      expect(unparseable.headers['content-type']).toMatch(/application\/problem\+json/u);
    } finally {
      await h.close();
    }
  });
});

describe('spec/openapi.yaml', () => {
  it('is the document this server generates', async () => {
    const committed = readFileSync(
      join(fileURLToPath(new URL('../../..', import.meta.url)), 'spec', 'openapi.yaml'),
      'utf8',
    );
    // The committed file is rendered at the package version, which is what the writer uses.
    expect(committed).toBe(renderSpecYaml({ version: PACKAGE_VERSION }));
  });
});
