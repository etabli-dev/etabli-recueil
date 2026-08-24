/**
 * Scaffolding for the Phase 2 command tests.
 *
 * Everything here is real: a Recueil library on disk, the repository's own fixture files, and — for
 * the Paperless test — an HTTP server on the loopback interface. The CLI is driven as a child
 * process, as the rest of this suite drives it, because exit codes are half of what is being
 * asserted and they are not observable without a process boundary.
 *
 * There is no container anywhere and there must never be one: this machine has none, and a test
 * that needs OCRmyPDF or a Paperless-ngx instance is a test that never runs.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_ROOT, runCli, spawnCli, waitForOutput } from './support.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository's `fixtures/` directory, from `apps/cli/test/`. */
export const FIXTURES = resolve(here, '..', '..', '..', 'fixtures');

export const fixture = (...parts: string[]): string => join(FIXTURES, ...parts);

export const sha256OfFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export interface Workspace {
  readonly root: string;
  readonly databaseFile: string;
  readonly storageRoot: string;
  /** Library flags every data command takes, ready to spread into an argv. */
  readonly libraryArgs: string[];
  /** Write a file under the workspace and return its absolute path. */
  file(relativePath: string, contents: string): string;
  /** Copy a fixture into a directory under the workspace, and return the directory. */
  stage(directory: string, ...fixtures: string[]): string;
  dispose(): void;
}

export const makeWorkspace = (prefix = 'recueil-cli-ingest-'): Workspace => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'storage');

  return {
    root,
    databaseFile,
    storageRoot,
    libraryArgs: ['--database', databaseFile, '--storage', storageRoot],
    file(relativePath, contents) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, 'utf8');
      return path;
    },
    stage(directory, ...files) {
      const target = join(root, directory);
      mkdirSync(target, { recursive: true });
      for (const source of files) copyFileSync(source, join(target, source.split('/').pop() ?? 'file'));
      return target;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** Run the CLI with `--json` and parse stdout. Fails loudly rather than returning undefined. */
export const runJson = async <T = Record<string, unknown>>(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; json: T; stdout: string; stderr: string }> => {
  const result = await runCli(['--json', ...args], env);
  let json: T;
  try {
    json = JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `\`recueil --json ${args.join(' ')}\` did not print JSON (${String(error)}).\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return { code: result.code, json, stdout: result.stdout, stderr: result.stderr };
};

export { PACKAGE_ROOT, runCli, spawnCli, waitForOutput };
