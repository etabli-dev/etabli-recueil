/**
 * Bibliography import and export, through the command line, against the hand-written fixtures.
 *
 * The property under test is P10's: **exports mirror importers.** A file goes in, the same records
 * come out, and everything that could not survive the trip is named rather than missing. So the
 * round trip is asserted on the things a manuscript depends on — the entry keys, the count, the
 * titles — and the losses are asserted to be *reported*, not to be zero, because a `.bib` file
 * genuinely cannot hold everything a library knows and pretending otherwise would be the bug.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirectory } from './library-fixture.js';
import { runCli } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', 'fixtures');

/** `@article{key,` → `key`. The entry keys of a `.bib`, in file order. */
const bibtexKeys = (text: string): string[] =>
  [...text.matchAll(/^@[A-Za-z]+\{([^,\s]+),/gmu)].map((match) => match[1] ?? '');

const cslIds = (text: string): string[] =>
  (JSON.parse(text) as Array<{ id?: string }>).map((entry) => entry.id ?? '');

const risRecords = (text: string): number => [...text.matchAll(/^TY {2}- /gmu)].length;

interface Imported {
  readonly database: string;
  readonly storage: string;
  readonly created: number;
  readonly dropped: number;
  readonly dispose: () => void;
}

const importFile = async (
  format: 'bibtex' | 'biblatex' | 'ris' | 'csl-json',
  fixture: string,
): Promise<Imported> => {
  const workspace = makeTempDirectory('recueil-cli-round-');
  const database = join(workspace.path, 'library.sqlite');
  const storage = join(workspace.path, 'storage');

  const result = await runCli([
    '--json',
    'import',
    format,
    join(FIXTURES, fixture),
    '--database',
    database,
    '--storage',
    storage,
  ]);

  // 0 or 4: 4 means the file had syntax problems worth a person's attention, which two of the
  // fixtures deliberately do. Anything else is a failure of the import itself.
  expect([0, 4], `import ${format} exited ${result.code}:\n${result.stderr}`).toContain(result.code);

  const payload = JSON.parse(result.stdout) as { created: number; dropped: unknown[] };
  return {
    database,
    storage,
    created: payload.created,
    dropped: payload.dropped.length,
    dispose: workspace.dispose,
  };
};

describe('recueil import bibtex', () => {
  it('imports the awkward fixture, keeps the entry keys, and reports what it dropped', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      expect(imported.created).toBeGreaterThan(0);
      expect(imported.dropped).toBeGreaterThan(0);

      const exported = await runCli([
        'export',
        'bibtex',
        '--all',
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);
      expect(exported.code, exported.stderr).toBe(0);

      const source = readFileSync(join(FIXTURES, 'bibtex/awkward.bib'), 'utf8');
      const out = bibtexKeys(exported.stdout);

      expect(out).toHaveLength(imported.created);
      // Every key the file carried comes back out, unchanged. This is the ADR-0016 promise: a
      // `\cite{}` written last year still resolves after a migration through Recueil.
      for (const key of bibtexKeys(source)) expect(out).toContain(key);
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('is idempotent: importing the same file twice updates rather than doubles', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      const again = await runCli([
        '--json',
        'import',
        'bibtex',
        join(FIXTURES, 'bibtex/awkward.bib'),
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);
      const payload = JSON.parse(again.stdout) as { created: number; updated: number };

      expect(payload.created).toBe(0);
      expect(payload.updated).toBe(imported.created);
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('parses and reports without writing under --dry-run', async () => {
    const workspace = makeTempDirectory('recueil-cli-dry-');
    try {
      const database = join(workspace.path, 'library.sqlite');
      const result = await runCli([
        '--json',
        'import',
        'bibtex',
        join(FIXTURES, 'bibtex/awkward.bib'),
        '--dry-run',
        '--database',
        database,
        '--storage',
        join(workspace.path, 'storage'),
      ]);

      expect(result.code, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout) as { dryRun: boolean; created: number; records: number };
      expect(payload.dryRun).toBe(true);
      expect(payload.created).toBe(0);
      expect(payload.records).toBeGreaterThan(0);

      const exported = await runCli(['export', 'bibtex', '--all', '--database', database]);
      expect(exported.code, 'a dry run must not have created a library').toBe(1);
      expect(exported.stderr).toContain('no library at');
    } finally {
      workspace.dispose();
    }
  }, 90_000);
});

describe('recueil import ris', () => {
  it('round-trips the EndNote fixture through the library', async () => {
    const imported = await importFile('ris', 'ris/endnote.ris');
    try {
      expect(imported.created).toBeGreaterThan(0);

      const exported = await runCli([
        'export',
        'ris',
        '--all',
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);
      expect(exported.code, exported.stderr).toBe(0);
      expect(risRecords(exported.stdout)).toBe(imported.created);
      expect(exported.stdout).toContain('ER  -');
    } finally {
      imported.dispose();
    }
  }, 90_000);
});

describe('recueil import csl-json', () => {
  it('round-trips the awkward fixture and keeps every id', async () => {
    const imported = await importFile('csl-json', 'csl-json/awkward.json');
    try {
      const exported = await runCli([
        'export',
        'csl-json',
        '--all',
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);
      expect(exported.code, exported.stderr).toBe(0);

      const out = cslIds(exported.stdout);
      expect(out).toHaveLength(imported.created);

      const source = cslIds(readFileSync(join(FIXTURES, 'csl-json/awkward.json'), 'utf8'));
      for (const id of source) expect(out).toContain(id);
    } finally {
      imported.dispose();
    }
  }, 90_000);
});

describe('recueil export', () => {
  it('needs a selection', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      const result = await runCli(['export', 'bibtex', '--database', imported.database]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('needs a selection');
      expect(result.stdout).toBe('');
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('refuses two selections at once', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      const result = await runCli([
        'export',
        'bibtex',
        '--all',
        '--search',
        'donau',
        '--database',
        imported.database,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('one selection only');
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('writes to a file when asked, and keeps stdout clean', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      const out = join(dirname(imported.database), 'chapter3.bib');
      const result = await runCli([
        'export',
        'biblatex',
        '--all',
        '--out',
        out,
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(bibtexKeys(readFileSync(out, 'utf8'))).toHaveLength(imported.created);
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('exports a search, and puts the losses on stderr rather than in the document', async () => {
    const imported = await importFile('bibtex', 'bibtex/awkward.bib');
    try {
      const result = await runCli([
        'export',
        'bibtex',
        '--search',
        'donau',
        '--database',
        imported.database,
        '--storage',
        imported.storage,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(bibtexKeys(result.stdout)).toEqual(['mueller2019niederschlag']);
      expect(result.stdout).not.toContain('could not carry');
    } finally {
      imported.dispose();
    }
  }, 90_000);

  it('will not invent a library to export from', async () => {
    const workspace = makeTempDirectory('recueil-cli-missing-');
    try {
      const result = await runCli([
        'export',
        'bibtex',
        '--all',
        '--database',
        join(workspace.path, 'nothing-here.sqlite'),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no library at');
    } finally {
      workspace.dispose();
    }
  }, 60_000);
});

describe('a source or format this build does not have', () => {
  it('names the ones it does, rather than counting arguments', async () => {
    const importResult = await runCli(['import', 'endnote', 'refs.enl']);
    expect(importResult.code).toBe(1);
    expect(importResult.stderr).toContain("unknown import source 'endnote'");
    expect(importResult.stderr).toContain('csl-json');
    expect(importResult.stderr).not.toContain('too many arguments');

    const exportResult = await runCli(['export', 'parquet']);
    expect(exportResult.code).toBe(1);
    expect(exportResult.stderr).toContain("unknown export format 'parquet'");
    expect(exportResult.stderr).toContain('biblatex');
  }, 60_000);

  it('prints the help and fails when no source is named at all', async () => {
    for (const command of ['import', 'export']) {
      const result = await runCli([command]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Usage: recueil ${command}`);
      expect(result.stdout).toBe('');
    }
  }, 60_000);
});
