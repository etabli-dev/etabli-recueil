import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnCli, waitForExit, waitForOutput } from './support.js';

/**
 * Phase 0's exit criterion, exercised end to end.
 *
 * "`recueil serve` returns health with an empty library" (CONCEPT.md §7) is the one thing this
 * build has to actually do, so it is tested against a real process, a real socket and a real
 * database file rather than against a mock of any of them. Port 0 asks the kernel for a free port,
 * which is both how the test avoids colliding with anything and how it proves the CLI reports the
 * port it actually bound rather than the one it was asked for.
 */

const SERVER_PACKAGE = '@recueil/server';

const probe = async (): Promise<string | undefined> => {
  try {
    await import(SERVER_PACKAGE);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const unavailable = await probe();

if (unavailable) {
  // A loud skip rather than a quiet pass: the suite must not report green for a `serve` it never
  // ran. Building the workspace (`pnpm -r build`) is what makes this run.
  console.warn(`[serve.test] skipped: ${SERVER_PACKAGE} could not be imported — ${unavailable}`);
}

describe.skipIf(unavailable !== undefined)('recueil serve', () => {
  let directory = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'recueil-cli-serve-'));
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('boots on an ephemeral port, answers /health, and shuts down on SIGTERM', async () => {
    const child = spawnCli([
      '--json',
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--database',
      `file:${join(directory, 'library.sqlite')}`,
      '--storage',
      join(directory, 'storage'),
      '--log-level',
      'silent',
    ]);

    let exitCode: number | null = null;
    try {
      const { stdout } = await waitForOutput(child, (out) => /"url"\s*:\s*"http/.test(out));

      const payload = JSON.parse(stdout) as {
        status: string;
        url: string;
        port: number;
        config: Record<string, unknown>;
      };

      expect(payload.status).toBe('listening');

      // Port 0 means "any free port", so a reported 0 would mean the CLI is echoing the request
      // back instead of reporting the socket.
      expect(payload.port).toBeGreaterThan(0);
      expect(payload.url).toBe(`http://127.0.0.1:${payload.port}`);

      // The flags must have won over the defaults.
      expect(payload.config['host']).toBe('127.0.0.1');
      expect(String(payload.config['storagePath'])).toContain(directory);
      expect(String(payload.config['databaseUrl'])).toContain(directory);

      const response = await fetch(`${payload.url}/health`);
      expect(response.status).toBe(200);

      const health: unknown = await response.json();
      expect(health).toBeTypeOf('object');
    } finally {
      child.kill('SIGTERM');
      ({ code: exitCode } = await waitForExit(child));
    }

    expect(exitCode, 'a signalled shutdown is a clean one').toBe(0);
  });

  it('takes the port from the environment when no flag overrides it', async () => {
    const child = spawnCli(['--json', 'serve'], {
      RECUEIL_HOST: '127.0.0.1',
      RECUEIL_PORT: '0',
      RECUEIL_DATABASE_URL: `file:${join(directory, 'env.sqlite')}`,
      RECUEIL_STORAGE_PATH: join(directory, 'env-storage'),
      RECUEIL_LOG_LEVEL: 'silent',
    });

    try {
      const { stdout } = await waitForOutput(child, (out) => /"url"\s*:\s*"http/.test(out));
      const payload = JSON.parse(stdout) as { url: string; config: Record<string, unknown> };
      expect(payload.config['host']).toBe('127.0.0.1');
      expect(String(payload.config['databaseUrl'])).toContain('env.sqlite');

      const response = await fetch(`${payload.url}/health`);
      expect(response.status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
  });

  it('prints the resolved configuration in prose when --json is not given', async () => {
    const child = spawnCli([
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--database',
      `file:${join(directory, 'prose.sqlite')}`,
      '--storage',
      join(directory, 'prose-storage'),
      '--log-level',
      'silent',
    ]);

    try {
      const { stderr } = await waitForOutput(child, (_out, err) => /listening http:\/\//.test(err));
      expect(stderr).toContain('Recueil server');
      expect(stderr).toContain('databaseUrl');
      expect(stderr).toContain('storagePath');
      expect(stderr).toContain('/health');
    } finally {
      child.kill('SIGINT');
      const { code } = await waitForExit(child);
      expect(code, 'Ctrl-C is a clean shutdown too').toBe(0);
    }
  });

  it('rejects a port that is not a port before it touches the server', async () => {
    const child = spawnCli(['serve', '--port', 'ninety']);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const { code } = await waitForExit(child);
    expect(code).toBe(1);
    expect(stderr).toContain('--port');
  });
});
