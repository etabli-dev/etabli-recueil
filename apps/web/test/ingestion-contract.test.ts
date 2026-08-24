/**
 * The ingestion contract, written down once and asserted here.
 *
 * The Phase 2 resources — the review queue, the sources, the rule sets — are not in
 * `@recueil/schemas` yet, so `src/api/ingestion.ts` declares them and `src/api/client.ts` is the
 * only place their paths appear. That makes this file the drift check: it drives every ingestion
 * method through a fake at the `fetch` boundary and asserts the exact request each one makes, so
 * the list below is a statement of what the server must serve for these screens to work, and
 * changing a path without changing it here fails.
 *
 * It also holds the two agreements that are not with the server at all: the manifest's share-target
 * action must be the route the client registers, and the service worker must answer that same path.
 * Three files, one string, and nothing else would notice if they parted company.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RecueilClient } from '../src/api/client.js';
import { SHARE_PATH } from '../src/pwa/share-protocol.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer } from './fake-server.js';

const BASE = '/api/v1';

/**
 * The manifest, read from disk rather than imported.
 *
 * `.webmanifest` is not a module extension the bundler knows, and the file is deliberately hand-
 * written rather than generated — so it is read as the browser will read it: as text, parsed as
 * JSON. A syntax error in it fails here rather than at install time on somebody's phone.
 */
const manifest = JSON.parse(
  // Vitest runs with the package as its root, and `import.meta.url` is rewritten by the transform,
  // so the path is resolved from the configured root rather than from this file.
  readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'),
) as {
  share_target: { action: string; method: string; enctype: string; params: { files: { name: string }[] } };
  icons: { sizes: string; purpose: string }[];
};

/** Answers anything with an empty object, and records what was asked. */
const recorder = (): { server: FakeServer; client: RecueilClient } => {
  const server = createFakeServer({});
  const client = new RecueilClient({
    fetch: async (input, init) => {
      await server.fetch(input, init);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { server, client };
};

describe('the paths the ingestion screens require', () => {
  it('addresses the review queue', async () => {
    const { server, client } = recorder();
    await client.listReviewEntries({ status: 'open', severity: 'blocker', limit: 50 });
    await client.getReviewEntry('entry-1');
    await client.acceptReviewEntry('entry-1', {
      note: 'corrected',
      edits: { fields: { 'office.correspondent': 'ACME GmbH' } },
    });
    await client.rejectReviewEntry('entry-1', { note: 'not ours' });

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${BASE}/ingestion/review`,
      `GET ${BASE}/ingestion/review/entry-1`,
      `POST ${BASE}/ingestion/review/entry-1/accept`,
      `POST ${BASE}/ingestion/review/entry-1/reject`,
    ]);

    const list = server.requests[0];
    expect(list?.query.get('status')).toBe('open');
    expect(list?.query.get('severity')).toBe('blocker');
    expect(list?.query.get('limit')).toBe('50');
    expect(server.requests[2]?.body).toEqual({
      note: 'corrected',
      edits: { fields: { 'office.correspondent': 'ACME GmbH' } },
    });
  });

  it('has no reopen, which is why undo is a grace period rather than a request', () => {
    // Stated as an assertion rather than a comment: if a reopen is added to the API, this fails and
    // the workspace's undo can be reconsidered on purpose rather than by accident.
    expect(Object.getOwnPropertyNames(RecueilClient.prototype)).not.toContain('reopenReviewEntry');
  });

  it('addresses the sources', async () => {
    const { server, client } = recorder();
    await client.listIngestionSources();
    await client.getIngestionSource('src-1');
    await client.createIngestionSource({ name: 'Scans', config: { kind: 'folder', root: '/srv/consume' } });
    await client.updateIngestionSource('src-1', { enabled: false });
    await client.setIngestionSourceEnabled('src-1', true);
    await client.setIngestionSourceEnabled('src-1', false);
    await client.testIngestionSource('src-1');
    await client.runIngestionSource('src-1');
    await client.deleteIngestionSource('src-1');

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${BASE}/ingestion/sources`,
      `GET ${BASE}/ingestion/sources/src-1`,
      `POST ${BASE}/ingestion/sources`,
      `PATCH ${BASE}/ingestion/sources/src-1`,
      `POST ${BASE}/ingestion/sources/src-1/enable`,
      `POST ${BASE}/ingestion/sources/src-1/disable`,
      `POST ${BASE}/ingestion/sources/src-1/test-connection`,
      `POST ${BASE}/ingestion/sources/src-1/run`,
      `DELETE ${BASE}/ingestion/sources/src-1`,
    ]);
  });

  it('addresses the work queue, which is where a run reports itself', async () => {
    const { server, client } = recorder();
    await client.listIngestionJobs({ state: 'running' });
    await client.getIngestionJob('job-1');
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${BASE}/ingestion/queue`,
      `GET ${BASE}/ingestion/queue/job-1`,
    ]);
    expect(server.requests[0]?.query.get('state')).toBe('running');
  });

  it('addresses the rule table and the dry run', async () => {
    const { server, client } = recorder();
    await client.listRules({ kind: 'ingestion' });
    await client.getRule('rule-1');
    await client.createRule({ ruleId: 'a-rule', kind: 'ingestion', when: { type: 'always' }, then: [{ type: 'stop' }] });
    await client.updateRule('rule-1', { priority: 10 });
    await client.dryRunRules({ subjects: [{ id: 'probe', filename: 'a.pdf' }] });
    await client.deleteRule('rule-1');

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${BASE}/rules`,
      `GET ${BASE}/rules/rule-1`,
      `POST ${BASE}/rules`,
      `PATCH ${BASE}/rules/rule-1`,
      `POST ${BASE}/rules/dry-run`,
      `DELETE ${BASE}/rules/rule-1`,
    ]);
  });

  it('reads a document row, which is where the review preview gets its facts', async () => {
    const { server, client } = recorder();
    await client.getDocument('doc-1');
    expect(server.requests[0]?.path).toBe(`${BASE}/documents/doc-1`);
  });

  it('trashes rather than deletes when an acceptance is reversed (P5)', async () => {
    const { server, client } = recorder();
    await client.trashItem('item-1', 'reversing an acceptance');
    expect(`${server.requests[0]?.method ?? ''} ${server.requests[0]?.path ?? ''}`).toBe(
      `POST ${BASE}/items/item-1/trash`,
    );
  });

  it('escapes an identifier rather than pasting it into a path', async () => {
    const { server, client } = recorder();
    await client.getReviewEntry('a/../b');
    expect(server.requests[0]?.path).toBe(`${BASE}/ingestion/review/a%2F..%2Fb`);
  });

  it('posts a shared file to the ingestion upload, without setting a content type', async () => {
    const { server, client } = recorder();
    await client.uploadForIngestion(new Blob(['x'], { type: 'text/plain' }), {
      filename: 'a.txt',
      sourceKind: 'mobile',
    });
    expect(server.requests[0]?.path).toBe(`${BASE}/ingestion/upload`);
    // The browser must set the multipart boundary; a client-set header would set it without one.
    expect(server.requests[0]?.headers['content-type']).toBeUndefined();
  });
});

describe('the share target', () => {
  it('is the same path in the manifest, the router and the service worker', () => {
    expect(manifest.share_target.action).toBe(SHARE_PATH);
  });

  it('is declared as a multipart POST, which is what needs a service worker to answer it', () => {
    const target = manifest.share_target;
    expect(target.method).toBe('POST');
    expect(target.enctype).toBe('multipart/form-data');
    // The worker reads `form.getAll('file')`, so the manifest must name the part `file`.
    expect(target.params.files[0]?.name).toBe('file');
  });

  it('declares icons at the sizes an installable application needs', () => {
    const icons = manifest.icons;
    expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });
});
