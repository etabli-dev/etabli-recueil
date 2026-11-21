import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './support.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-cli-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recueil sync zotero', () => {
  it('explains the safe order of a first run', async () => {
    const result = await runCli(['sync', 'zotero', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--direction pull');
    expect(result.stdout).toContain('resolve');
  });

  it('refuses to run without an API key, and does not take one as a flag', async () => {
    const result = await runCli(['sync', 'zotero', '--database', join(dir, 'lib.sqlite')], {
      RECUEIL_ZOTERO_API_KEY: '',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('RECUEIL_ZOTERO_API_KEY');
    const unknown = await runCli(['sync', 'zotero', '--api-key', 'secret']);
    expect(unknown.code).not.toBe(0);
  });

  it('reads the library it is pointed at, and refuses one that does not exist', async () => {
    const database = join(dir, 'lib.sqlite');
    const storage = join(dir, 'store');
    const missing = await runCli(['sync', 'zotero', 'conflicts', '--database', database, '--storage', storage]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain(database);

    writeFileSync(join(dir, 'refs.bib'), '@article{a,title={T},year={2020}}\n');
    await runCli(['import', 'bibtex', join(dir, 'refs.bib'), '--database', database, '--storage', storage]);
    const empty = await runCli(['sync', 'zotero', 'conflicts', '--database', database, '--storage', storage]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('No open conflicts.');
  });
});
