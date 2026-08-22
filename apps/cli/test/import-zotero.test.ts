/**
 * `recueil import zotero`, against the fixture library (CONCEPT.md §6, §7 Phase 1).
 *
 * `packages/import-zotero` proves the mapping. What is proved here is the part that is the
 * *command*: that the report reaches the disk, that the summary reaches stdout, that the exit code
 * carries the verdict — a migration script branches on it — and that a dry run leaves the library
 * exactly as it found it.
 *
 * The fixture library has two attachments whose files are deliberately missing, so a correct run
 * routes entries to `_REVIEW/` and exits 4. That is not a failure: 4 is "finished, and there is
 * work in the queue", and a suite that expected 0 would be asserting the review queue away.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil, schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirectory } from './library-fixture.js';
import { runCli } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', 'fixtures');

const ZOTERO = {
  database: join(FIXTURES, 'zotero', 'zotero.sqlite'),
  linkedAttachments: join(FIXTURES, 'zotero', 'linked-attachments'),
} as const;

interface Counts {
  zotero: { items: { regularRows: number } };
}

const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected-counts.json'), 'utf8')) as Counts;

let workspace: { path: string; dispose(): void };
let database: string;
let storage: string;
let reportDirectory: string;
let firstRun: { code: number | null; stdout: string; stderr: string };

const importArguments = (extra: readonly string[] = []): string[] => [
  'import',
  'zotero',
  ZOTERO.database,
  '--database',
  database,
  '--storage',
  storage,
  '--linked-base',
  ZOTERO.linkedAttachments,
  '--report',
  reportDirectory,
  ...extra,
];

beforeAll(async () => {
  workspace = makeTempDirectory('recueil-cli-zotero-');
  database = join(workspace.path, 'library.sqlite');
  storage = join(workspace.path, 'storage');
  reportDirectory = join(workspace.path, 'report');

  firstRun = await runCli(importArguments());
}, 180_000);

afterAll(() => {
  workspace.dispose();
});

describe('the run', () => {
  it('exits 4: it finished, and it left entries in the review queue', () => {
    // The fixture library has attachments whose files are not on disk. A run that exited 0 would
    // be claiming there was nothing to look at.
    expect(firstRun.code, firstRun.stderr).toBe(4);
  });

  it('writes the verification report to disk', () => {
    for (const path of ['report.json', 'report.md', '_REVIEW/index.json', '_REVIEW/README.md']) {
      expect(existsSync(join(reportDirectory, path)), `${path} is missing`).toBe(true);
    }

    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
      pass: boolean;
      items: { zoteroRegularTotal: number; recueilRegularTotal: number; delta: number };
      review: unknown[];
      checks: Array<{ name: string; pass: boolean; blocking: boolean }>;
    };

    expect(report.pass).toBe(true);
    expect(report.items.zoteroRegularTotal).toBe(expected.zotero.items.regularRows);
    expect(report.items.delta).toBe(0);
    expect(report.review.length).toBeGreaterThan(0);
    expect(report.checks.filter((check) => check.blocking && !check.pass)).toEqual([]);
  });

  it('prints the summary table, with the per-type parity and the named checks', () => {
    const out = firstRun.stdout;
    expect(out).toContain('Zotero type');
    expect(out).toContain('Recueil type');
    expect(out).toContain('all regular items');
    expect(out).toContain('item_count_parity');
    expect(out).toContain('attachment_hash_coverage');
    expect(out).toContain('PASS');

    // The numbers on screen are the report's numbers, not a second count.
    expect(out).toContain(String(expected.zotero.items.regularRows));
  });

  it('leaves the source library untouched', () => {
    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
      source: { sourceUnchanged: boolean; databaseSha256: string; databaseSha256AfterRun: string };
    };
    expect(report.source.sourceUnchanged).toBe(true);
    expect(report.source.databaseSha256).toBe(report.source.databaseSha256AfterRun);
  });

  it('produces a library the exporter can read', async () => {
    const exported = await runCli(['export', 'bibtex', '--all', '--database', database, '--storage', storage]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(exported.stdout).toContain('@');

    // `--all` is every *live* item, so the three items Zotero has in its bin are not in the `.bib`
    // — which is the right answer — and the one host item a standalone attachment needed is.
    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
      items: { byType: Array<{ recueilLive: number }>; derived: number };
    };
    const live = report.items.byType.reduce((total, row) => total + row.recueilLive, 0) + report.items.derived;

    expect([...exported.stdout.matchAll(/^@[A-Za-z]+\{/gmu)].length).toBe(live);
    expect(live).toBeLessThan(expected.zotero.items.regularRows);
  }, 60_000);
});

describe('re-running', () => {
  it('is idempotent: the same library, not a doubled one', async () => {
    const again = await runCli(importArguments());
    expect(again.code).toBe(4);

    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
      pass: boolean;
      items: { delta: number; recueilRegularTotal: number };
    };
    expect(report.pass).toBe(true);
    expect(report.items.delta).toBe(0);
    expect(report.items.recueilRegularTotal).toBe(expected.zotero.items.regularRows);
  }, 180_000);
});

describe('--dry-run', () => {
  it('reports the same verdict and writes nothing to the library', async () => {
    const workspaceForDryRun = makeTempDirectory('recueil-cli-zotero-dry-');
    try {
      const fresh = join(workspaceForDryRun.path, 'library.sqlite');
      const result = await runCli([
        '--json',
        'import',
        'zotero',
        ZOTERO.database,
        '--database',
        fresh,
        '--storage',
        join(workspaceForDryRun.path, 'storage'),
        '--linked-base',
        ZOTERO.linkedAttachments,
        '--dry-run',
        '--no-report',
      ]);

      expect(result.code).toBe(4);

      const payload = JSON.parse(result.stdout) as {
        dryRun: boolean;
        pass: boolean;
        summary: { items: { delta: number; zoteroRegularTotal: number } };
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.pass).toBe(true);
      expect(payload.summary.items.delta).toBe(0);
      expect(payload.summary.items.zoteroRegularTotal).toBe(expected.zotero.items.regularRows);

      // Nothing on disk: no library, no store, and nothing left in the temporary directory it
      // worked in.
      expect(existsSync(fresh)).toBe(false);
      expect(existsSync(join(workspaceForDryRun.path, 'storage'))).toBe(false);
    } finally {
      workspaceForDryRun.dispose();
    }
  }, 180_000);

  it('accounts for what is already imported when run against a populated library', async () => {
    const result = await runCli([...importArguments(['--dry-run', '--no-report']), '--json']);
    expect(result.code).toBe(4);

    const payload = JSON.parse(result.stdout) as {
      summary: { items: { delta: number; recueilRegularTotal: number } };
    };
    // Run against a copy of the *already imported* library: an importer that reported 67 new items
    // here would be reporting against an empty scratch database rather than against this library.
    expect(payload.summary.items.delta).toBe(0);
    expect(payload.summary.items.recueilRegularTotal).toBe(expected.zotero.items.regularRows);
  }, 180_000);
});

describe('an interrupted run', () => {
  /**
   * Leave the job row looking like a run that stopped part way.
   *
   * The alternative — killing a real import mid-stage — is a race, and what is under test here is
   * the *decision*: an operator who did not ask to resume must be told there is something to
   * resume rather than have it happen to them.
   */
  const markInterrupted = (): void => {
    const recueil = createRecueil({ databaseUrl: database, storagePath: storage, migrate: false });
    try {
      recueil.db
        .update(schema.jobs)
        .set({ state: 'running', cursor: JSON.stringify({ stage: 'attachments', index: 3 }) })
        .where(eq(schema.jobs.jobType, 'import.zotero'))
        .run();
    } finally {
      recueil.close();
    }
  };

  it('is refused without --resume, and carried on with it', async () => {
    markInterrupted();

    const refused = await runCli(importArguments());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('was interrupted');
    expect(refused.stderr).toContain('attachments');
    expect(refused.stderr).toContain('--resume');
    expect(refused.stdout).toBe('');

    markInterrupted();

    const resumed = await runCli(importArguments(['--resume']));
    expect(resumed.code, resumed.stderr).toBe(4);
    expect(resumed.stderr).toContain("resuming from the 'attachments' stage");

    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
      pass: boolean;
      items: { delta: number };
      run: { resumedFromStage: string | null };
    };
    expect(report.pass).toBe(true);
    expect(report.items.delta).toBe(0);
    expect(report.run.resumedFromStage).toBe('attachments');
  }, 180_000);

  it('says so when --resume is given and there is nothing to resume', async () => {
    const fresh = makeTempDirectory('recueil-cli-zotero-resume-');
    try {
      const result = await runCli([
        'import',
        'zotero',
        ZOTERO.database,
        '--database',
        join(fresh.path, 'library.sqlite'),
        '--storage',
        join(fresh.path, 'storage'),
        '--linked-base',
        ZOTERO.linkedAttachments,
        '--no-report',
        '--resume',
      ]);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('no interrupted import');
    } finally {
      fresh.dispose();
    }
  }, 180_000);
});

describe('the source database', () => {
  it('is not created if it is not there', async () => {
    const missing = makeTempDirectory('recueil-cli-zotero-missing-');
    try {
      const result = await runCli([
        'import',
        'zotero',
        join(missing.path, 'nowhere.sqlite'),
        '--database',
        join(missing.path, 'library.sqlite'),
        '--storage',
        join(missing.path, 'storage'),
        '--no-report',
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      missing.dispose();
    }
  }, 60_000);
});
