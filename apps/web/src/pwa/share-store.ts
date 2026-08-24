/**
 * The page's side of the share handover: reading the stash and emptying it.
 *
 * Separated from the component because these two functions are the part worth asserting on — that
 * a stash is read back with the filename and media type the worker put on it, and that collecting
 * it removes it. A share that stayed in the cache after being uploaded would be re-uploaded on
 * every reload of the page.
 */
import {
  SHARE_CACHE,
  SHARE_FILENAME_HEADER,
  SHARE_STASHED_AT_HEADER,
  SHARE_TEXT_HEADER,
  shareKey,
} from './share-protocol.js';
import type { StashedShare } from './share-protocol.js';

/** How many files one share may carry. A share sheet that sent more is refused rather than truncated silently. */
const MAX_SHARE_FILES = 20;

/**
 * Everything stashed under one key, in the order the worker wrote it.
 *
 * Indices are probed in order and the first gap ends the share, which is what makes this a total
 * read of a set the worker wrote contiguously rather than a scan of the whole cache.
 */
export const readShare = async (caches: CacheStorage, id: string): Promise<StashedShare[]> => {
  const cache = await caches.open(SHARE_CACHE);
  const shares: StashedShare[] = [];

  for (let index = 0; index < MAX_SHARE_FILES; index += 1) {
    const stored = await cache.match(shareKey(id, index));
    if (stored === undefined) break;
    shares.push({
      filename: decodeHeader(stored.headers.get(SHARE_FILENAME_HEADER)) ?? `shared-${String(index)}`,
      mediaType: stored.headers.get('content-type') ?? 'application/octet-stream',
      blob: await stored.blob(),
      stashedAt: stored.headers.get(SHARE_STASHED_AT_HEADER) ?? new Date().toISOString(),
      note: decodeHeader(stored.headers.get(SHARE_TEXT_HEADER)),
    });
  }
  return shares;
};

/** Empty the stash. Returns how many entries went, so the page can say the handover is finished. */
export const clearShare = async (caches: CacheStorage, id: string): Promise<number> => {
  const cache = await caches.open(SHARE_CACHE);
  let removed = 0;
  for (let index = 0; index < MAX_SHARE_FILES; index += 1) {
    if (await cache.delete(shareKey(id, index))) removed += 1;
    else break;
  }
  return removed;
};

/** Headers are ASCII, so the worker percent-encoded anything that is not. */
const decodeHeader = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};
