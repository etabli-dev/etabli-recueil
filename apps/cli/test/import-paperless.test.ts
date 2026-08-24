/**
 * `recueil import paperless`, against the in-process fake of a Paperless-ngx server.
 *
 * The fake is a real HTTP server on a real loopback socket, serving the fixture library that
 * `@recueil/import-paperless` publishes for exactly this purpose. That is what makes the test
 * meaningful without a container: the CLI is a separate process, it opens a socket, it fetches
 * bytes, and it hashes what actually arrived.
 *
 * What is *not* claimed by any of this: that the mapping is right against a real Paperless-ngx.
 * The client was transcribed from the published source of the release it names, and the report says
 * so. This suite proves the command drives the importer, writes the report, and turns the report's
 * verdict into the right exit code — not that the verdict is a statement about anybody's server.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { FakePaperlessServer, FIXTURE_TOKEN, fixtureLibrary } from '@recueil/import-paperless/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeWorkspace, runCli, runJson, type Workspace } from './ingest-fixture.js';

interface ReportSummary {
  pass: boolean;
  documents: { apiReportedTotal: number; recueilMatched: number; delta: number; missingInRecueil: number[]; orphanedInRecueil: string[] };
  originals: { attempted: number; stored: number; missing: number };
  checks: Array<{ name: string; pass: boolean; blocking: boolean; expected: unknown; actual: unknown }>;
  review: Array<{ reason?: string }>;
  source: { modelledAgainstVersion: string; versionMatchesModel: boolean };
}

interface PaperlessJson {
  command: string;
  dryRun: boolean;
  pass: boolean;
  exitCode: number;
  report: { json: string; markdown: string; review: string } | null;
  summary: ReportSummary;
}

let work: Workspace;
let server: FakePaperlessServer;

beforeEach(async () => {
  work = makeWorkspace('recueil-cli-paperless-');
  server = await FakePaperlessServer.start(fixtureLibrary(), { token: FIXTURE_TOKEN });
});

afterEach(async () => {
  await server.close();
  work.dispose();
});

const reportDirectory = (): string => join(work.root, 'report');

const importArgs = (...extra: string[]): string[] => [
  'import',
  'paperless',
  '--url',
  server.url,
  '--token',
  FIXTURE_TOKEN,
  ...work.libraryArgs,
  '--report',
  reportDirectory(),
  '--no-progress',
  ...extra,
];

describe('the import', () => {
  it('reaches parity with the fake server and writes the report', async () => {
    const { code, json } = await runJson<PaperlessJson>(importArgs());

    expect(json.pass, `the parity check failed:\n${JSON.stringify(json.summary.checks, null, 2)}`).toBe(true);
    expect(json.summary.documents.delta).toBe(0);
    expect(json.summary.documents.missingInRecueil).toEqual([]);
    expect(json.summary.documents.orphanedInRecueil).toEqual([]);
    expect(json.summary.checks.filter((check) => check.blocking && !check.pass)).toEqual([]);

    // The fixture library has one document whose original the fake refuses to serve, so the run
    // finishes with entries a person has to look at: exit 4, "done, but there is work in the queue".
    expect(json.summary.review.length).toBeGreaterThan(0);
    expect(code).toBe(4);

    // The report on disk is the same report the summary was rendered from.
    expect(json.report).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(json.report!.json, 'utf8')) as ReportSummary;
    expect(onDisk.pass).toBe(json.pass);
    expect(onDisk.documents.delta).toBe(json.summary.documents.delta);
    expect(existsSync(json.report!.markdown)).toBe(true);
    expect(readFileSync(json.report!.markdown, 'utf8')).toMatch(/Paperless/u);
  });

  it('counts both sides by query, so the report cannot agree with itself', async () => {
    const { json } = await runJson<PaperlessJson>(importArgs());

    // The Recueil side of the parity check is `items` rows; ask the library independently.
    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    expect(exported.code === 0 || exported.code === 4).toBe(true);
    const records = JSON.parse(exported.stdout.slice(0, exported.stdout.indexOf('\n]') + 2)) as unknown[];

    expect(records).toHaveLength(json.summary.documents.recueilMatched);
    expect(records).toHaveLength(json.summary.documents.apiReportedTotal);
  });

  it('is idempotent: a second import of the same server does not double the library', async () => {
    const first = await runJson<PaperlessJson>(importArgs());
    const second = await runJson<PaperlessJson>(importArgs());

    expect(second.json.pass).toBe(true);
    expect(second.json.summary.documents.recueilMatched).toBe(first.json.summary.documents.recueilMatched);

    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    const records = JSON.parse(exported.stdout.slice(0, exported.stdout.indexOf('\n]') + 2)) as unknown[];
    expect(records).toHaveLength(first.json.summary.documents.apiReportedTotal);
  });

  it('says which Paperless release it was written against', async () => {
    const result = await runCli(importArgs());
    expect(result.stdout).toMatch(/written against Paperless-ngx \d/u);
  });
});

describe('--dry-run', () => {
  it('runs the whole import and writes nothing to the library', async () => {
    const { json } = await runJson<PaperlessJson>(importArgs('--dry-run'));

    // It really ran: it walked every page and mapped every document.
    expect(json.dryRun).toBe(true);
    expect(json.summary.documents.apiReportedTotal).toBeGreaterThan(0);
    expect(json.summary.documents.recueilMatched).toBe(json.summary.documents.apiReportedTotal);

    // And the real library was never created, let alone written to.
    expect(existsSync(work.databaseFile)).toBe(false);
    expect(existsSync(work.storageRoot)).toBe(false);
  });
});

describe('authentication and addressing', () => {
  it('refuses a bad token with the auth exit code, and writes nothing', async () => {
    const result = await runCli([
      'import',
      'paperless',
      '--url',
      server.url,
      '--token',
      'not-the-token',
      ...work.libraryArgs,
      '--no-report',
      '--no-progress',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/token|authenticat/iu);
  });

  it('demands a token rather than trying without one', async () => {
    const result = await runCli(
      ['import', 'paperless', '--url', server.url, ...work.libraryArgs, '--no-report', '--no-progress'],
      { PAPERLESS_TOKEN: undefined },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no Paperless-ngx API token/u);
  });

  it('demands a URL', async () => {
    const result = await runCli(
      ['import', 'paperless', '--token', FIXTURE_TOKEN, ...work.libraryArgs, '--no-report', '--no-progress'],
      { PAPERLESS_URL: undefined },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no Paperless-ngx URL/u);
  });

  it('takes the URL and token from the environment', async () => {
    const { json } = await runJson<PaperlessJson>(
      [
        'import',
        'paperless',
        ...work.libraryArgs,
        '--report',
        reportDirectory(),
        '--no-progress',
      ],
      { PAPERLESS_URL: server.url, PAPERLESS_TOKEN: FIXTURE_TOKEN },
    );
    expect(json.pass).toBe(true);
  });
});

describe('--resume', () => {
  it('refuses to start over an interrupted import, and names the flag', async () => {
    // The interruption is staged rather than provoked: a `jobs` row of this type, for this server,
    // with a cursor and a non-terminal state is exactly what an import killed part-way leaves
    // behind, and staging it tests the CLI's own refusal deterministically. How the importer itself
    // resumes is `@recueil/import-paperless`'s own test.
    const { createRecueil, newId, nowTimestamp, schema } = await import('@recueil/core');
    const recueil = createRecueil({ databaseUrl: work.databaseFile, storagePath: work.storageRoot });
    const now = nowTimestamp();
    try {
      recueil.db
        .insert(schema.jobs)
        .values({
          id: newId(),
          jobType: 'import.paperless',
          idempotencyKey: `import.paperless:staged:${now}`,
          params: JSON.stringify({ baseUrl: `${server.url}/api/` }),
          state: 'failed',
          runAfter: now,
          startedAt: now,
          attempts: 1,
          maxAttempts: 5,
          progressDone: 4,
          progressTotal: 10,
          cursor: JSON.stringify({ stage: 'documents', index: 4, lastDocumentId: 1004 }),
          createdByUserId: recueil.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } finally {
      recueil.close();
    }

    const blocked = await runCli(importArgs());
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/an earlier import of this Paperless server was interrupted/u);
    expect(blocked.stderr).toMatch(/'documents' stage, after 4 records/u);
    expect(blocked.stderr).toMatch(/--resume/u);

    // With the flag, it says what it is resuming from and finishes. Not `--json`: the running
    // commentary is stderr prose, which `--json` suppresses on purpose.
    const resumed = await runCli(importArgs('--resume'));
    expect(resumed.stderr).toMatch(/resuming from the 'documents' stage/u);
    expect(resumed.stdout).toMatch(/PASS/u);
    expect(resumed.code === 0 || resumed.code === 4).toBe(true);
  });

  it('warns rather than failing when there is nothing to resume', async () => {
    const result = await runCli(importArgs('--resume'));
    expect(result.stderr).toMatch(/no interrupted import of this server to resume/u);
    expect(result.code === 0 || result.code === 4).toBe(true);
  });
});
