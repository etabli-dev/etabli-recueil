/**
 * `/openapi.json`.
 *
 * P6 makes the document the contract, so "it returns 200" is not the test. The test is that the
 * thing served is a well-formed OpenAPI 3.1 document whose every internal reference resolves and
 * whose declared operations are the operations this server actually answers — because a contract
 * that describes a route nobody serves, or omits one everybody calls, is worse than no contract.
 */
import { describe, expect, it } from 'vitest';

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
