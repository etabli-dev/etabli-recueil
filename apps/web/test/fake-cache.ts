/**
 * A Cache API good enough to drive the service worker.
 *
 * jsdom has no `caches`, and the alternative to this is running the worker in a real browser — which
 * the end-to-end suite does for the parts that need it. What is under test here is the worker's
 * logic: which requests it answers, what it stashes and what it sweeps. That needs a store with the
 * three methods the worker calls and honest semantics for them, not a browser.
 *
 * It is deliberately strict in one place: `match` compares full URLs, so a worker that built a key
 * carelessly fails here rather than accidentally matching.
 */

/**
 * A cache key.
 *
 * Anything with a `url` counts, not only a real `Request`: one of the worker's inputs is a
 * navigation, and `new Request(url, { mode: 'navigate' })` is not constructible outside a browser,
 * so that case is driven with a request-shaped object.
 */
const keyOf = (request: RequestInfo | URL): string => {
  if (typeof request === 'string') return new URL(request, 'https://recueil.test').toString();
  if (request instanceof URL) return request.toString();
  return new URL((request as { url: string }).url).toString();
};

export class FakeCache {
  readonly entries = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response);
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(keyOf(request));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(keyOf(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async add(request: RequestInfo | URL): Promise<void> {
    this.entries.set(keyOf(request), new Response('cached'));
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    const existing = this.caches.get(name);
    if (existing !== undefined) return existing;
    const created = new FakeCache();
    this.caches.set(name, created);
    return created;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }
}

/** The fakes as the worker's own parameter types see them. */
export const asCacheStorage = (storage: FakeCacheStorage): CacheStorage => storage as unknown as CacheStorage;
export const asCache = (cache: FakeCache): Cache => cache as unknown as Cache;
