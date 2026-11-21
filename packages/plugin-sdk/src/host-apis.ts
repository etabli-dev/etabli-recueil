/**
 * The capability namespaces the host hands a plugin through its context (spec/hooks.md §3.1).
 *
 * `spec/hooks.md` names them and `spec/plugin-api.md` §4 specifies `SettingsHandle`; the rest are
 * specified here, in plugin API 1.0.0, at the size the v1 hooks need. A namespace only exists on the
 * context when its permission is declared in the manifest (spec/plugin-api.md §3.7). Namespaces
 * whose phase has not arrived (`graph`, `sr`) are declared so the context type is complete, and the
 * host leaves them absent until it implements them.
 */
type Timestamp = string;
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

/** spec/plugin-api.md §4.1–4.3, verbatim. */
export interface SettingsHandle<T = JsonObject> {
  /** Current values, secrets resolved, defaults applied. Cheap; call it per invocation rather than caching. */
  get(): Promise<T>;
  /** Fires after a committed change. Does not fire for `x-recueil-restart` properties. */
  onChange(handler: (next: T, changedPaths: string[]) => Promise<void>): () => void;
  /** Writes the plugin's own settings. Requires `settings:write`; most plugins never need it. */
  patch(values: Partial<T>): Promise<T>;
}

export interface Logger {
  debug(message: string, detail?: JsonObject): void;
  info(message: string, detail?: JsonObject): void;
  warn(message: string, detail?: JsonObject): void;
  error(message: string, detail?: JsonObject): void;
}

/** A response the host has already read, so it can be cloned across the boundary. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 body. Binary bodies arrive through `bytes`. */
  text: string;
  /** Parsed when the body is JSON, else undefined. */
  json?: JsonValue;
}

/**
 * Outbound HTTP, permission `network:outbound`.
 *
 * Every request goes through the host's adaptive limiter for the calling resolver (CONCEPT §5.4):
 * it starts at the resolver's declared `rateLimit`, halves on 429/503, waits out `Retry-After`, and
 * recovers slowly. A 429 the host has already retried is raised as `RateLimitError`.
 */
export interface HttpApi {
  get(url: string, options?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<HttpResponse>;
  post(
    url: string,
    body: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<HttpResponse>;
}

/** Namespaced per plugin, TTL'd, cleared when the plugin's version changes. */
export interface CacheApi {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Per-invocation temporary space, removed when the invocation ends. */
export interface ScratchApi {
  /** An absolute path to a fresh directory owned by this invocation. */
  directory(): Promise<string>;
}

/** A read-only view of an item, in the shape the API renders it. */
export interface ItemSnapshot {
  id: string;
  itemType: string;
  title: string | null;
  extra: string | null;
  trashed: boolean;
  dateAdded: string;
  bibliographic: JsonObject | null;
  creators: { role: string; family: string | null; given: string | null; literal: string | null; orcid: string | null }[];
  tags: string[];
  attachments: { id: string; documentId: string | null; role: string; title: string | null; sha256: string | null }[];
}

/** Library reads, permission `library:read`. Writes go through the host's engines, never a plugin. */
export interface LibraryApi {
  getItem(itemId: string): Promise<ItemSnapshot | null>;
  /** Items carrying any of these identifiers (normalised as `Identifier.value`). */
  findByIdentifier(scheme: string, value: string): Promise<string[]>;
}

export interface SearchApi {
  /** Full-text and metadata search; returns item ids, best first. */
  query(text: string, limit: number): Promise<string[]>;
}

export interface JobsApi {
  /** Schedule follow-up work that is too long for a hook call. */
  enqueue(type: string, params: JsonObject, options?: { runAfter?: Timestamp }): Promise<string>;
}

export interface EventsApi {
  emit(type: string, payload: JsonObject): Promise<void>;
}

/** Content-store reads, permission `storage:read`. */
export interface StorageApi {
  exists(sha256: string): Promise<boolean>;
}

/** Arrives with Phase 5. */
export interface GraphApi {
  readonly phase: 5;
}

/** Arrives with Phase 7. */
export interface SystematicReviewApi {
  readonly phase: 7;
}

/** The names `types.generated.ts` resolves through. */
export interface HostApiTypes {
  SettingsHandle: SettingsHandle;
  Logger: Logger;
  LibraryApi: LibraryApi;
  GraphApi: GraphApi;
  SearchApi: SearchApi;
  SystematicReviewApi: SystematicReviewApi;
  StorageApi: StorageApi;
  JobsApi: JobsApi;
  HttpApi: HttpApi;
  EventsApi: EventsApi;
  CacheApi: CacheApi;
  ScratchApi: ScratchApi;
}
