/**
 * The handover between the service worker and the share page.
 *
 * A Web Share Target that accepts files is a `POST` from the operating system into the origin, and
 * the only thing that can answer it is the service worker — there is no page yet. The worker cannot
 * hand a `File` to a page directly either, so the two halves meet in the Cache API: the worker
 * stashes each shared file as a `Response` under a one-time key and redirects to the page with the
 * key in the query string; the page reads them back, uploads them, and deletes the key.
 *
 * The constants and the encoding live here because both halves must agree on them exactly, and
 * because putting them in one module means a test can assert the round trip without a browser that
 * supports service workers.
 *
 * Two properties matter and are enforced below.
 *
 * **The key is not a filename.** It is a random identifier, and the cache key is built from it by
 * `shareKey`, which refuses anything that is not that shape. A shared file's name arrives from
 * another application and is hostile until proven otherwise; it never becomes a path, a cache key
 * or anything else with structure.
 *
 * **The stash is one-shot.** The page deletes the entry as soon as it has the bytes, and the worker
 * sweeps anything older than `SHARE_TTL_MS` on activation, so a share that was never completed does
 * not sit in the cache indefinitely holding a document.
 */

/** The URL the manifest's `share_target.action` names, and the route the page is served at. */
export const SHARE_PATH = '/share';

/** Where stashed files live. Versioned, so a format change does not have to migrate anything. */
export const SHARE_CACHE = 'recueil-share-v1';

/** The query parameter carrying the stash key back to the page. */
export const SHARE_KEY_PARAM = 'share';

/** How long an uncollected share is kept. Long enough for a slow page load, short enough to forget. */
export const SHARE_TTL_MS = 30 * 60 * 1000;

/** Headers the worker writes onto each stashed response, and the page reads back. */
export const SHARE_FILENAME_HEADER = 'x-recueil-share-filename';
export const SHARE_STASHED_AT_HEADER = 'x-recueil-share-stashed-at';
export const SHARE_TEXT_HEADER = 'x-recueil-share-text';

const KEY_PATTERN = /^[0-9a-f]{16,64}$/u;

/** A fresh stash identifier: 128 bits of randomness, hex. */
export const newShareId = (source: Pick<Crypto, 'getRandomValues'>): string => {
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * The cache key for one file of one share.
 *
 * Built, never received: the identifier is checked against `KEY_PATTERN` and the index against
 * being a small non-negative integer, so a key that arrived in a query string cannot address
 * anything outside the share namespace however it is spelled.
 */
export const shareKey = (id: string, index: number): string => {
  if (!KEY_PATTERN.test(id)) throw new Error('a share key is 16 to 64 hexadecimal characters');
  if (!Number.isInteger(index) || index < 0 || index > 999) {
    throw new Error('a share file index is a small non-negative integer');
  }
  return `/__recueil-share__/${id}/${String(index)}`;
};

/** Whether a cache key belongs to this share. Used by the sweep, which must not delete anything else. */
export const parseShareKey = (url: string): { id: string; index: number } | null => {
  const match = /\/__recueil-share__\/([0-9a-f]{16,64})\/(\d{1,3})$/u.exec(url);
  if (match === null) return null;
  return { id: match[1] as string, index: Number(match[2]) };
};

/**
 * A filename fit to send in a multipart part.
 *
 * The name a share sheet supplies is another application's string. It is used for one thing — the
 * `filename` of the upload part, which the server treats as informational and never as a path (P2,
 * `routes/documents.ts`) — and it is stripped to a single segment without control characters first,
 * because a `../` in a multipart filename has been a vulnerability in enough servers to be worth
 * not sending.
 */
export const safeShareFilename = (raw: string | null | undefined, fallback: string): string => {
  if (raw === null || raw === undefined) return fallback;
  const lastSegment = raw.split(/[\\/]/u).pop() ?? '';
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned.slice(0, 200);
};

/** One file, as the page gets it back out of the stash. */
export interface StashedShare {
  filename: string;
  mediaType: string;
  blob: Blob;
  stashedAt: string;
  /** The `text` or `url` field of the share, when the sender supplied one. */
  note: string | null;
}
