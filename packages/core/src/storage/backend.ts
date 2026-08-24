/**
 * The storage backend contract (ADR-0004).
 *
 * A blob is addressed by the SHA-256 of its bytes and by nothing else. There is no "filename" in
 * this interface and no "update": bytes are immutable (invariant D3), which is what makes
 * annotations records rather than embedded PDF objects (ADR-0009) and what makes the store readable
 * without the application (P10).
 *
 * CONCEPT §5.1 lists three backends — local filesystem, WebDAV, S3. Only the local one exists in
 * Phase 1; the other two are this interface with a different `put`.
 */
import type { Readable } from 'node:stream';

/** What a backend can be given. A stream, because a 400 MB scan should not be buffered. */
export type BlobSource = Buffer | Uint8Array | Readable;

/** How much of an object already in the store is checked before a `put` declares a hit. */
export type PutVerification = 'size' | 'digest';

/** Per-call options for `put`. */
export interface PutOptions {
  /**
   * Override the backend's default verification for this call.
   *
   * `size` compares the length of the object already stored with the length of the bytes just
   * hashed; `digest` re-reads it and compares the digest. `digest` is the honest answer and costs
   * one extra read of a blob that is usually large, which is why it is not the default.
   */
  verify?: PutVerification;
}

/** The outcome of a `put`. */
export interface PutResult {
  /** 64 lowercase hex characters — the identity of the bytes, and of the Document (ADR-0004). */
  sha256: string;
  /** Bytes written, or bytes that were already there. */
  size: number;
  /** Backend-relative key. For `local`: `<aa>/<bb>/<sha256>`. */
  key: string;
  /**
   * False when these bytes were already in the store, which is the common case for a re-download,
   * a re-scan or a mailed copy of something already filed. The caller uses it to distinguish "new
   * blob" from "known blob" without a second round trip (CONCEPT §5.3 stage 2).
   */
  created: boolean;
  /**
   * True when an object was already at this digest, failed verification, and was replaced by the
   * bytes of this `put`.
   *
   * A caller that sees this has learned that the store had rotted, and should say so: the blob is
   * correct again only because these particular bytes happened to arrive a second time.
   */
  repaired: boolean;
}

export interface BlobStat {
  sha256: string;
  size: number;
  key: string;
}

export interface StorageBackend {
  /** Which `documents.storage_backend` value this is. */
  readonly backend: 'local' | 'webdav' | 's3';

  /**
   * Store bytes and return their digest.
   *
   * The digest is computed while streaming, never from a caller's claim. A `put` of bytes already
   * present does not rewrite the blob — it reports `created: false` and leaves the existing file
   * untouched, because rewriting is one way a content-addressed store can corrupt itself.
   *
   * "Already present" is a fact that must be **verified, never inferred from the filename**. A file
   * sitting at the digest path proves only that something was written there once; media rot, a
   * truncated write on a full disk or a botched restore all leave a file whose name asserts a
   * digest its bytes do not have. A backend therefore checks the stored object before declaring a
   * hit, and when the check fails it writes the bytes it was just handed — which are known-good,
   * having been hashed on the way in — rather than discarding them in favour of the corrupt copy.
   * That case returns `repaired: true`.
   */
  put(source: BlobSource, options?: PutOptions): Promise<PutResult>;

  /** Open the bytes for reading. Throws if the digest is not in the store. */
  get(sha256: string): Promise<Readable>;

  /** Read the whole blob. Convenience for small files; prefer `get` for anything page-sized. */
  getBuffer(sha256: string): Promise<Buffer>;

  has(sha256: string): Promise<boolean>;

  /** Size and key without reading the bytes. Null when absent. */
  stat(sha256: string): Promise<BlobStat | null>;

  /**
   * Remove a blob. Returns false when it was not there.
   *
   * P5 means this is never reached by an ordinary delete: trashing an item does not touch a
   * document, and a document is trashable only when it has no live attachment (D4). This exists for
   * the explicit purge of §6.6, TR2 and for a failed ingest's cleanup.
   */
  delete(sha256: string): Promise<boolean>;

  /**
   * Where the bytes are, in whatever form the backend addresses them: an absolute path for the
   * local filesystem, a key for S3. Pure; it does not check that anything is there.
   */
  path(sha256: string): string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Reject anything that is not a digest before it reaches a path join. */
export const assertSha256 = (value: string): string => {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`Not a SHA-256 digest: '${value}'. Expected 64 lowercase hex characters.`);
  }
  return value;
};

/** The fan-out key of ADR-0004: `<aa>/<bb>/<sha256>`. */
export const storageKeyFor = (sha256: string): string => {
  assertSha256(sha256);
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
};
