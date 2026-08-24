/**
 * The server's configuration, parsed from the environment.
 *
 * Secrets and deployment facts come from the environment (CONCEPT.md §5.15), and the environment is
 * a bag of strings that nobody validates unless someone chooses to. This module chooses to, with
 * the same Zod that validates request bodies, and it **fails loudly**: a mistyped port or an
 * unreachable log level stops the process at boot with a message naming every offending variable,
 * rather than producing a server that listens somewhere unexpected or logs nothing.
 *
 * Defaults are the ones a person running `recueil serve` on a laptop wants, not the ones a
 * container wants: `127.0.0.1` rather than `0.0.0.0`, and a database and a store under `./data`.
 * The container image overrides all four (deploy/Dockerfile), which is the right place for that
 * decision — an image knows it is in a container, a default cannot.
 */
import { resolve } from 'node:path';

import * as z from 'zod';

/** The pino levels, in pino's own order. `silent` is included because tests and the CLI want it. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Docker and local mode run identical code; only the shell differs (CONCEPT.md §5.1). */
export const RUN_MODES = ['server', 'sidecar'] as const;

export type RunMode = (typeof RUN_MODES)[number];

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATABASE_URL = 'file:./data/recueil.db';
const DEFAULT_STORAGE_PATH = './data/storage';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** An empty or whitespace-only variable means "not set", because `FOO=` in a `.env` file is common. */
const optionalString = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === '' ? undefined : value));

const withDefault = <T extends z.ZodTypeAny>(schema: T, fallback: unknown) =>
  optionalString.optional().transform((value) => value ?? fallback).pipe(schema);

const booleanish = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(value), {
    message: "expected a boolean: one of '1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'",
  })
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value));

const portSchema = z
  .string()
  .regex(/^\d{1,5}$/u, { message: 'expected a TCP port number between 0 and 65535' })
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => value >= 0 && value <= 65_535, {
    message: 'expected a TCP port number between 0 and 65535',
  });

/**
 * The raw shape, one field per variable.
 *
 * Kept separate from {@link ServerConfig} because the environment is strings and the application
 * wants numbers, booleans and absolute paths; the transform between the two lives in
 * {@link loadConfig} and is the only place that knows about `process.env`.
 */
export const ServerEnvSchema = z.object({
  RECUEIL_PORT: withDefault(portSchema, String(DEFAULT_PORT)),
  RECUEIL_HOST: withDefault(z.string().min(1), DEFAULT_HOST),
  RECUEIL_DATABASE_URL: withDefault(z.string().min(1), DEFAULT_DATABASE_URL),
  RECUEIL_STORAGE_PATH: withDefault(z.string().min(1), DEFAULT_STORAGE_PATH),
  RECUEIL_LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), DEFAULT_LOG_LEVEL),
  RECUEIL_MODE: withDefault(z.enum(RUN_MODES), 'server'),
  /** The public URL behind a reverse proxy. Needed for generated links (docs/self-hosting.qmd). */
  RECUEIL_BASE_URL: optionalString.optional().pipe(z.url().optional()),
  /**
   * Allowed browser origins, comma-separated. Unset means no cross-origin browser access at all,
   * which is the right default for a single-user server whose UI is served from its own origin.
   * `*` is honoured, and is a deliberate decision an operator has to type.
   */
  RECUEIL_CORS_ORIGIN: optionalString.optional(),
  /** Trust `X-Forwarded-*`. Only true behind a proxy you control, or client IPs become forgeable. */
  RECUEIL_TRUST_PROXY: withDefault(booleanish, 'false'),
  /** How long a shutdown waits for in-flight requests before the process exits anyway. */
  RECUEIL_SHUTDOWN_TIMEOUT_MS: withDefault(
    z
      .string()
      .regex(/^\d{1,7}$/u, { message: 'expected a whole number of milliseconds' })
      .transform((value) => Number.parseInt(value, 10)),
    '10000',
  ),
  /** The release string reported by `/health`. The image build stamps it (deploy/Dockerfile). */
  RECUEIL_VERSION: optionalString.optional(),
  /**
   * Refuse an unauthenticated call to `/api/v1`.
   *
   * Off by default, and that default is a deliberate reading of CONCEPT.md §5.15 rather than
   * laziness: v1 is a single-user server, usually on loopback or a Tailscale address, and a
   * first run that answers `401` before the operator has minted a token is a first run nobody
   * gets through. Turning it on is one variable, and a deployment reachable from anywhere but
   * loopback should turn it on.
   *
   * It changes *whether a token is required*, never *whether one is honoured*: a request that
   * presents a token is authenticated and scope-checked either way, so a write through a token
   * is attributable in the audit log in both modes (P4, AL3).
   */
  RECUEIL_REQUIRE_AUTH: withDefault(booleanish, 'false'),
  /**
   * The key that encrypts stored ingestion-source and storage-backend credentials.
   *
   * 32 bytes, as base64 or as 64 hex characters. Unset means this server will not store a
   * credential at all: a source with a password is refused with a 409 naming this variable, and a
   * source without one is configured as usual. There is deliberately no derived fallback — see
   * `ingestion/secrets.ts` (CONCEPT.md §5.15).
   */
  RECUEIL_SECRET_KEY: optionalString.optional(),
  /**
   * Directories a watched-folder source may be pointed at, comma-separated and absolute.
   *
   * Unset means "no allow-list", and a root is then any absolute directory that exists. Set it on
   * a deployment where the token holder and the machine owner are not the same person: a folder
   * root arrives in a request body, and a request body is hostile until it has been resolved and
   * checked against something.
   */
  RECUEIL_INGEST_ALLOWED_ROOTS: optionalString.optional(),
  /** Where the ingestion pipeline makes its scratch directories. Defaults to the OS temporary directory. */
  RECUEIL_INGEST_SCRATCH_PATH: optionalString.optional(),
  /** The stage-9 confidence gate (CONCEPT.md §5.3). At or above it an item is created. */
  RECUEIL_INGEST_CONFIDENCE_THRESHOLD: withDefault(
    z
      .string()
      .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u, { message: 'expected a number between 0 and 1' })
      .transform((value) => Number.parseFloat(value)),
    '0.75',
  ),
  /** The largest single uploaded file. Default 512 MiB — a large scan, not a disk image. */
  RECUEIL_MAX_UPLOAD_BYTES: withDefault(
    z
      .string()
      .regex(/^\d{1,13}$/u, { message: 'expected a whole number of bytes' })
      .transform((value) => Number.parseInt(value, 10))
      .refine((value) => value > 0, { message: 'expected a positive number of bytes' }),
    '536870912',
  ),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/** The parsed configuration the rest of the server is handed. Frozen: nothing reconfigures at run time. */
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  /** Absolute, because a relative store root would move with the process's working directory. */
  readonly storagePath: string;
  readonly logLevel: LogLevel;
  readonly mode: RunMode;
  readonly baseUrl?: string;
  /** `true` for `*`, a list of origins, or `false` when cross-origin browser access is off. */
  readonly corsOrigin: string[] | boolean;
  readonly trustProxy: boolean;
  readonly shutdownTimeoutMs: number;
  /** Set only when `RECUEIL_VERSION` was given; otherwise the package version is used. */
  readonly version?: string;
  /** Refuse unauthenticated `/api/v1` calls. See `RECUEIL_REQUIRE_AUTH`. */
  readonly requireAuth: boolean;
  /** Upload ceiling, in bytes, per file. */
  readonly maxUploadBytes: number;
  /** The credential-encryption key, unparsed. Absent when this server stores no credentials. */
  readonly secretKey?: string;
  /** Absolute directories a folder source may watch. Empty means no allow-list is configured. */
  readonly ingestAllowedRoots: readonly string[];
  /** Scratch root for the ingestion pipeline, when one was configured. */
  readonly ingestScratchPath?: string;
  /** The stage-9 confidence gate. */
  readonly ingestConfidenceThreshold: number;
}

/**
 * A configuration that could not be parsed.
 *
 * Carries the field-level detail as well as the rendered message, so a CLI can print the message
 * and a test can assert on the fields without matching prose.
 */
export class ConfigError extends Error {
  readonly issues: readonly { variable: string; message: string }[];

  constructor(issues: readonly { variable: string; message: string }[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(`Recueil cannot start: the environment is not valid.\n${lines.join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const parseCorsOrigin = (value: string | undefined): string[] | boolean => {
  if (value === undefined) return false;
  if (value === '*') return true;
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return origins.length > 0 ? origins : false;
};

/**
 * Read and validate the environment.
 *
 * Takes the environment as an argument rather than reaching for `process.env` directly, so that
 * tests and the desktop sidecar can supply their own without mutating the process.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServerConfig => {
  const result = ServerEnvSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.map(String).join('.') || '(environment)',
        message: issue.message,
      })),
    );
  }

  const parsed = result.data;

  return Object.freeze({
    port: parsed.RECUEIL_PORT,
    host: parsed.RECUEIL_HOST,
    databaseUrl: parsed.RECUEIL_DATABASE_URL,
    storagePath: resolve(parsed.RECUEIL_STORAGE_PATH),
    logLevel: parsed.RECUEIL_LOG_LEVEL,
    mode: parsed.RECUEIL_MODE,
    baseUrl: parsed.RECUEIL_BASE_URL,
    corsOrigin: parseCorsOrigin(parsed.RECUEIL_CORS_ORIGIN),
    trustProxy: parsed.RECUEIL_TRUST_PROXY,
    shutdownTimeoutMs: parsed.RECUEIL_SHUTDOWN_TIMEOUT_MS,
    version: parsed.RECUEIL_VERSION,
    requireAuth: parsed.RECUEIL_REQUIRE_AUTH,
    maxUploadBytes: parsed.RECUEIL_MAX_UPLOAD_BYTES,
    secretKey: parsed.RECUEIL_SECRET_KEY,
    ingestAllowedRoots: Object.freeze(parseRootList(parsed.RECUEIL_INGEST_ALLOWED_ROOTS)),
    ingestScratchPath:
      parsed.RECUEIL_INGEST_SCRATCH_PATH === undefined
        ? undefined
        : resolve(parsed.RECUEIL_INGEST_SCRATCH_PATH),
    ingestConfidenceThreshold: parsed.RECUEIL_INGEST_CONFIDENCE_THRESHOLD,
  });
};

/**
 * The allow-list, resolved to absolute paths.
 *
 * A relative entry is resolved against the process's working directory rather than rejected,
 * because an operator who wrote `./consume` in a compose file meant a directory and not a mistake —
 * but it is resolved *here*, once, so that every later comparison is between two absolute paths.
 */
const parseRootList = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => resolve(entry));
