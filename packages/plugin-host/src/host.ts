/**
 * The in-process plugin host (ADR-0012, spec/plugin-api.md §3).
 *
 * Boot follows §3.5: discover, validate, resolve compatibility, activate enabled plugins in load
 * order (built-ins first, then by name), build the hook registries and freeze them. A plugin
 * failure never stops the host (§3.8): an invalid manifest is not installed, an incompatible one is
 * marked `incompatible`, a module that will not import or an `activate` that throws or overruns is
 * marked `failed`, and the rest carry on.
 *
 * Every hook call runs under a deadline with its own `HookContext` (spec/hooks.md §3.1, §5). The
 * context is built from the manifest's permissions: an undeclared namespace is absent. That is a
 * contract check, not a security boundary — the plugin runs in this process (ADR-0012).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { newId, nowTimestamp, schema } from '@recueil/core';
import type { Actor as CoreActor, Recueil } from '@recueil/core';
import {
  PLUGIN_API_VERSION,
  PluginError,
  RateLimitError,
  TimeoutError,
  UpstreamUnavailableError,
  ValidationError,
} from '@recueil/plugin-sdk';
import type {
  Actor,
  CacheApi,
  Check,
  DedupRule,
  HookContext,
  HttpApi,
  HttpResponse,
  ItemSnapshot,
  LibraryApi,
  Logger,
  ManifestHook,
  PluginContext,
  PluginManifest,
  RecueilPlugin,
  Resolver,
  SettingsHandle,
} from '@recueil/plugin-sdk';
import { and, eq, isNull } from 'drizzle-orm';

import { AdaptiveLimiter, parseRetryAfter } from './limiter.js';
import { isCompatible, readManifest, validateManifest } from './manifest.js';
import { defaultsOf, missingRequired, resolveSecrets, secretStatus, validateSettings } from './settings.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PluginSource {
  /** A directory holding `recueil.plugin.json` and the built module it names. */
  directory: string;
  source: 'builtin' | 'npm' | 'url' | 'local';
}

export interface PluginHostOptions {
  plugins: readonly PluginSource[];
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Enable every built-in plugin on first install. Off by default (§3.4: never enabled by installation). */
  enableBuiltinsOnInstall?: boolean;
}

export type PluginState = 'active' | 'needs_configuration' | 'disabled' | 'failed' | 'incompatible';

export interface PluginStatus {
  name: string;
  version: string;
  source: PluginSource['source'];
  state: PluginState;
  reason: string | null;
  hooks: { type: string; id: string }[];
  secrets: Record<string, boolean>;
}

export interface RegisteredHook<T> {
  plugin: string;
  pluginVersion: string;
  hookId: string;
  type: string;
  priority: number;
  timeoutMs: number | null;
  impl: T;
}

export interface CallOptions {
  actor?: CoreActor;
  dryRun?: boolean;
  jobId?: string;
  /** Default deadline for this kind of call (spec/hooks.md §5). */
  defaultTimeoutMs: number;
  ceilingTimeoutMs: number;
}

interface Loaded {
  row: schema.PluginRow;
  manifest: PluginManifest;
  directory: string;
  module: Record<string, unknown> | null;
  controller: AbortController;
  limiters: Map<string, AdaptiveLimiter>;
}

const HOOK_TYPES_SERVED = new Set(['resolver', 'check', 'dedupRule']);

export class PluginHost {
  private readonly loaded = new Map<string, Loaded>();
  private readonly registry = { resolver: [] as RegisteredHook<Resolver>[], check: [] as RegisteredHook<Check>[], dedupRule: [] as RegisteredHook<DedupRule>[] };
  private readonly timeouts = new Map<string, number>();
  private readonly disabledForRun = new Set<string>();
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logLine: NonNullable<PluginHostOptions['log']>;
  private frozen = false;

  constructor(
    private readonly recueil: Recueil,
    private readonly options: PluginHostOptions,
  ) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? nowTimestamp;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.logLine = options.log ?? (() => undefined);
  }

  /* ======================================================================================== */
  /* Boot                                                                                       */
  /* ======================================================================================== */

  async boot(): Promise<void> {
    const discovered: { source: PluginSource; manifest: PluginManifest }[] = [];
    for (const source of this.options.plugins) {
      let raw: unknown;
      try {
        raw = readManifest(source.directory);
      } catch (error) {
        this.logLine('error', `plugin at ${source.directory}: no readable recueil.plugin.json (${messageOf(error)})`);
        continue;
      }
      const result = validateManifest(raw);
      if (!result.ok) {
        this.logLine('error', `plugin at ${source.directory}: invalid manifest: ${result.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
        continue;
      }
      discovered.push({ source, manifest: result.manifest });
    }

    // Load order: built-ins first, then everything else, each group by name (§3.5).
    discovered.sort((left, right) => {
      const builtin = Number(right.source.source === 'builtin') - Number(left.source.source === 'builtin');
      return builtin !== 0 ? builtin : left.manifest.name < right.manifest.name ? -1 : left.manifest.name > right.manifest.name ? 1 : 0;
    });

    for (const { source, manifest } of discovered) {
      const row = this.install(source, manifest);
      const entry: Loaded = {
        row,
        manifest,
        directory: source.directory,
        module: null,
        controller: new AbortController(),
        limiters: new Map(),
      };
      this.loaded.set(manifest.name, entry);
      if (row.enabled && row.installState === 'installed') await this.activate(entry);
    }
    this.frozen = true;
    this.sortRegistries();
  }

  /** Upsert the `plugins` row; settings keep the operator's values and gain new defaults (§4.1). */
  private install(source: PluginSource, manifest: PluginManifest): schema.PluginRow {
    const now = this.now();
    const existing = this.recueil.db.select().from(schema.plugins).where(eq(schema.plugins.name, manifest.name)).get();
    const compatible = isCompatible(manifest.recueilApi);
    const settingsSchema = manifest.settings as Record<string, unknown> | undefined;
    const settings = { ...defaultsOf(settingsSchema), ...(existing === undefined ? {} : (JSON.parse(existing.settings) as JsonObject)) };
    const values = {
      name: manifest.name,
      version: manifest.version,
      pluginApiRange: manifest.recueilApi,
      source: source.source,
      sourceRef: source.directory,
      manifest: JSON.stringify(manifest),
      permissions: JSON.stringify(manifest.permissions ?? []),
      hooks: JSON.stringify((manifest.hooks ?? []).map((hook) => hook.type)),
      settings: JSON.stringify(settings),
      installState: compatible ? ('installed' as const) : ('incompatible' as const),
      lastError: compatible ? null : `asks for plugin API ${manifest.recueilApi}; this host offers ${PLUGIN_API_VERSION}`,
      updatedAt: now,
    };
    if (existing === undefined) {
      const row: schema.PluginRow = {
        id: newId(),
        ...values,
        checksum: null,
        enabled: this.options.enableBuiltinsOnInstall === true && source.source === 'builtin',
        installedAt: now,
      };
      this.recueil.db.insert(schema.plugins).values(row).run();
      return row;
    }
    this.recueil.db.update(schema.plugins).set(values).where(eq(schema.plugins.id, existing.id)).run();
    return { ...existing, ...values };
  }

  private settingsValues(entry: Loaded): JsonObject {
    const row = this.recueil.db.select().from(schema.plugins).where(eq(schema.plugins.name, entry.manifest.name)).get();
    return JSON.parse(row?.settings ?? '{}') as JsonObject;
  }

  private async activate(entry: Loaded): Promise<void> {
    const name = entry.manifest.name;
    const settingsSchema = entry.manifest.settings as Record<string, unknown> | undefined;
    const resolved = resolveSecrets(settingsSchema, this.settingsValues(entry), this.env);
    if (missingRequired(settingsSchema, resolved).length > 0) return; // needs configuration: not an error

    try {
      if (entry.manifest.main === undefined) throw new Error('the manifest names no `main` module');
      const url = pathToFileURL(resolve(entry.directory, entry.manifest.main)).href;
      entry.module = (await import(url)) as Record<string, unknown>;
    } catch (error) {
      this.markFailed(entry, `the module would not import: ${messageOf(error)}`);
      return;
    }

    const plugin = (entry.module['default'] ?? {}) as RecueilPlugin;
    if (plugin.activate !== undefined) {
      try {
        await withDeadline(plugin.activate(this.pluginContext(entry)), 10_000, `${name} activate`);
      } catch (error) {
        this.markFailed(entry, `activate failed: ${messageOf(error)}`);
        return;
      }
    }

    for (const hook of entry.manifest.hooks ?? []) {
      if (!HOOK_TYPES_SERVED.has(hook.type)) continue;
      const impl = entry.module[hook.export];
      if (impl === undefined || impl === null || typeof impl !== 'object') {
        this.markFailed(entry, `hook '${hook.id}' names export '${hook.export}', which the module does not have`);
        this.unregister(name);
        return;
      }
      this.register(entry, hook, impl);
    }
  }

  private register(entry: Loaded, hook: ManifestHook, impl: object): void {
    if (this.frozen) throw new Error('hook registries are frozen after boot (spec/plugin-api.md §3.5)');
    const registered: RegisteredHook<never> = {
      plugin: entry.manifest.name,
      pluginVersion: entry.manifest.version,
      hookId: hook.id,
      type: hook.type,
      priority: hook.priority ?? 100,
      timeoutMs: hook.timeoutMs ?? null,
      impl: impl as never,
    };
    (this.registry[hook.type as keyof PluginHost['registry']] as RegisteredHook<unknown>[]).push(registered);
  }

  private unregister(name: string): void {
    for (const key of Object.keys(this.registry) as Array<keyof PluginHost['registry']>) {
      (this.registry[key] as RegisteredHook<unknown>[]) = (this.registry[key] as RegisteredHook<unknown>[]).filter(
        (hook) => hook.plugin !== name,
      );
    }
  }

  private sortRegistries(): void {
    const order = (left: RegisteredHook<unknown>, right: RegisteredHook<unknown>): number =>
      left.priority - right.priority ||
      (left.plugin < right.plugin ? -1 : left.plugin > right.plugin ? 1 : 0) ||
      (left.hookId < right.hookId ? -1 : left.hookId > right.hookId ? 1 : 0);
    for (const key of Object.keys(this.registry) as Array<keyof PluginHost['registry']>) {
      (this.registry[key] as RegisteredHook<unknown>[]).sort(order);
    }
  }

  private markFailed(entry: Loaded, reason: string): void {
    this.logLine('error', `plugin ${entry.manifest.name}: ${reason}`);
    this.recueil.db
      .update(schema.plugins)
      .set({ installState: 'failed', lastError: reason, updatedAt: this.now() })
      .where(eq(schema.plugins.name, entry.manifest.name))
      .run();
  }

  async shutdown(): Promise<void> {
    for (const entry of this.loaded.values()) {
      entry.controller.abort();
      const plugin = (entry.module?.['default'] ?? {}) as RecueilPlugin;
      if (plugin.deactivate !== undefined) {
        try {
          await withDeadline(plugin.deactivate(), 5_000, `${entry.manifest.name} deactivate`);
        } catch (error) {
          this.logLine('warn', `plugin ${entry.manifest.name}: deactivate failed: ${messageOf(error)}`);
        }
      }
    }
  }

  /* ======================================================================================== */
  /* Administration                                                                             */
  /* ======================================================================================== */

  list(): PluginStatus[] {
    return [...this.loaded.values()].map((entry) => {
      const row = this.recueil.db.select().from(schema.plugins).where(eq(schema.plugins.name, entry.manifest.name)).get()!;
      const settingsSchema = entry.manifest.settings as Record<string, unknown> | undefined;
      const values = JSON.parse(row.settings) as JsonObject;
      const resolved = resolveSecrets(settingsSchema, values, this.env);
      const missing = missingRequired(settingsSchema, resolved);
      const registered = Object.values(this.registry).some((hooks) => hooks.some((hook) => hook.plugin === row.name));
      let state: PluginState;
      let reason: string | null = null;
      if (row.installState === 'incompatible') [state, reason] = ['incompatible', row.lastError];
      else if (row.installState === 'failed') [state, reason] = ['failed', row.lastError];
      else if (!row.enabled) [state, reason] = ['disabled', 'not enabled'];
      else if (missing.length > 0) [state, reason] = ['needs_configuration', `needs ${missing.join(', ')}`];
      else state = registered || (entry.manifest.hooks ?? []).every((hook) => !HOOK_TYPES_SERVED.has(hook.type)) ? 'active' : 'disabled';
      return {
        name: row.name,
        version: row.version,
        source: row.source,
        state,
        reason,
        hooks: (entry.manifest.hooks ?? []).map((hook) => ({ type: hook.type, id: hook.id })),
        secrets: secretStatus(settingsSchema, values, this.env),
      };
    });
  }

  /** Enable or disable. Takes effect at the next boot of this host (the registries are frozen). */
  setEnabled(name: string, enabled: boolean): void {
    const entry = this.loaded.get(name);
    if (entry === undefined) throw new ValidationError(`no plugin named '${name}'`);
    const patch: Partial<schema.PluginRow> = { enabled, updatedAt: this.now() };
    if (enabled && entry.row.installState === 'failed') {
      patch.installState = 'installed';
      patch.lastError = null;
    }
    this.recueil.db.update(schema.plugins).set(patch).where(eq(schema.plugins.name, name)).run();
  }

  setSettings(name: string, patch: JsonObject): JsonObject {
    const entry = this.loaded.get(name);
    if (entry === undefined) throw new ValidationError(`no plugin named '${name}'`);
    const next = { ...this.settingsValues(entry), ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key];
    validateSettings(entry.manifest.settings as Record<string, unknown> | undefined, next);
    this.recueil.db
      .update(schema.plugins)
      .set({ settings: JSON.stringify(next), updatedAt: this.now() })
      .where(eq(schema.plugins.name, name))
      .run();
    return next;
  }

  resolvers(): readonly RegisteredHook<Resolver>[] {
    return this.registry.resolver.filter((hook) => !this.disabledForRun.has(`${hook.plugin}:${hook.hookId}`));
  }

  checks(): readonly RegisteredHook<Check>[] {
    return this.registry.check.filter((hook) => !this.disabledForRun.has(`${hook.plugin}:${hook.hookId}`));
  }

  dedupRules(): readonly RegisteredHook<DedupRule>[] {
    return this.registry.dedupRule.filter((hook) => !this.disabledForRun.has(`${hook.plugin}:${hook.hookId}`));
  }

  /* ======================================================================================== */
  /* Calls                                                                                      */
  /* ======================================================================================== */

  /**
   * Call one hook method under its deadline. A timeout raises `TimeoutError`; three consecutive
   * timeouts disable the hook for the rest of this host's life — one run (spec/hooks.md §5).
   */
  async call<T>(
    hook: RegisteredHook<object>,
    method: string,
    args: readonly unknown[],
    options: CallOptions,
  ): Promise<T> {
    const entry = this.loaded.get(hook.plugin);
    if (entry === undefined) throw new Error(`plugin ${hook.plugin} is not loaded`);
    const fn = (hook.impl as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new ValidationError(`${hook.plugin}:${hook.hookId} has no method '${method}'`);

    const timeoutMs = Math.min(hook.timeoutMs ?? options.defaultTimeoutMs, options.ceilingTimeoutMs);
    const controller = new AbortController();
    const onPluginAbort = () => controller.abort();
    entry.controller.signal.addEventListener('abort', onPluginAbort);
    const deadline = new Date(Date.now() + timeoutMs).toISOString();
    const scratchDirs: string[] = [];
    const ctx = this.hookContext(entry, hook, controller.signal, deadline, options, scratchDirs);
    const key = `${hook.plugin}:${hook.hookId}`;

    try {
      const result = await withDeadline(
        (fn as (...a: unknown[]) => Promise<T>).apply(hook.impl, [...args, ctx]),
        timeoutMs,
        `${key}.${method}`,
        () => controller.abort(),
      );
      this.timeouts.set(key, 0);
      return result;
    } catch (error) {
      if (error instanceof TimeoutError) {
        const count = (this.timeouts.get(key) ?? 0) + 1;
        this.timeouts.set(key, count);
        if (count >= 3) {
          this.disabledForRun.add(key);
          this.logLine('error', `${key} timed out three times in a row and is disabled for the rest of this run`);
        }
      }
      throw error;
    } finally {
      entry.controller.signal.removeEventListener('abort', onPluginAbort);
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ======================================================================================== */
  /* Contexts                                                                                   */
  /* ======================================================================================== */

  private pluginContext(entry: Loaded): PluginContext {
    return this.baseContext(entry, entry.controller.signal, [], null) as unknown as PluginContext;
  }

  private hookContext(
    entry: Loaded,
    hook: RegisteredHook<object>,
    signal: AbortSignal,
    deadline: string,
    options: CallOptions,
    scratchDirs: string[],
  ): HookContext {
    const base = this.baseContext(entry, signal, scratchDirs, hook);
    return {
      ...base,
      invocationId: newId(),
      hookId: hook.hookId,
      signal,
      deadline,
      attempt: 1,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      actor: toPluginActor(options.actor),
      dryRun: options.dryRun ?? false,
    } as HookContext;
  }

  private baseContext(
    entry: Loaded,
    signal: AbortSignal,
    scratchDirs: string[],
    hook: RegisteredHook<object> | null,
  ): Record<string, unknown> {
    const permissions = new Set(entry.manifest.permissions ?? []);
    const name = entry.manifest.name;
    const settingsSchema = entry.manifest.settings as Record<string, unknown> | undefined;
    const logger: Logger = {
      debug: (message) => this.logLine('debug', `[${name}] ${message}`),
      info: (message) => this.logLine('info', `[${name}] ${message}`),
      warn: (message) => this.logLine('warn', `[${name}] ${message}`),
      error: (message) => this.logLine('error', `[${name}] ${message}`),
    };
    const settings: SettingsHandle = {
      get: async () => resolveSecrets(settingsSchema, { ...defaultsOf(settingsSchema), ...this.settingsValues(entry) }, this.env),
      onChange: () => () => undefined,
      patch: async (values) => {
        if (!permissions.has('settings:write')) throw new ValidationError('settings:write is not declared');
        return this.setSettings(name, values as JsonObject);
      },
    };
    const ctx: Record<string, unknown> = {
      plugin: { name, version: entry.manifest.version, pluginApi: PLUGIN_API_VERSION },
      settings,
      log: logger,
      bytes: unavailableBytes,
      cache: this.cacheApi(entry),
      scratch: {
        directory: async () => {
          const dir = mkdtempSync(join(tmpdir(), 'recueil-plugin-'));
          scratchDirs.push(dir);
          return dir;
        },
      },
      now: this.now,
      signal,
    };
    if (permissions.has('network:outbound')) ctx['http'] = this.httpApi(entry, hook, signal);
    if (permissions.has('items:read')) ctx['library'] = this.libraryApi();
    return ctx;
  }

  private cacheApi(entry: Loaded): CacheApi {
    const name = entry.manifest.name;
    const version = entry.manifest.version;
    const db = this.recueil.db;
    return {
      get: async (key) => {
        const row = db
          .select()
          .from(schema.pluginCache)
          .where(and(eq(schema.pluginCache.pluginName, name), eq(schema.pluginCache.cacheKey, key)))
          .get();
        if (row === undefined || row.pluginVersion !== version || row.expiresAt <= this.now()) return undefined;
        return JSON.parse(row.value) as JsonValue;
      },
      set: async (key, value, ttlSeconds) => {
        const now = this.now();
        const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
        db.insert(schema.pluginCache)
          .values({ pluginName: name, pluginVersion: version, cacheKey: key, value: JSON.stringify(value), expiresAt, createdAt: now })
          .onConflictDoUpdate({
            target: [schema.pluginCache.pluginName, schema.pluginCache.cacheKey],
            set: { pluginVersion: version, value: JSON.stringify(value), expiresAt, createdAt: now },
          })
          .run();
      },
      delete: async (key) => {
        db.delete(schema.pluginCache)
          .where(and(eq(schema.pluginCache.pluginName, name), eq(schema.pluginCache.cacheKey, key)))
          .run();
      },
    };
  }

  private limiterFor(entry: Loaded, hook: RegisteredHook<object> | null): AdaptiveLimiter {
    const key = hook?.hookId ?? '*';
    let limiter = entry.limiters.get(key);
    if (limiter === undefined) {
      const declared = (hook?.impl as Resolver | undefined)?.rateLimit;
      limiter = new AdaptiveLimiter({
        requestsPerSecond: declared?.requestsPerSecond ?? 2,
        concurrency: declared?.concurrency ?? 1,
        sleep: this.sleep,
      });
      entry.limiters.set(key, limiter);
    }
    return limiter;
  }

  /**
   * Outbound HTTP for one plugin. Retries 429 and 5xx three times in all, waiting `Retry-After`
   * (or 2^attempt s) when that is at most 30 s — the Metadata Mender policy — and otherwise raises
   * `RateLimitError` / `UpstreamUnavailableError` carrying the wait. Errors name the host, never
   * the URL, because URLs carry keys.
   */
  private httpApi(entry: Loaded, hook: RegisteredHook<object> | null, signal: AbortSignal): HttpApi {
    const request = async (
      method: 'GET' | 'POST',
      url: string,
      body: string | undefined,
      options: { headers?: Record<string, string>; timeoutMs?: number } = {},
    ): Promise<HttpResponse> => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ValidationError('only http(s) URLs');
      const host = parsed.host;
      const limiter = this.limiterFor(entry, hook);
      for (let attempt = 1; ; attempt += 1) {
        const response = await limiter.schedule(async () => {
          const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
          try {
            return await this.fetchImpl(url, {
              method,
              headers: { 'User-Agent': `Recueil/${entry.manifest.name}@${entry.manifest.version}`, ...options.headers },
              ...(body === undefined ? {} : { body }),
              redirect: 'follow',
              signal: AbortSignal.any([signal, timeout]),
            });
          } catch (error) {
            throw new UpstreamUnavailableError(`request to ${host} failed`, { cause: error, retryAfterMs: 2000 });
          }
        });
        if (response.status === 429 || response.status >= 500) {
          const wait = parseRetryAfter(response.headers.get('Retry-After')) ?? 2 ** attempt * 1000;
          if (response.status === 429 || response.status === 503) limiter.throttled(wait);
          await response.body?.cancel();
          if (attempt < 3 && wait <= 30_000) {
            await this.sleep(wait);
            continue;
          }
          if (response.status === 429) throw new RateLimitError(`HTTP 429 (${host})`, { retryAfterMs: wait });
          throw new UpstreamUnavailableError(`HTTP ${response.status} (${host})`, { retryAfterMs: wait });
        }
        limiter.succeeded();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        const text = await response.text();
        let json: JsonValue | undefined;
        if ((headers['content-type'] ?? '').includes('json') && text !== '') {
          try {
            json = JSON.parse(text) as JsonValue;
          } catch {
            json = undefined;
          }
        }
        return { status: response.status, headers, text, ...(json === undefined ? {} : { json }) };
      }
    };
    return {
      get: (url, options) => request('GET', url, undefined, options),
      post: (url, body, options) => request('POST', url, body, options),
    };
  }

  private libraryApi(): LibraryApi {
    const recueil = this.recueil;
    return {
      getItem: async (itemId) => snapshotItem(recueil, itemId),
      findByIdentifier: async (scheme, value) => {
        const column = IDENTIFIER_COLUMNS[scheme];
        if (column === undefined) return [];
        return recueil.db
          .select({ id: schema.itemBibliographic.itemId })
          .from(schema.itemBibliographic)
          .where(and(eq(schema.itemBibliographic[column], value), isNull(schema.itemBibliographic.itemTrashedAt)))
          .all()
          .map((row) => row.id);
      },
    };
  }
}

const IDENTIFIER_COLUMNS: Record<string, 'doi' | 'pmid' | 'pmcid' | 'arxivId' | 'isbn' | 'issn' | 'openalexId'> = {
  doi: 'doi',
  pmid: 'pmid',
  pmcid: 'pmcid',
  arxiv: 'arxivId',
  isbn: 'isbn',
  issn: 'issn',
  openalex: 'openalexId',
};

/** The read-only item view plugins see (`ItemSnapshot`). */
export const snapshotItem = (recueil: Recueil, itemId: string): ItemSnapshot | null => {
  let record;
  try {
    record = recueil.library.getItem(itemId, { includeTrashed: true });
  } catch {
    return null;
  }
  const attachments = recueil.db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.itemId, itemId), isNull(schema.attachments.trashedAt)))
    .all();
  return {
    id: record.item.id,
    itemType: record.item.itemType,
    title: record.item.title,
    extra: record.item.extra,
    trashed: record.item.trashedAt !== null,
    dateAdded: record.item.dateAdded,
    bibliographic: record.bibliographic === null ? null : (JSON.parse(JSON.stringify(record.bibliographic)) as JsonObject),
    creators: recueil.creators.forItem(itemId).map(({ appearance, creator }) => ({
      role: appearance.role,
      family: creator.familyName,
      given: creator.givenName,
      literal: creator.literalName,
      orcid: creator.orcid,
    })),
    tags: recueil.tags.forItem(itemId).map((tag) => tag.name),
    attachments: attachments.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      role: row.role,
      title: row.title,
      sha256: row.documentId === null ? null : recueil.documents.getDocument(row.documentId).sha256,
    })),
  };
};

const unavailableBytes = new Proxy(
  {},
  {
    get: () => async () => {
      throw new PluginError('unavailable', 'the bytes API arrives with the first hook that needs it (ingestStage)');
    },
  },
);

/** Race a promise against a deadline; `onTimeout` lets the caller abort the work. */
export const withDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutError(`${label} exceeded ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** The SDK's actor vocabulary has no `import`; an importer acts as the system. */
const toPluginActor = (actor: CoreActor | undefined): Actor => {
  if (actor === undefined) return { type: 'system' };
  const type = actor.type === 'import' ? 'system' : actor.type;
  return {
    type,
    ...(actor.userId === undefined ? {} : { userId: actor.userId }),
    ...(actor.tokenId === undefined ? {} : { tokenId: actor.tokenId }),
  } as Actor;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
