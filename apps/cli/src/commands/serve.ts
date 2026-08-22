import { Command, InvalidArgumentError } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import {
  applyOverrides,
  browsableUrl,
  loadServerModule,
  resolveConfig,
  startServer,
  type RunningServer,
  type ServerConfig,
  type ServerOverrides,
} from '../server.js';
import type { Ui } from '../ui.js';

export interface ServeFlags {
  port?: number;
  host?: string;
  database?: string;
  storage?: string;
  logLevel?: string;
}

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError(
      'expected an integer between 0 and 65535 (0 asks the kernel for a free port).',
    );
  }
  return port;
};

/** Anything whose name suggests a credential prints as `****`: this output ends up in logs. */
const SECRETISH = /(token|secret|password|passwd|apikey|api_key|key|credential)/i;

const isSecret = (key: string, value: unknown): boolean =>
  SECRETISH.test(key) && typeof value === 'string' && value.length > 0;

const displayValue = (key: string, value: unknown): string => {
  if (value === undefined || value === null || value === '') return '(unset)';
  if (isSecret(key, value)) return '****';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

const redact = (config: ServerConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(config).sort()) {
    out[key] = isSecret(key, config[key]) ? '****' : config[key];
  }
  return out;
};

/** `shutdownTimeoutMs` → `RECUEIL_SHUTDOWN_TIMEOUT_MS`, so a printed line can be traced to a flag. */
const envNameFor = (key: string): string =>
  `RECUEIL_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

export const runServe = async (flags: ServeFlags, ui: Ui): Promise<void> => {
  const overrides: ServerOverrides = {
    host: flags.host,
    port: flags.port,
    databaseUrl: flags.database,
    storagePath: flags.storage,
    logLevel: flags.logLevel,
  };

  const applied = applyOverrides(overrides);
  for (const [variable, value] of Object.entries(applied)) {
    ui.detail(`flag override: ${variable}=${value}`);
  }

  const module = await loadServerModule();
  const config = await resolveConfig(module);

  const { bold, dim, cyan, green } = ui.colour;

  // Printed before the server starts, so that a database that will not open is diagnosed with the
  // configuration that was used to try, rather than without it.
  if (!ui.json) {
    ui.info(bold('Recueil server'));
    ui.info('');
    for (const key of Object.keys(config).sort()) {
      const marker = envNameFor(key) in applied ? dim(' (flag)') : '';
      ui.info(`  ${key.padEnd(20)} ${displayValue(key, config[key])}${marker}`);
    }
    ui.info('');
  }

  const running = await startServer(module, config);
  const url = browsableUrl(running.url);

  if (ui.json) {
    ui.outJson({
      status: 'listening',
      url,
      host: config.host ?? null,
      port: Number(new URL(url).port) || null,
      config: redact(config),
    });
  } else {
    ui.info(`${green('listening')} ${cyan(url)}`);
    ui.info(dim(`  health   ${url}/health`));
    ui.info(dim(`  api      ${url}/api/v1`));
    ui.info(dim('  stop     Ctrl-C, or SIGTERM'));
  }

  await waitForShutdown(running, ui);
};

/**
 * Hold the process open until a signal, then stop the server before letting it exit.
 *
 * A container stop is a `SIGTERM`, so the clean path has to be the signal path and not a `finally`
 * somewhere. The second signal is taken as "I meant it": the first shutdown is given the chance to
 * drain in-flight requests, the second is not.
 */
const waitForShutdown = (running: RunningServer, ui: Ui): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let shuttingDown = false;

    const onSignal = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        ui.warn(`${signal} again — exiting without waiting.`);
        process.exit(ExitCode.Success);
      }
      shuttingDown = true;
      ui.info('');
      ui.info(`${signal} received, shutting down.`);

      void running.stop().then(
        () => {
          ui.info('stopped.');
          // Unreferenced, so it never holds the process open by itself; it fires only if something
          // else does. A server that leaks a handle should say so rather than hang a `docker stop`.
          const net = setTimeout(() => {
            ui.warn('a handle is still open after shutdown; exiting anyway.');
            process.exit(ExitCode.Success);
          }, 5_000);
          net.unref();
          resolve();
        },
        (cause: unknown) => {
          reject(
            new CliError(
              `shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              { exitCode: ExitCode.JobFailed, cause },
            ),
          );
        },
      );
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });

export const registerServe = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command =>
  parent
    .command('serve')
    .description(describe('serve'))
    .option('-p, --port <port>', 'listen port (overrides RECUEIL_PORT)', parsePort)
    .option('-H, --host <host>', 'bind address (overrides RECUEIL_HOST)')
    .option('-d, --database <url>', 'database file or URL (overrides RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'content-addressed store root (overrides RECUEIL_STORAGE_PATH)')
    .option(
      '--log-level <level>',
      'trace | debug | info | warn | error | fatal | silent (overrides RECUEIL_LOG_LEVEL)',
    )
    .addHelpText(
      'after',
      [
        '',
        'Each flag above overrides the environment variable named beside it, and the environment',
        'overrides the built-in default. Flags win because they are the most local statement of',
        'intent. The defaults belong to @recueil/server; deploy/.env.example lists every variable.',
        '',
        'The resolved configuration goes to stderr on start, with anything that looks like a',
        'credential replaced by ****. With --json the same facts go to stdout as one object.',
        '',
        'Examples:',
        '  recueil serve',
        '  recueil serve --port 8080 --host 0.0.0.0',
        '  recueil serve --database ./library.sqlite --storage ./storage',
        '  recueil serve --port 0 --json          # any free port, reported on stdout',
      ].join('\n'),
    )
    .action(async (flags: ServeFlags) => {
      await runServe(flags, ui());
    });
