/**
 * The service worker.
 *
 * It exists for one feature and is kept to it. CONCEPT.md §7 Phase 2 lists "PWA upload as interim
 * mobile capture", and §5.14 says mobile is capture and reading — so this worker answers the share
 * target, and offers just enough caching that the application shell opens on a train. It is not a
 * sync engine: §2 puts offline-first sync in the non-goals and P1 says the server is the source of
 * truth.
 *
 * The rule that keeps it honest is one line in `handleFetch`: **`/api` and `/health` are never
 * cached and never served from a cache.** A document manager that answered a request for the item
 * list out of a week-old cache would be lying about the library, and would do it invisibly. The
 * shell is cached because it is content-hashed and immutable; the data is not, because it is not.
 *
 * The share target is a `POST` from the operating system to `/share`. Only a service worker can
 * answer it, because there is no page yet. It reads the multipart body, stashes each file in the
 * Cache API under a one-time key (`share-protocol.ts`), and answers `303 See Other` to
 * `/share?share=<key>` so the page can pick them up and upload them. Answering the POST with the
 * application itself would leave the browser with a POST in its history.
 *
 * The module exports its handlers and only installs listeners when it is actually running as a
 * worker, so `test/service-worker.test.ts` can drive them against a fake cache in Node.
 */
import {
  SHARE_CACHE,
  SHARE_FILENAME_HEADER,
  SHARE_KEY_PARAM,
  SHARE_PATH,
  SHARE_STASHED_AT_HEADER,
  SHARE_TEXT_HEADER,
  SHARE_TTL_MS,
  newShareId,
  parseShareKey,
  safeShareFilename,
  shareKey,
} from './share-protocol.js';

/** The shell cache. Bumping the version is how a deploy drops the previous shell. */
export const SHELL_CACHE = 'recueil-shell-v1';

/** The document served for any navigation the network cannot answer. */
export const SHELL_ENTRY = '/';

/** Paths the worker must never touch. The list is short and its shortness is the point. */
export const isDataPath = (pathname: string): boolean =>
  pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/');

/** Content-hashed build output and static icons: safe to serve from the cache first. */
export const isImmutableAsset = (pathname: string): boolean =>
  pathname.startsWith('/assets/') || pathname.startsWith('/icons/') || pathname === '/manifest.webmanifest';

/* -------------------------------------------------------------------------------------------- */
/* The share target                                                                                */
/* -------------------------------------------------------------------------------------------- */

export interface ShareStashResult {
  /** Where to send the browser. Always a `GET`, so the POST does not end up in the history. */
  location: string;
  /** How many files were stashed. Zero is a valid share — a URL with no file. */
  fileCount: number;
}

/**
 * Read the shared form and put it where the page can reach it.
 *
 * Each file becomes a `Response` whose body is the bytes and whose headers carry the name, the type
 * and when it arrived. The name is passed through `safeShareFilename` on the way in rather than on
 * the way out, so nothing downstream ever sees the raw string.
 */
export const stashShare = async (
  cache: Cache,
  form: FormData,
  options: { id: string; now: Date },
): Promise<ShareStashResult> => {
  const note = firstString(form, ['text', 'url']);
  const title = firstString(form, ['title']);
  const files = form.getAll('file').filter((value): value is File => value instanceof File);

  let index = 0;
  for (const file of files) {
    const filename = safeShareFilename(file.name, `shared-${options.id}-${String(index)}`);
    const headers = new Headers({
      'content-type': file.type === '' ? 'application/octet-stream' : file.type,
      [SHARE_FILENAME_HEADER]: encodeURIComponent(filename),
      [SHARE_STASHED_AT_HEADER]: options.now.toISOString(),
    });
    const carried = note ?? title;
    if (carried !== null) headers.set(SHARE_TEXT_HEADER, encodeURIComponent(carried));
    await cache.put(shareKey(options.id, index), new Response(file, { headers }));
    index += 1;
  }

  return {
    location: `${SHARE_PATH}?${SHARE_KEY_PARAM}=${options.id}`,
    fileCount: index,
  };
};

const firstString = (form: FormData, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/**
 * Answer the share POST.
 *
 * A failure here still redirects, with `share=` absent, because the alternative is the operating
 * system showing its own "the app could not handle this" dialogue — which tells the user nothing
 * about what went wrong. The page says it plainly instead.
 */
export const handleShareTarget = async (
  request: Request,
  context: { caches: CacheStorage; crypto: Pick<Crypto, 'getRandomValues'>; now: () => Date },
): Promise<Response> => {
  try {
    const form = await request.formData();
    const cache = await context.caches.open(SHARE_CACHE);
    const result = await stashShare(cache, form, { id: newShareId(context.crypto), now: context.now() });
    return Response.redirect(new URL(result.location, request.url).toString(), 303);
  } catch {
    return Response.redirect(new URL(`${SHARE_PATH}?error=stash`, request.url).toString(), 303);
  }
};

/**
 * Drop shares nobody collected.
 *
 * Run on activation rather than on a timer: a worker has no reliable timer, and activation is the
 * moment there is definitely a worker running. An entry with no timestamp is treated as expired,
 * because an entry this worker cannot date is one it did not write in a format it understands.
 */
export const sweepShares = async (cache: Cache, now: Date, ttlMs = SHARE_TTL_MS): Promise<number> => {
  const keys = await cache.keys();
  let removed = 0;
  for (const key of keys) {
    if (parseShareKey(key.url) === null) continue;
    const stored = await cache.match(key);
    const stampedAt = stored?.headers.get(SHARE_STASHED_AT_HEADER) ?? null;
    const stamp = stampedAt === null ? Number.NaN : Date.parse(stampedAt);
    if (Number.isNaN(stamp) || now.getTime() - stamp > ttlMs) {
      await cache.delete(key);
      removed += 1;
    }
  }
  return removed;
};

/* -------------------------------------------------------------------------------------------- */
/* Fetching                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export interface FetchContext {
  caches: CacheStorage;
  fetch: typeof fetch;
  /** The scope's own origin. Passed in rather than read from `self`, so a test can supply one. */
  origin: string;
}

/**
 * The routing table, as a function, so it can be asserted on.
 *
 * Returns `null` for anything the worker should not touch at all — which is most things. A worker
 * that answers every request is a worker that has to be debugged every time a request is wrong.
 */
export const handleFetch = (request: Request, context: FetchContext): Promise<Response> | null => {
  const url = new URL(request.url);

  if (url.origin !== context.origin) return null;
  if (isDataPath(url.pathname)) return null;
  if (request.method !== 'GET') return null;

  if (isImmutableAsset(url.pathname)) return cacheFirst(request, context);
  if (request.mode === 'navigate') return networkFirstShell(request, context);
  return null;
};

/** Content-hashed: if it is in the cache it is the right bytes, and the network is not asked. */
const cacheFirst = async (request: Request, context: FetchContext): Promise<Response> => {
  const cache = await context.caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;
  const response = await context.fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
};

/**
 * Navigations: the network, then the cached shell.
 *
 * Network first, not cache first, because the shell is the one cached thing that is *not* content
 * hashed — its URL is `/` — so serving it from the cache while the server has a newer build would
 * pin the client to an old bundle until the cache version changed.
 */
const networkFirstShell = async (request: Request, context: FetchContext): Promise<Response> => {
  const cache = await context.caches.open(SHELL_CACHE);
  try {
    const response = await context.fetch(request);
    if (response.ok) await cache.put(SHELL_ENTRY, response.clone());
    return response;
  } catch (cause) {
    const shell = await cache.match(SHELL_ENTRY);
    if (shell !== undefined) return shell;
    throw cause;
  }
};

/* -------------------------------------------------------------------------------------------- */
/* Installation                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The slice of `ServiceWorkerGlobalScope` this worker uses.
 *
 * Declared here rather than pulled in from `lib.webworker.d.ts`, because that library redeclares
 * half of the DOM and cannot be loaded alongside it in one compilation. The alternative — a second
 * tsconfig for one file — buys a fuller set of types for a file that uses eight members of it.
 */
export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

export interface WorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  readonly caches: CacheStorage;
  readonly crypto: Pick<Crypto, 'getRandomValues'>;
  readonly clients: { claim(): Promise<void> };
  readonly location: { readonly origin: string };
  skipWaiting(): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Wire the handlers onto a scope. Exported so a test can install onto a fake one. */
export const install = (scope: WorkerScope): void => {
  scope.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(SHELL_CACHE);
        // Only the entry document, and failing to fetch it is not a reason to refuse to install: an
        // install that happens while the server is restarting must still produce a worker.
        await cache.add(SHELL_ENTRY).catch(() => undefined);
        await scope.skipWaiting();
      })(),
    );
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await scope.caches.keys();
        await Promise.all(
          names
            .filter((name) => name !== SHELL_CACHE && name !== SHARE_CACHE && name.startsWith('recueil-'))
            .map((name) => scope.caches.delete(name)),
        );
        const shares = await scope.caches.open(SHARE_CACHE);
        await sweepShares(shares, new Date());
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method === 'POST' && url.pathname === SHARE_PATH) {
      event.respondWith(
        handleShareTarget(event.request, {
          caches: scope.caches,
          crypto: scope.crypto,
          now: () => new Date(),
        }),
      );
      return;
    }
    const handled = handleFetch(event.request, {
      caches: scope.caches,
      fetch: (input, init) => scope.fetch(input, init),
      origin: scope.location.origin,
    });
    if (handled !== null) event.respondWith(handled);
  });
};

/**
 * Install, but only when this really is a worker.
 *
 * The module is imported by its own test in Node, where there is no service-worker scope and
 * `addEventListener('fetch')` would do nothing useful. The check is a duck-typed one on the global
 * rather than an environment variable, so it is the same question the browser answers.
 */
const workerScope = (): WorkerScope | null => {
  const candidate = globalThis as unknown as Partial<WorkerScope> & { ServiceWorkerGlobalScope?: unknown };
  const isWorker =
    typeof candidate.ServiceWorkerGlobalScope === 'function' &&
    typeof candidate.skipWaiting === 'function' &&
    typeof candidate.addEventListener === 'function';
  return isWorker ? (candidate as WorkerScope) : null;
};

const scope = workerScope();
if (scope !== null) install(scope);
