/**
 * What the *library* refuses to carry, as opposed to what the format cannot.
 *
 * Two live items may not claim one DOI (invariant B1) and two live items may not answer to one
 * citation key (ADR-0016). A bibliography assembled by hand over fifteen years breaks both rules
 * regularly, and P3 says the importer flags rather than guesses: it must not pick a winner, must
 * not renumber a key a manuscript already cites, and must not drop the record. It drops the
 * *value*, and says so.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirectory } from './library-fixture.js';
import { runCli } from './support.js';

interface ImportPayload {
  created: number;
  updated: number;
  failed: number;
  tags: number;
  notes: number;
  dropped: Array<{ recordKey: string | null; field: string; reason: string }>;
}

const importBib = async (
  directory: string,
  name: string,
  body: string,
  database: string,
): Promise<ImportPayload> => {
  const file = join(directory, name);
  writeFileSync(file, body, 'utf8');

  const result = await runCli([
    '--json',
    'import',
    'bibtex',
    file,
    '--database',
    database,
    '--storage',
    join(directory, 'storage'),
  ]);
  expect([0, 4], `import exited ${result.code}:\n${result.stderr}`).toContain(result.code);
  return JSON.parse(result.stdout) as ImportPayload;
};

describe('two entries claiming one DOI', () => {
  it('imports both items and drops the second DOI, with a reason', async () => {
    const workspace = makeTempDirectory('recueil-cli-collide-');
    try {
      const database = join(workspace.path, 'library.sqlite');
      const payload = await importBib(
        workspace.path,
        'collide.bib',
        [
          '@article{first2020, title = {The first}, author = {Alpha, Ada}, year = {2020}, doi = {10.1234/same}}',
          '@article{second2021, title = {The second}, author = {Beta, Ben}, year = {2021}, doi = {10.1234/SAME}}',
          '',
        ].join('\n'),
        database,
      );

      expect(payload.created).toBe(2);
      expect(payload.failed).toBe(0);

      const dropped = payload.dropped.filter((entry) => entry.field === 'doi');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.recordKey).toBe('second2021');
      expect(dropped[0]?.reason).toContain('B1');

      // Both items are in the library and both keep their citation key; only the duplicated
      // identifier went.
      const exported = await runCli([
        'export',
        'bibtex',
        '--all',
        '--database',
        database,
        '--storage',
        join(workspace.path, 'storage'),
      ]);
      expect(exported.code, exported.stderr).toBe(0);
      expect(exported.stdout).toContain('first2020');
      expect(exported.stdout).toContain('second2021');
      expect([...exported.stdout.matchAll(/doi = \{/gu)]).toHaveLength(1);
    } finally {
      workspace.dispose();
    }
  }, 90_000);
});

describe('a key another item already holds', () => {
  it('is dropped rather than reassigned, and the item is still imported', async () => {
    const workspace = makeTempDirectory('recueil-cli-key-');
    try {
      const database = join(workspace.path, 'library.sqlite');
      const storage = join(workspace.path, 'storage');

      await importBib(
        workspace.path,
        'first.bib',
        '@article{shared2019, title = {Held first}, author = {Alpha, Ada}, year = {2019}}\n',
        database,
      );

      // The same key, on a genuinely different work, arriving from a different format — so it is
      // not the same `(source_system, source_id)` and cannot be treated as a re-import. This is
      // the case that has to be reported rather than resolved by guessing.
      const risFile = join(workspace.path, 'second.ris');
      writeFileSync(
        risFile,
        ['TY  - JOUR', 'ID  - shared2019', 'TI  - A different work', 'AU  - Beta, Ben', 'PY  - 2024', 'ER  - ', ''].join('\n'),
        'utf8',
      );

      const result = await runCli([
        '--json',
        'import',
        'ris',
        risFile,
        '--database',
        database,
        '--storage',
        storage,
      ]);
      expect([0, 4], result.stderr).toContain(result.code);

      const payload = JSON.parse(result.stdout) as ImportPayload;
      expect(payload.created).toBe(1);
      expect(payload.failed).toBe(0);

      const dropped = payload.dropped.filter((entry) => entry.field === 'citationKey');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.recordKey).toBe('shared2019');
      expect(dropped[0]?.reason).toContain('ADR-0016');

      // Two items, one key between them: the one that had it keeps it.
      const exported = await runCli(['export', 'bibtex', '--all', '--database', database, '--storage', storage]);
      expect(exported.code, exported.stderr).toBe(0);
      expect([...exported.stdout.matchAll(/^@[A-Za-z]+\{/gmu)]).toHaveLength(2);
      expect([...exported.stdout.matchAll(/^@[A-Za-z]+\{shared2019,/gmu)]).toHaveLength(1);
    } finally {
      workspace.dispose();
    }
  }, 90_000);

  it('re-importing the same file updates the same items rather than doubling them', async () => {
    const workspace = makeTempDirectory('recueil-cli-idem-');
    try {
      const database = join(workspace.path, 'library.sqlite');
      const body = '@article{again2019, title = {Once}, author = {Alpha, Ada}, year = {2019}}\n';

      const first = await importBib(workspace.path, 'again.bib', body, database);
      expect(first.created).toBe(1);

      const second = await importBib(workspace.path, 'again.bib', body, database);
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
    } finally {
      workspace.dispose();
    }
  }, 90_000);
});

describe('what a bibliography brings besides the record', () => {
  it('writes the keywords as tags and reports a `file` field rather than fetching it', async () => {
    const workspace = makeTempDirectory('recueil-cli-extras-');
    try {
      const database = join(workspace.path, 'library.sqlite');
      const payload = await importBib(
        workspace.path,
        'extras.bib',
        [
          '@article{extras2022,',
          '  title = {With extras},',
          '  author = {Gamma, Gita},',
          '  year = {2022},',
          '  keywords = {hydrology, danube},',
          '  file = {:/home/somebody/Zotero/storage/ABCD1234/paper.pdf:application/pdf},',
          '}',
          '',
        ].join('\n'),
        database,
      );

      expect(payload.created).toBe(1);
      expect(payload.tags).toBe(2);

      const attachment = payload.dropped.filter((entry) => entry.field === 'attachment');
      expect(attachment).toHaveLength(1);
      expect(attachment[0]?.reason).toContain('ingestion pipeline');
    } finally {
      workspace.dispose();
    }
  }, 90_000);
});

describe('a file with nothing importable in it', () => {
  it('fails rather than reporting a successful import of nothing', async () => {
    const workspace = makeTempDirectory('recueil-cli-empty-');
    try {
      const file = join(workspace.path, 'empty.bib');
      writeFileSync(file, '% just a comment\n', 'utf8');

      const result = await runCli([
        'import',
        'bibtex',
        file,
        '--database',
        join(workspace.path, 'library.sqlite'),
        '--storage',
        join(workspace.path, 'storage'),
      ]);

      expect(result.code).toBe(5);
      expect(result.stderr).toContain('no records in');
      expect(result.stdout).toBe('');
    } finally {
      workspace.dispose();
    }
  }, 60_000);
});
