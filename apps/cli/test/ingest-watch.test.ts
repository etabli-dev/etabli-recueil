/**
 * `recueil ingest watch` — the configured sources, in the foreground.
 *
 * The interesting assertions are about what the command does *not* do: it does not move an original
 * that the store cannot confirm it holds, it does not run a source whose credential it cannot open,
 * and it does not silently ignore the configuration it read.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixture, makeWorkspace, runCli, runJson, spawnCli, waitForOutput, type Workspace } from './ingest-fixture.js';

interface WatchJson {
  command: string;
  passes: Array<{
    sourceId: string;
    offered: number;
    ingested: number;
    duplicates: number;
    review: number;
    failed: number;
    acknowledged: number;
    refusedAcks: number;
    ok: boolean;
  }>;
  totals: { offered: number; ingested: number; duplicates: number; review: number; failed: number; refusedAcks: number };
  ok: boolean;
  exitCode: number;
}

let work: Workspace;

beforeEach(() => {
  work = makeWorkspace('recueil-cli-watch-');
});

afterEach(() => {
  work.dispose();
});

describe('--folder --once', () => {
  it('makes one pass over the folder and files what it finds', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));

    const { code, json } = await runJson<WatchJson>([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--folder',
      consume,
      '--once',
      '--quiet-ms',
      '0',
    ]);

    expect(json.passes).toHaveLength(1);
    expect(json.totals.offered).toBe(1);
    // The document reaches the gate and is queued, which is the honest outcome for a plain office
    // document with no metadata worth being confident about.
    expect(json.totals.review).toBe(1);
    expect(json.totals.failed).toBe(0);
    expect(code).toBe(4);

    // The queue really has it, and the run really happened: both read back from the library.
    const review = await runJson<{ entries: unknown[] }>(['review', 'list', ...work.libraryArgs]);
    expect(review.json.entries).toHaveLength(1);

    const jobs = await runJson<{ jobs: Array<{ jobType: string }> }>(['queue', 'list', ...work.libraryArgs]);
    expect(jobs.json.jobs.some((job) => job.jobType === 'ingest.run')).toBe(true);
  });

  it('leaves the original alone by default', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));
    await runCli(['ingest', 'watch', ...work.libraryArgs, '--folder', consume, '--once', '--quiet-ms', '0']);

    expect(existsSync(join(consume, 'born-digital.pdf'))).toBe(true);
  });

  it('moves the original only once the store confirms it holds the bytes', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));

    const { json } = await runJson<WatchJson>([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--folder',
      consume,
      '--once',
      '--quiet-ms',
      '0',
      '--consume',
      'move',
      '--move-to',
      '.processed',
    ]);

    expect(json.totals.refusedAcks).toBe(0);
    expect(existsSync(join(consume, 'born-digital.pdf'))).toBe(false);
    const moved = readdirSync(join(consume, '.processed'), { recursive: true, encoding: 'utf8' });
    expect(moved.some((entry) => entry.endsWith('born-digital.pdf'))).toBe(true);
  });

  it('is idempotent across passes: the second pass has nothing new to offer', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));
    const args = ['ingest', 'watch', ...work.libraryArgs, '--folder', consume, '--quiet-ms', '0'];

    const first = await runJson<WatchJson>([...args, '--once']);
    expect(first.json.totals.offered).toBe(1);

    const second = await runJson<WatchJson>([...args, '--once']);
    // The folder source remembers what it has offered, so the same unchanged file is not offered
    // again — and if it were, stage 2 would answer it. Either way nothing is ingested twice.
    expect(second.json.totals.ingested).toBe(0);

    const review = await runJson<{ entries: unknown[] }>(['review', 'list', ...work.libraryArgs]);
    expect(review.json.entries).toHaveLength(1);
  });

  it('runs more than one folder in one pass', async () => {
    const scans = work.stage('scans', fixture('scans', 'born-digital.pdf'));
    const office = work.stage('office', fixture('scans', 'mixed-text-and-scan.pdf'));

    const { json } = await runJson<WatchJson>([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--folder',
      scans,
      '--folder',
      office,
      '--once',
      '--quiet-ms',
      '0',
    ]);

    expect(json.passes).toHaveLength(2);
    expect(json.totals.offered).toBe(2);
  });
});

describe('the configured sources', () => {
  it('refuses to run and says so when there is nothing to watch', async () => {
    // The library has to exist for the command to read its configuration.
    await runCli(['ingest', fixture('scans', 'born-digital.pdf'), ...work.libraryArgs, '--no-progress']);

    const result = await runCli(['ingest', 'watch', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/there is nothing to watch/u);
  });

  it('runs a folder source configured in the library', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));
    await stageConfiguredSources(work.databaseFile, work.storageRoot, [
      {
        name: 'the consume folder',
        kind: 'folder',
        sourceKind: 'folder',
        config: { root: consume, recursive: true },
      },
    ]);

    const { json } = await runJson<WatchJson>([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--once',
      '--quiet-ms',
      '0',
    ]);
    expect(json.passes[0]?.sourceId).toBe('the consume folder');
    expect(json.totals.offered).toBe(1);
  });

  it('names a WebDAV or IMAP source it cannot open rather than skipping it in silence', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));
    await stageConfiguredSources(work.databaseFile, work.storageRoot, [
      { name: 'the nextcloud share', kind: 'webdav', sourceKind: 'webdav', config: { url: 'https://example.invalid/dav' } },
      { name: 'the mailbox', kind: 'imap', sourceKind: 'imap', config: { host: 'mail.example.invalid' } },
      { name: 'the consume folder', kind: 'folder', sourceKind: 'folder', config: { root: consume } },
    ]);

    const result = await runCli(['ingest', 'watch', ...work.libraryArgs, '--once', '--quiet-ms', '0']);
    expect(result.stderr).toMatch(/the nextcloud share \(webdav\) was not started/u);
    expect(result.stderr).toMatch(/the mailbox \(imap\) was not started/u);
    expect(result.stderr).toMatch(/RECUEIL_SECRET_KEY/u);
    // And the folder source it *could* run, ran.
    expect(result.stdout).toMatch(/files offered\s+1/u);
  });

  it('ignores the configuration entirely with --no-configured', async () => {
    const configured = work.stage('configured', fixture('scans', 'born-digital.pdf'));
    const adhoc = work.stage('adhoc', fixture('scans', 'mixed-text-and-scan.pdf'));
    await stageConfiguredSources(work.databaseFile, work.storageRoot, [
      { name: 'configured', kind: 'folder', sourceKind: 'folder', config: { root: configured } },
    ]);

    const { json } = await runJson<WatchJson>([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--no-configured',
      '--folder',
      adhoc,
      '--once',
      '--quiet-ms',
      '0',
    ]);
    expect(json.passes).toHaveLength(1);
    expect(json.totals.offered).toBe(1);
  });
});

describe('running in the foreground', () => {
  it('stops on SIGINT and reports the passes it made', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));

    const child = spawnCli([
      'ingest',
      'watch',
      ...work.libraryArgs,
      '--folder',
      consume,
      '--interval',
      '250',
      '--quiet-ms',
      '0',
    ]);

    await waitForOutput(child, (_stdout, stderr) => /pass 1/u.test(stderr));
    child.kill('SIGINT');

    const { code } = await new Promise<{ code: number | null }>((resolve) => {
      child.on('close', (value) => {
        resolve({ code: value });
      });
    });

    // Exit 4: it filed nothing outright, because the one document went to the review queue.
    expect(code).toBe(4);
    const review = await runJson<{ entries: unknown[] }>(['review', 'list', ...work.libraryArgs]);
    expect(review.json.entries).toHaveLength(1);
  });
});

/**
 * Write rows into the server's `ingestion_sources` table.
 *
 * That table belongs to `apps/server` and is created by it, so the test creates it the same way and
 * fills it: this is the state an operator reaches by configuring a source through the API, and the
 * point of the test is what `recueil ingest watch` does when it finds it.
 */
const stageConfiguredSources = async (
  databaseFile: string,
  storageRoot: string,
  sources: ReadonlyArray<{ name: string; kind: string; sourceKind: string; config: Record<string, unknown> }>,
): Promise<void> => {
  const { createRecueil, newId, nowTimestamp } = await import('@recueil/core');
  mkdirSync(storageRoot, { recursive: true });
  const recueil = createRecueil({ databaseUrl: databaseFile, storagePath: storageRoot });

  try {
    recueil.connection.exec(`
      create table if not exists ingestion_sources (
        id text primary key not null,
        name text not null,
        kind text not null,
        enabled integer not null default 1,
        source_kind text not null,
        config text not null default '{}',
        secret_ciphertext text,
        secret_names text not null default '[]',
        consume_mode text not null default 'leave',
        consume_to text,
        last_run_job_id text,
        last_run_at text,
        last_error text,
        version integer not null default 1,
        created_at text not null,
        updated_at text not null
      )`);

    const now = nowTimestamp();
    const statement = recueil.connection.prepare(
      `insert into ingestion_sources (id, name, kind, enabled, source_kind, config, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      statement.run(newId(), source.name, source.kind, source.sourceKind, JSON.stringify(source.config), now, now);
    }
  } finally {
    recueil.close();
  }
};
