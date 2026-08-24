/**
 * `/health`, which is the Phase 0 exit criterion: "`recueil serve` returns health with an empty
 * library" (CONCEPT.md §7).
 *
 * The criterion is only met if the zeroes are measured. So the suite asserts the empty case *and*
 * the non-empty case on the same fresh database: a constant `items: 0` would pass the first test
 * and fail the second, which is the whole point of writing them as a pair.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ServerHealthResponseSchema } from '../src/health.js';
import { harness } from './helpers.js';
import type { Harness } from './helpers.js';

const getHealth = async (h: Harness) => {
  const response = await h.app.inject({ method: 'GET', url: '/health' });
  return { response, body: response.json() as unknown };
};

describe('GET /health on a fresh library', () => {
  it('returns 200 with an empty library', async () => {
    const h = await harness();
    try {
      const { response, body } = await getHealth(h);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/u);

      const health = ServerHealthResponseSchema.parse(body);

      expect(health.status).toBe('ok');
      expect(health.name).toBe('recueil');
      expect(health.version).toBe('0.1.0-test');
      expect(health.apiVersion).toBe('v1');
      expect(health.mode).toBe('server');
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(health.library?.items).toBe(0);
      expect(health.library?.documents).toBe(0);
      expect(health.library?.attachments).toBe(0);
      expect(health.library?.collections).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('reports the database as migrated', async () => {
    const h = await harness();
    try {
      const { body } = await getHealth(h);
      const health = ServerHealthResponseSchema.parse(body);

      expect(health.database.ok).toBe(true);
      // Read from drizzle's ledger, so this is the number of migrations that actually ran.
      expect(health.database.migrationsApplied).toBeGreaterThan(0);
      expect(health.database.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await h.close();
    }
  });

  it('reports the store as writable at the configured path', async () => {
    const h = await harness();
    try {
      const { body } = await getHealth(h);
      const health = ServerHealthResponseSchema.parse(body);

      expect(health.storage.ok).toBe(true);
      expect(health.storage.backend).toBe('local');
      expect(health.storage.path).toBe(h.config.storagePath);
      // m1: partial writes in the store's `.tmp` are invisible to everything else, so the probe
      // reports them. Zero on a store nothing has interrupted — but the field must be there.
      expect(health.storage.strayTempFiles).toBe(0);
      expect(health.storage.strayTempBytes).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('counts the partial writes an interrupted upload left in the store', async () => {
    const h = await harness();
    try {
      // What a killed process leaves behind: a `.part` file in `<store>/.tmp`. Nothing else in the
      // system ever mentions it — `listStoredBlobs` skips it, a backup ignores it, a restore does
      // not know it exists — so if the probe does not say so, nobody finds out until the disk is
      // full.
      const temporary = join(h.config.storagePath, '.tmp');
      mkdirSync(temporary, { recursive: true });
      writeFileSync(join(temporary, '01JHALFWRITTENHALFWRITTEN.part'), Buffer.alloc(4096));

      const health = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(health.storage.strayTempFiles).toBe(1);
      expect(health.storage.strayTempBytes).toBe(4096);
      // Not itself a fault: a `.part` file may belong to an upload still in flight.
      expect(health.storage.ok).toBe(true);
      expect(health.status).toBe('ok');
    } finally {
      await h.close();
    }
  });

  it('names the database and the store as required components', async () => {
    const h = await harness();
    try {
      const { body } = await getHealth(h);
      const health = ServerHealthResponseSchema.parse(body);

      const names = health.components.map((component) => component.name).sort();
      expect(names).toEqual(['database', 'search', 'storage']);
      // The two the library cannot serve without are required; the index is not (ADR-0011).
      const required = health.components.filter((component) => component.required).map((c) => c.name);
      expect(required.sort()).toEqual(['database', 'storage']);
      expect(health.components.every((component) => component.status === 'ok')).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('GET /health counts real rows', () => {
  it('follows the library as it fills and empties', async () => {
    const h = await harness();
    try {
      const before = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(before.library?.items).toBe(0);

      const first = h.recueil.library.createItem({ itemType: 'article', title: 'One' }, h.recueil.actor);
      h.recueil.library.createItem({ itemType: 'report', title: 'Two' }, h.recueil.actor);

      const filled = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(filled.library?.items).toBe(2);
      expect(filled.library?.documents).toBe(0);

      // Trashed is not deleted (P5), but it is not the library either: the count drops.
      h.recueil.library.trashItem(first.item.id, h.recueil.actor);

      const trimmed = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(trimmed.library?.items).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('counts an ingested document', async () => {
    const h = await harness();
    try {
      await h.recueil.documents.ingestBuffer(Buffer.from('%PDF-1.7\nnot really a pdf\n'), {
        sourceKind: 'api',
        actor: h.recueil.actor,
      });

      const health = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(health.library?.documents).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('timestamps the count, so a cached one could never pass for a live one', async () => {
    const h = await harness();
    try {
      const health = ServerHealthResponseSchema.parse((await getHealth(h)).body);
      expect(health.library?.countedAt).toBe(health.checkedAt);
    } finally {
      await h.close();
    }
  });
});

describe('GET /health when a required component is down', () => {
  it('answers 503 and still says which one', async () => {
    const h = await harness();
    try {
      // Close the connection out from under the running application. This is exactly the failure a
      // probe exists to catch, and the endpoint must answer rather than throw.
      h.recueil.connection.close();

      const { response, body } = await getHealth(h);
      expect(response.statusCode).toBe(503);

      const health = ServerHealthResponseSchema.parse(body);
      expect(health.status).toBe('error');
      expect(health.database.ok).toBe(false);
      expect(health.library).toBeUndefined();
      expect(health.components.find((component) => component.name === 'database')?.status).toBe('error');
    } finally {
      await h.app.close();
    }
  });
});

describe('GET /health — the Phase 1 additions', () => {
  it('reports the full-text index as an optional component', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/health' });
      const health = response.json() as Record<string, any>;

      expect(health.search).toEqual({ available: true, backend: 'fts5' });
      const search = (health.components as { name: string; required: boolean; status: string }[]).find(
        (component) => component.name === 'search',
      );
      expect(search).toBeDefined();
      // Optional: no index would be `degraded`, never `error`.
      expect(search?.required).toBe(false);
      expect(search?.status).toBe('ok');
      // And an optional component being up leaves the whole response `ok`.
      expect(health.status).toBe('ok');
    } finally {
      await h.close();
    }
  });

  it('reports what the API surface is doing', async () => {
    const h = await harness({ env: { RECUEIL_REQUIRE_AUTH: 'true' } });
    try {
      const health = (await h.app.inject({ method: 'GET', url: '/health' })).json() as Record<string, any>;
      expect(health.api).toEqual({
        basePath: '/api/v1',
        eventSubscribers: 0,
        authRequired: true,
      });
    } finally {
      await h.close();
    }
  });
});
