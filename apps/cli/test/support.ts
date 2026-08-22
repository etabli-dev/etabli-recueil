import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = join(here, '..');

/**
 * The tests drive the real entry point in a real child process.
 *
 * Calling `main()` in-process would be faster, but exit codes and signal handling are most of what
 * is being asserted here, and neither is observable without a process boundary. The source is run
 * through tsx so the suite does not depend on a prior build; `pnpm build` is verified separately by
 * CI running the build script.
 */
export const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'index.ts');

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  // Keeps tsx's loader notices out of the assertions.
  NODE_NO_WARNINGS: '1',
  // Deterministic output regardless of whether the suite runs on a terminal.
  NO_COLOR: '1',
  // The CLI's own configuration must come from the arguments under test, never from the
  // developer's shell.
  RECUEIL_HOST: undefined,
  RECUEIL_PORT: undefined,
  RECUEIL_DATABASE_URL: undefined,
  RECUEIL_STORAGE_PATH: undefined,
  ...extra,
});

/** stdin is closed: nothing the CLI does in these tests reads from it. */
export type CliProcess = ChildProcessByStdio<null, Readable, Readable>;

export const spawnCli = (args: readonly string[], env: NodeJS.ProcessEnv = {}): CliProcess =>
  spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    env: baseEnv(env),
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export const runCli = (args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawnCli(args, env);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });

/** Resolve once `predicate` is happy with everything the child has written so far. */
export const waitForOutput = (
  child: CliProcess,
  predicate: (stdout: string, stderr: string) => boolean,
  timeoutMs = 20_000,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `timed out after ${timeoutMs}ms waiting for output.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);

    const check = (): void => {
      if (!predicate(stdout, stderr)) return;
      finish();
      resolve({ stdout, stderr });
    };

    const onStdout = (chunk: string): void => {
      stdout += chunk;
      check();
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
      check();
    };
    const onClose = (): void => {
      finish();
      reject(new Error(`the process exited before the output arrived.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    };

    function finish(): void {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('close', onClose);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('close', onClose);
  });

export const waitForExit = (
  child: CliProcess,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the process did not exit within ${timeoutMs}ms of the signal.`));
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

/**
 * One command's entry from a help listing, joined into a single line.
 *
 * Commander wraps descriptions to the terminal width, so a command and its phase are frequently on
 * different lines. Asserting against the raw text would make the suite a test of the terminal
 * width; this collects the entry line together with its continuation lines — the ones indented
 * further than the command name — and normalises the whitespace.
 */
export const commandEntry = (help: string, name: string): string | undefined => {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s{2,}${name}\\b`).test(line));
  if (start === -1) return undefined;

  const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').length;
  const first = lines[start] ?? '';
  const indent = indentOf(first);
  const block = [first];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || indentOf(line) <= indent) break;
    block.push(line);
  }

  return block.join(' ').replace(/\s+/gu, ' ').trim();
};
