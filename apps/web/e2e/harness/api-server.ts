/**
 * A real `recueil serve`, on an ephemeral port, over a temporary database.
 *
 * This is the point of the whole end-to-end suite: the browser talks to the Fastify application
 * that `apps/server` builds, over a socket, against SQLite on disk — not to a fake at the `fetch`
 * boundary. The unit tests already prove the client builds the request it means to; only a running
 * server can prove the request is one the server answers.
 *
 * The port is `0`, so the operating system picks one and two suites can run at once. The server
 * announces the address it actually got on its first log line, and that line is what is parsed
 * here rather than a port guessed in advance — the alternative, binding a socket to find a free
 * port and then closing it, is a race with every other process on the machine.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repositoryRoot } from './paths.js';

export interface ApiServerOptions {
  /**
   * Extra environment for the server process.
   *
   * The ingestion suite needs `RECUEIL_INGEST_ALLOWED_ROOTS` and a low confidence gate, and both
   * are deployment configuration rather than something a client can ask for — a folder root arrives
   * in a request body, and the server checks it against this list precisely because a request body
   * is hostile until it has been checked against something.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ApiServer {
  /** `http://127.0.0.1:<port>` — the origin the SPA server proxies to. */
  readonly url: string;
  /** The temporary directory holding the database and the blob store. */
  readonly dataDirectory: string;
  /** A directory inside `dataDirectory` that a watched-folder source may be pointed at. */
  readonly consumeDirectory: string;
  /** Everything the server wrote to stdout and stderr, for a failure report. */
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

/** How long to wait for the socket. Generous: the first run migrates a fresh database. */
const STARTUP_TIMEOUT_MS = 30_000;

/** Spawned with both streams piped, which `ChildProcess` alone does not promise the compiler. */
type ServerProcess = ChildProcess & { stdout: Readable; stderr: Readable };

export const startApiServer = async (options: ApiServerOptions = {}): Promise<ApiServer> => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'recueil-e2e-'));
  const consumeDirectory = join(dataDirectory, 'consume');
  await mkdir(consumeDirectory, { recursive: true });
  const entrypoint = join(repositoryRoot, 'apps', 'server', 'dist', 'server.js');

  const child = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RECUEIL_PORT: '0',
      RECUEIL_HOST: '127.0.0.1',
      RECUEIL_DATABASE_URL: `file:${join(dataDirectory, 'recueil.db')}`,
      RECUEIL_STORAGE_PATH: join(dataDirectory, 'storage'),
      // `info` is not noise here: the address the server bound to arrives on this stream, and the
      // request log is the first thing worth reading when a browser assertion fails.
      RECUEIL_LOG_LEVEL: 'info',
      RECUEIL_REQUIRE_AUTH: 'false',
      // The one directory a folder source in this suite is allowed to watch.
      RECUEIL_INGEST_ALLOWED_ROOTS: consumeDirectory,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ServerProcess;

  const lines: string[] = [];
  const log = (): string => lines.join('\n');

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      await terminate(child);
    }
    await rm(dataDirectory, { recursive: true, force: true });
  };

  try {
    const url = await waitForAddress(child, lines);
    return { url, dataDirectory, consumeDirectory, log, stop };
  } catch (cause) {
    await stop();
    throw new Error(`The Recueil server did not start.\n${log()}`, { cause });
  }
};

/**
 * The URL from the `recueil is serving` line.
 *
 * Pino writes one JSON object per line, so the stream is split on newlines and each line parsed;
 * anything that is not JSON — a Node warning, a stack trace — is kept for the report and skipped.
 */
const waitForAddress = (child: ServerProcess, lines: string[]): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffered = '';

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`No address after ${STARTUP_TIMEOUT_MS} ms.`)));
    }, STARTUP_TIMEOUT_MS);

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      act();
    };

    const consume = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        const url = servingUrl(line);
        if (url !== null) finish(() => resolve(url));
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) =>
      finish(() => reject(new Error(`The server exited early (code ${code}, signal ${signal}).`))),
    );
  });

const servingUrl = (line: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { msg?: unknown; url?: unknown };
  if (record.msg !== 'recueil is serving' || typeof record.url !== 'string') return null;
  return record.url;
};

/** `SIGTERM`, then `SIGKILL` if it is still there: the server drains in-flight requests first. */
const terminate = (child: ServerProcess): Promise<void> =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const hard = setTimeout(() => child.kill('SIGKILL'), 5_000);
    hard.unref();
    child.once('exit', () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill('SIGTERM');
  });
