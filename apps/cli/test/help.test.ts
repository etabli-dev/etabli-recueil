import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMANDS, isImplemented } from '../src/catalogue.js';
import { commandEntry, PACKAGE_ROOT, runCli } from './support.js';

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

describe('recueil --help', () => {
  it('exits zero and names the programme', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: recueil');
  });

  it.each(COMMANDS.map((spec) => [spec.name, spec.phase] as const))(
    'lists `%s` with its phase (%i)',
    async (name, phase) => {
      const { stdout } = await runCli(['--help']);
      // The phase has to belong to the command's own entry. A help listing that names every
      // command and every phase but does not pair them is not what §5.12 asks for.
      const entry = commandEntry(stdout, name);
      expect(entry, `\`${name}\` is missing from the command list:\n${stdout}`).toBeDefined();
      expect(entry).toContain(`(Phase ${phase})`);
    },
  );

  it('marks the unimplemented commands as such', async () => {
    const { stdout } = await runCli(['--help']);
    for (const spec of COMMANDS.filter((candidate) => !isImplemented(candidate))) {
      const entry = commandEntry(stdout, spec.name);
      expect(entry, `\`${spec.name}\` should be flagged as unimplemented`).toContain('not implemented');
    }
  });

  it('does not mark the commands it ships as unimplemented, because they are not', async () => {
    const { stdout } = await runCli(['--help']);
    const shipped = COMMANDS.filter(isImplemented);
    expect(shipped.map((spec) => spec.name)).toEqual(['serve', 'import', 'export', 'backup', 'restore']);
    for (const spec of shipped) {
      expect(commandEntry(stdout, spec.name), `\`${spec.name}\` works`).not.toContain('not implemented');
    }
  });

  it('documents the global flags and the exit codes', async () => {
    const { stdout } = await runCli(['--help']);
    for (const flag of ['--json', '--quiet', '--verbose', '--no-colour', '--yes']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('Exit codes');
  });

  it('is also reachable as `recueil help`', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: recueil');
  });
});

describe('recueil --version', () => {
  it('prints the version from the manifest', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });
});

describe('the manifest', () => {
  it('points `recueil` at the built entry point', () => {
    expect(manifest.bin['recueil']).toBe('./dist/index.js');
  });

  it('keeps the shebang on the source entry point, so the build inherits it', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'index.ts'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});

describe('recueil serve --help', () => {
  it('documents every flag that overrides an environment variable', async () => {
    const result = await runCli(['serve', '--help']);
    expect(result.code).toBe(0);
    for (const [flag, variable] of [
      ['--port', 'RECUEIL_PORT'],
      ['--host', 'RECUEIL_HOST'],
      ['--database', 'RECUEIL_DATABASE_URL'],
      ['--storage', 'RECUEIL_STORAGE_PATH'],
    ]) {
      expect(result.stdout).toContain(flag);
      expect(result.stdout).toContain(variable);
    }
  });
});
