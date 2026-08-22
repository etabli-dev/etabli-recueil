/**
 * The bootstrap: environment → library → application → socket.
 *
 * This is the whole of `recueil serve`, and it is deliberately the only module in the package that
 * touches `process`. Everything it does is in four steps, and each one fails loudly rather than
 * degrading:
 *
 * 1. `loadConfig` validates the environment and throws a `ConfigError` naming every bad variable.
 * 2. `createRecueil` opens the database, runs the migrations (idempotent, so this is safe on every
 *    boot) and prepares the content-addressed store.
 * 3. `buildApp` assembles the Fastify instance.
 * 4. `listen`, and then wait for a signal.
 *
 * **Shutdown.** `SIGTERM` and `SIGINT` both close the application, which drains in-flight requests
 * and then closes the library through the `onClose` hook. A second signal during that window is
 * taken as "I meant it" and exits immediately, and a shutdown that overruns
 * `RECUEIL_SHUTDOWN_TIMEOUT_MS` exits anyway — a container that will not stop is worse than a
 * request that does not finish, and `docker stop` will send `SIGKILL` in ten seconds regardless.
 */
import { createRecueil } from '@recueil/core';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { resolveVersion } from './version.js';

export interface StartOptions {
  /** Overrides the parsed environment. The desktop sidecar and tests supply their own. */
  readonly config?: ServerConfig;
  /** Overrides `process.env` when no `config` is given. */
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the reported release. */
  readonly version?: string;
  /** Install `SIGTERM`/`SIGINT` handlers. True unless a host process owns its own signals. */
  readonly handleSignals?: boolean;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly config: ServerConfig;
  /** `http://host:port`, with the port the OS actually assigned when `RECUEIL_PORT` was 0. */
  readonly url: string;
  /** Drain, close the library, and resolve. Idempotent. */
  stop(): Promise<void>;
}

/** Open a library, build the application and listen. Resolves once the socket is accepting. */
export const start = async (options: StartOptions = {}): Promise<RunningServer> => {
  const config = options.config ?? loadConfig(options.env);
  const version = resolveVersion(options.version, options.env);

  const recueil = createRecueil({
    databaseUrl: config.databaseUrl,
    storagePath: config.storagePath,
  });

  const app = buildApp({ config, recueil, version, closeLibraryOnShutdown: true });

  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    stopping ??= (async () => {
      const timer = setTimeout(() => {
        app.log.error(
          { timeoutMs: config.shutdownTimeoutMs },
          'shutdown timed out; exiting with requests still in flight',
        );
        process.exit(1);
      }, config.shutdownTimeoutMs);
      timer.unref();
      try {
        await app.close();
      } finally {
        clearTimeout(timer);
      }
    })();
    return stopping;
  };

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error({ err: error }, 'cannot listen');
    recueil.close();
    throw error;
  }

  const address = app.addresses()[0];
  const url = address === undefined ? `http://${config.host}:${config.port}` : formatAddress(address);

  app.log.info(
    {
      version,
      url,
      databaseUrl: config.databaseUrl,
      storagePath: config.storagePath,
      mode: config.mode,
    },
    'recueil is serving',
  );

  if (options.handleSignals !== false) installSignalHandlers(app, stop);

  return { app, config, url, stop };
};

const formatAddress = (address: { address: string; family: string; port: number }): string => {
  // An IPv6 literal needs brackets in a URL, and `::` is what `0.0.0.0`-equivalent binds look like.
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
};

const installSignalHandlers = (app: FastifyInstance, stop: () => Promise<void>): void => {
  let signalled = false;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      signalled = true;
      void stop().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
      // A second signal while the first is draining means the operator is out of patience.
      process.once(signal, () => {
        if (signalled) process.exit(130);
      });
    });
  }

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });
};

/** Whether this module was run directly, rather than imported by the CLI or a test. */
const isEntrypoint = (): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${invoked}`).href || import.meta.url.endsWith(invoked);
  } catch {
    return false;
  }
};

if (isEntrypoint()) {
  start().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      // No logger yet, and nothing useful to say in JSON: this is a person who mistyped a variable.
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG, sysexits(3)
    }
    process.stderr.write(`Recueil failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
