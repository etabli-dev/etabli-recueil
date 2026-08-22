import { CliError } from './errors.js';
import { ExitCode } from './exit.js';

/**
 * The seam between the CLI and `@recueil/server`.
 *
 * `recueil serve` is the one command that is not an API client (ADR-0001): it starts the process
 * the other commands talk to. That makes the server the CLI's heaviest dependency, and the reason
 * it is loaded through a dynamic import here rather than a static one at the top of the file:
 *
 *   - `recueil --help`, `recueil --version` and every not-yet-implemented command must work
 *     without paying for Fastify, Drizzle and better-sqlite3 on start-up, and must keep working
 *     in a tree where the server has not been built;
 *   - the specifier is held in a constant so the type checker does not bind the CLI's build to the
 *     server's declaration files. What the CLI needs from the server is the narrow contract in
 *     this file, checked at runtime, with a clear message naming what was looked for when it is
 *     not met.
 *
 * The contract is two functions: one that turns the environment into a configuration, and one that
 * takes that configuration all the way to an accepting socket. The CLI deliberately does **not**
 * open the library itself and hand it to `buildApp`, even though the server exports that too — the
 * database and the content store have one owner, and it is the process that closes them. A CLI
 * that opened its own would be a second owner, and the failure mode is a library closed out from
 * under an in-flight write.
 */

const SERVER_PACKAGE = '@recueil/server';

const CONFIG_EXPORTS = ['loadConfig', 'resolveConfig', 'readConfig', 'createConfig', 'config'] as const;
const START_EXPORTS = ['start', 'startServer', 'serve'] as const;

/** Whatever the server calls its configuration. Only `host` and `port` are read by name. */
export interface ServerConfig extends Record<string, unknown> {
  host?: unknown;
  port?: unknown;
}

/** What `start` hands back: somewhere to point a browser, and a way to stop. */
export interface RunningServer {
  /** `http://host:port`, with the port the OS actually assigned when the request was 0. */
  readonly url: string;
  /** Drain, close the library, resolve. Expected to be idempotent. */
  stop(): Promise<void>;
}

export interface ServerOverrides {
  host?: string;
  port?: number;
  databaseUrl?: string;
  storagePath?: string;
  logLevel?: string;
}

/**
 * The environment variables the flags stand in for (deploy/.env.example).
 *
 * Overriding through the environment rather than through `start`'s arguments is deliberate: it is
 * the same path a container, a systemd unit and a shell all take, so a flag and an exported
 * variable cannot diverge in behaviour, and there is one implementation of "what does
 * RECUEIL_PORT mean" rather than two that must be kept in agreement.
 */
export const FLAG_ENV: Readonly<Record<keyof ServerOverrides, string>> = {
  host: 'RECUEIL_HOST',
  port: 'RECUEIL_PORT',
  databaseUrl: 'RECUEIL_DATABASE_URL',
  storagePath: 'RECUEIL_STORAGE_PATH',
  logLevel: 'RECUEIL_LOG_LEVEL',
};

/** Applies the flags to `env`, returning the variables that were set, for the verbose log. */
export const applyOverrides = (
  overrides: ServerOverrides,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const applied: Record<string, string> = {};
  for (const [flag, variable] of Object.entries(FLAG_ENV) as [keyof ServerOverrides, string][]) {
    const value = overrides[flag];
    if (value === undefined) continue;
    const text = String(value);
    env[variable] = text;
    applied[variable] = text;
  }
  return applied;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const pick = (
  module: Record<string, unknown>,
  names: readonly string[],
): [string, unknown] | undefined => {
  for (const name of names) {
    if (name in module && module[name] !== undefined) return [name, module[name]];
  }
  return undefined;
};

const missing = (module: Record<string, unknown>, what: string, names: readonly string[]): CliError =>
  new CliError(`${SERVER_PACKAGE} exports no ${what}.`, {
    detail: [
      '',
      `  Looked for: ${names.join(', ')}.`,
      `  Found: ${Object.keys(module).sort().join(', ') || '(nothing)'}.`,
      '',
      '  The CLI and the server are versioned together; a mismatch here means one of the two was',
      '  built from a different tree.',
    ],
  });

export const loadServerModule = async (): Promise<Record<string, unknown>> => {
  let loaded: unknown;
  try {
    loaded = await import(SERVER_PACKAGE);
  } catch (cause) {
    throw new CliError(`the server package ${SERVER_PACKAGE} could not be loaded.`, {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  `recueil serve` starts the server in this process, so the server package has to be',
        '  installed and built. From a source checkout:',
        '',
        '      pnpm install && pnpm -r build',
        '',
        `  The loader reported: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      cause,
    });
  }
  if (!isRecord(loaded)) {
    throw new CliError(`${SERVER_PACKAGE} did not export a module object.`);
  }
  return loaded;
};

/** Ask the server for its resolved configuration, after the flags have gone into the environment. */
export const resolveConfig = async (module: Record<string, unknown>): Promise<ServerConfig> => {
  const found = pick(module, CONFIG_EXPORTS);
  if (!found) throw missing(module, 'configuration loader', CONFIG_EXPORTS);

  const [name, value] = found;
  let config: unknown;
  try {
    config = typeof value === 'function' ? await (value as () => unknown)() : value;
  } catch (cause) {
    // The server validates the environment and refuses to start on a bad value, which is the right
    // behaviour and already the right message; the CLI's job is to pass it on, not restate it.
    throw new CliError(cause instanceof Error ? cause.message : String(cause), {
      exitCode: ExitCode.Usage,
      detail: ['', '  Set the variable, or pass the corresponding flag. See `recueil serve --help`.'],
      cause,
    });
  }
  if (!isRecord(config)) {
    throw new CliError(`${SERVER_PACKAGE}'s \`${name}\` did not produce a configuration object.`);
  }
  return config as ServerConfig;
};

/**
 * Open the library, build the application and listen.
 *
 * `handleSignals: false` because the CLI installs its own: it has a `--json` mode to honour and a
 * shutdown line to print, and two sets of handlers racing to call `process.exit` is not a design.
 */
export const startServer = async (
  module: Record<string, unknown>,
  config: ServerConfig,
): Promise<RunningServer> => {
  const found = pick(module, START_EXPORTS);
  if (!found) throw missing(module, 'start function', START_EXPORTS);

  const [name, start] = found;
  if (typeof start !== 'function') {
    throw new CliError(`${SERVER_PACKAGE}'s \`${name}\` is not a function.`);
  }

  let running: unknown;
  try {
    running = await (start as (options: unknown) => unknown)({ config, handleSignals: false });
  } catch (cause) {
    throw listenFailure(cause, config);
  }

  if (!isRecord(running) || typeof running['stop'] !== 'function') {
    throw new CliError(`${SERVER_PACKAGE}'s \`${name}\` did not return a running server.`, {
      detail: ['', '  Expected an object with a `url` and a `stop()` method.'],
    });
  }

  const url = typeof running['url'] === 'string' ? running['url'] : fallbackUrl(config);
  const stop = running['stop'] as () => Promise<void>;

  return { url, stop: () => Promise.resolve(stop.call(running)) };
};

const fallbackUrl = (config: ServerConfig): string => {
  const host = typeof config.host === 'string' ? config.host : '127.0.0.1';
  const port = typeof config.port === 'number' ? config.port : Number(config.port ?? 3000);
  return `http://${host}:${port}`;
};

const listenFailure = (cause: unknown, config: ServerConfig): CliError => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const where = `${String(config.host ?? '')}:${String(config.port ?? '')}`;

  if (message.includes('EADDRINUSE')) {
    return new CliError(`could not listen on ${where} — the address is already in use.`, {
      exitCode: ExitCode.Unreachable,
      detail: ['', '  Something is already on that port. Pass --port, or stop the other process.'],
      cause,
    });
  }
  if (message.includes('EACCES')) {
    return new CliError(`could not listen on ${where} — permission denied.`, {
      exitCode: ExitCode.Unreachable,
      detail: ['', '  Ports below 1024 need privileges. Use a higher port and a reverse proxy.'],
      cause,
    });
  }
  return new CliError(`the server did not start — ${message}`, {
    exitCode: ExitCode.JobFailed,
    detail: cause instanceof Error && cause.stack ? ['', ...cause.stack.split('\n').slice(1, 6)] : [],
    cause,
  });
};

/**
 * `0.0.0.0` and `::` are bind addresses, not addresses anyone can type into a browser.
 *
 * The bind address is still what gets printed as configuration; this only affects the URL offered
 * as a link, because "listening http://0.0.0.0:3000" is a URL that does not work everywhere it
 * looks like it should.
 */
export const browsableUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::' || parsed.hostname === '[::]') {
      parsed.hostname = 'localhost';
      // URL.toString() adds a trailing slash to an empty path; the caller wants a bare origin.
      return parsed.origin;
    }
    return parsed.origin;
  } catch {
    return url;
  }
};
