/**
 * The WebDAV storage backend (CONCEPT §5.1, ADR-0004).
 *
 * Same layout as the local backend — `<root>/<aa>/<bb>/<sha256>` — because P10 says the store is
 * readable without the application, and a Nextcloud share that a person can open in a file manager
 * and navigate by digest keeps that promise across a network. Same semantics too: the digest comes
 * from the bytes, a `put` of bytes already held does not rewrite them, and "already held" is a fact
 * that is checked rather than read off the path.
 *
 * Three things are genuinely different from the local case, and each is a decision rather than an
 * accident:
 *
 * 1. **The bytes are spooled locally first** (`spool.ts`). The key cannot be known before the last
 *    byte has been hashed, and a `PUT` cannot be re-aimed after the fact. The cost is scratch space
 *    the size of the blob; the benefits are that an existing object can be checked before anything
 *    is uploaded, and that a retry resends the same bytes rather than the remains of a stream.
 *
 * 2. **A write is a `PUT` to a temporary name followed by a `MOVE`.** A `PUT` is not atomic: a
 *    connection cut halfway through leaves most servers holding a truncated file at the
 *    destination, which in a content-addressed store is a file whose name asserts a digest its
 *    bytes do not have — the one failure ADR-0004 exists to prevent. `MOVE` within one collection
 *    is a rename on the server's own filesystem on every server worth using. Where `MOVE` is
 *    genuinely unavailable, `writeStrategy: 'direct-put'` is offered, loudly, with the guarantee
 *    withdrawn in writing rather than silently.
 *
 * 3. **Reads verify as they stream.** Between the store and the reader sit a proxy, a TLS
 *    terminator and someone else's storage layer, and a truncated 200 looks exactly like a short
 *    file. See `verify.ts`.
 *
 * What this backend cannot do is make the server check anything. `Content-MD5` is sent, and is
 * ignored by nearly every WebDAV implementation in existence; `OC-Checksum` is sent, and is honoured
 * by Nextcloud and ownCloud and by nothing else. Neither can be relied on, so the write path ends
 * with a `HEAD` that compares the length the server now reports against the length that was sent —
 * cheap, and enough to catch the truncation that the checksum headers were supposed to catch.
 * `verifyOnWrite: 'digest'` reads the object back in full for those who want the whole answer.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';

import { assertSha256, newId, storageKeyFor } from '@recueil/core';
import type {
  BlobSource,
  BlobStat,
  PutOptions,
  PutResult,
  PutVerification,
  StorageBackend,
} from '@recueil/core';

import { StorageRequestError, StorageUnsupportedError } from '../errors.js';
import { defaultScratchDirectory, spool } from '../spool.js';
import type { SpooledBlob } from '../spool.js';
import { collect, digestOf, verifyingStream } from '../verify.js';
import type { WriteVerification } from '../verify.js';
import { WebDavClient, drain } from './client.js';
import type { WebDavClientOptions } from './client.js';

/** The collection temporary uploads land in before they are `MOVE`d into place. */
const TEMP_COLLECTION = '.tmp';

export interface WebDavBackendOptions
  extends Pick<WebDavClientOptions, 'auth' | 'headers' | 'retry' | 'onRetry' | 'fetch' | 'sleep'> {
  /** The collection the store lives in, as an absolute URL. */
  url: string;
  /**
   * Where the bytes are spooled while they are hashed. Needs room for the largest blob ingested,
   * and should be on the same volume the ingest pipeline already writes to.
   */
  scratchDirectory?: string;
  /** As `LocalFsBackendOptions.verifyOnPut`: how hard an existing object is checked. */
  verifyOnPut?: PutVerification;
  /**
   * How hard a freshly written object is checked before `put` returns.
   *
   * `size` — the default — is one `HEAD`. It catches the truncation that a dropped connection, a
   * full server disk or a proxy with a body limit produce, which is the realistic failure. `digest`
   * reads the object back and hashes it, doubling the network cost of every ingest and catching the
   * case where a server stored different bytes of the same length. `none` is for a server you
   * trust and a link you do not want to pay twice for; the store will then only learn about a bad
   * write on the next read, which does verify.
   */
  verifyOnWrite?: WriteVerification;
  /**
   * `temp-move` (default) writes to `.tmp` and `MOVE`s into place, so a failed upload cannot leave
   * a partial blob under a real digest. `direct-put` writes straight to the final path: use it only
   * on a server that cannot `MOVE`, and understand that an interrupted upload then leaves exactly
   * the corrupt-blob-with-an-honest-looking-name that this store is built to avoid. The next `put`
   * of the same bytes repairs it, and until then reads of it fail verification rather than
   * returning rubbish — but nothing repairs it on its own.
   */
  writeStrategy?: 'temp-move' | 'direct-put';
  /**
   * Send `Content-MD5` (RFC 1864) with each upload. Default true, and nearly always pointless: see
   * the failure modes in this package's README. Turn it off for a proxy that rejects the header.
   */
  sendContentMd5?: boolean;
  /**
   * Send `OC-Checksum: SHA256:<hex>`, the ownCloud/Nextcloud extension. Default true. On those
   * servers it is the only end-to-end check available, and it is the one that makes a truncated
   * upload fail at the server rather than at the next read.
   */
  sendOcChecksum?: boolean;
  /** `application/octet-stream` unless told otherwise. */
  contentType?: string;
}

export class WebDavBackend implements StorageBackend {
  readonly backend = 'webdav' as const;

  readonly client: WebDavClient;

  private readonly scratchDirectory: string;

  private readonly verifyOnPutDefault: PutVerification;

  private readonly verifyOnWrite: WriteVerification;

  private readonly writeStrategy: 'temp-move' | 'direct-put';

  private readonly sendContentMd5: boolean;

  private readonly sendOcChecksum: boolean;

  private readonly contentType: string;

  private readyPromise: Promise<void> | null = null;

  constructor(options: WebDavBackendOptions) {
    this.client = new WebDavClient(options);
    this.scratchDirectory = options.scratchDirectory ?? join(defaultScratchDirectory(), 'webdav');
    this.verifyOnPutDefault = options.verifyOnPut ?? 'size';
    this.verifyOnWrite = options.verifyOnWrite ?? 'size';
    this.writeStrategy = options.writeStrategy ?? 'temp-move';
    this.sendContentMd5 = options.sendContentMd5 ?? true;
    this.sendOcChecksum = options.sendOcChecksum ?? true;
    this.contentType = options.contentType ?? 'application/octet-stream';
  }

  /** The absolute URL of a blob. Pure — it touches nothing. */
  path(sha256: string): string {
    return this.client.url(segmentsFor(sha256));
  }

  /** The `documents.storage_key` for a digest. */
  key(sha256: string): string {
    return storageKeyFor(sha256);
  }

  /**
   * Check the server once, before the first write, and refuse it clearly if it cannot do the job.
   *
   * Called lazily so that constructing a backend never touches the network — a server that
   * constructs its dependency graph at boot should not fail to start because a Nextcloud instance
   * is having a slow morning.
   */
  async ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      await this.client.assertUsable({ requireMove: this.writeStrategy === 'temp-move' });
    })().catch((error: unknown) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  async put(source: BlobSource, options: PutOptions = {}): Promise<PutResult> {
    await this.ready();

    const spooled = await spool(source, this.scratchDirectory, {
      additionalHashes: this.sendContentMd5 ? ['md5'] : [],
    });

    try {
      const { sha256, size } = spooled;
      const key = storageKeyFor(sha256);
      const existing = await this.stat(sha256);

      if (existing !== null) {
        const verification = options.verify ?? this.verifyOnPutDefault;
        const sound =
          existing.size === size &&
          (verification === 'size' || (await this.digestAt(segmentsFor(sha256))) === sha256);

        if (sound) {
          return { sha256, size: existing.size, key, created: false, repaired: false };
        }

        // Whatever is on the server is not these bytes. The bytes in hand were hashed on the way
        // in, so they are the ones that survive (ADR-0004).
        await this.upload(spooled);
        return { sha256, size, key, created: true, repaired: true };
      }

      await this.upload(spooled);
      return { sha256, size, key, created: true, repaired: false };
    } finally {
      await spooled.dispose();
    }
  }

  async get(sha256: string): Promise<Readable> {
    const digest = assertSha256(sha256);
    const response = await this.client.request('GET', segmentsFor(digest), {
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });

    if (response.status === 404) {
      await drain(response);
      throw new Error(`Blob not in the store: ${digest}`);
    }
    if (response.body === null) {
      throw new Error(`Blob not in the store: ${digest} (the server returned no body).`);
    }

    const advertised = response.headers.get('content-length');
    const expectedSize = advertised === null ? undefined : Number(advertised);
    const stream = NodeReadable.fromWeb(response.body as Parameters<typeof NodeReadable.fromWeb>[0]);
    return verifyingStream(
      stream,
      digest,
      'webdav',
      expectedSize === undefined || Number.isNaN(expectedSize) ? undefined : expectedSize,
    );
  }

  async getBuffer(sha256: string): Promise<Buffer> {
    return collect(await this.get(sha256));
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256)) !== null;
  }

  async stat(sha256: string): Promise<BlobStat | null> {
    const digest = assertSha256(sha256);
    const response = await this.client.request('HEAD', segmentsFor(digest), {
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });
    await drain(response);
    if (response.status === 404) return null;

    const advertised = response.headers.get('content-length');
    if (advertised === null) {
      // A server that answers HEAD without a length cannot support the cheap `size` verification.
      // Say so rather than guessing a size and comparing against it.
      throw new StorageUnsupportedError(
        'webdav',
        'Content-Length on HEAD',
        `${this.path(digest)} exists but the server did not send Content-Length with its HEAD ` +
          'response, so its size cannot be checked without downloading it. Recueil needs the ' +
          "length; set verifyOnPut and verifyOnWrite to 'digest' if this server will never send one.",
      );
    }

    return { sha256: digest, size: Number(advertised), key: storageKeyFor(digest) };
  }

  async delete(sha256: string): Promise<boolean> {
    const digest = assertSha256(sha256);
    const response = await this.client.request('DELETE', segmentsFor(digest), {
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });
    await drain(response);
    // The shard collections are deliberately left in place. `DELETE` on a WebDAV collection is
    // recursive, and there is no cheap, race-free way to establish that a shard is empty first;
    // deleting one that a concurrent `put` had just written into would destroy a blob. 65 536 empty
    // collections cost an inode each, which is a price worth paying for that.
    return response.status !== 404;
  }

  /** Re-read a blob and confirm it still hashes to its name (the storage half of D2). */
  async verify(sha256: string): Promise<boolean> {
    if (!(await this.has(sha256))) return false;
    try {
      // `get` verifies as it streams, so draining it is the check.
      const stream = await this.get(sha256);
      for await (const _chunk of stream) {
        // discard
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Delete the partial uploads left in `.tmp` by a `put` that died mid-flight. */
  async listStrayTempFiles(): Promise<string[]> {
    const response = await this.client.request('PROPFIND', [TEMP_COLLECTION], {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      expect: (status) => status === 207 || status === 404,
    });
    if (response.status === 404 || response.body === null) {
      await drain(response);
      return [];
    }
    const xml = Buffer.from(await new Response(response.body).arrayBuffer()).toString('utf8');
    const hrefs = [...xml.matchAll(/<(?:[a-zA-Z0-9]+:)?href>([^<]*)<\/(?:[a-zA-Z0-9]+:)?href>/gu)]
      .map((match) => decodeURIComponent(match[1] ?? ''))
      .filter((href) => href.endsWith('.part'));
    return hrefs;
  }

  /** Upload the spooled bytes, atomically where the server allows it. */
  private async upload(spooled: SpooledBlob): Promise<void> {
    const finalSegments = segmentsFor(spooled.sha256);
    const headers: Record<string, string> = { 'content-type': this.contentType };
    if (this.sendContentMd5 && spooled.additional['md5'] !== undefined) {
      headers['content-md5'] = spooled.additional['md5'];
    }
    if (this.sendOcChecksum) headers['oc-checksum'] = `SHA256:${spooled.sha256}`;

    if (this.writeStrategy === 'direct-put') {
      await this.client.ensureCollection(finalSegments.slice(0, -1));
      const response = await this.client.request('PUT', finalSegments, {
        headers,
        body: () => ({ stream: spooled.open(), length: spooled.size }),
      });
      await drain(response);
      await this.confirmWrite(finalSegments, spooled);
      return;
    }

    const temporary = [TEMP_COLLECTION, `${newId()}.part`];
    await this.client.ensureCollection([TEMP_COLLECTION]);
    await this.client.ensureCollection(finalSegments.slice(0, -1));

    const put = await this.client.request('PUT', temporary, {
      headers,
      body: () => ({ stream: spooled.open(), length: spooled.size }),
    });
    await drain(put);

    try {
      // Check the upload **before** it is moved into place, not after. A truncated body that has
      // already been renamed to `<aa>/<bb>/<sha256>` is a corrupt blob under an honest-looking
      // name, which is the state this store must never reach — reporting it afterwards is not the
      // same as not creating it.
      await this.confirmWrite(temporary, spooled);

      const move = await this.client.request('MOVE', temporary, {
        headers: { destination: this.client.url(finalSegments), overwrite: 'T' },
        expect: (status) => (status >= 200 && status < 300) || status === 405 || status === 501,
      });
      await drain(move);

      if (move.status === 405 || move.status === 501) {
        throw new StorageUnsupportedError(
          'webdav',
          'MOVE',
          `${this.client.baseUrl} answered MOVE with HTTP ${move.status}. Recueil writes a blob ` +
            'under a temporary name and MOVEs it into place so an interrupted upload cannot leave ' +
            'a partial file under a name that asserts a digest. Either enable MOVE on the server ' +
            "or set writeStrategy: 'direct-put' and accept non-atomic writes.",
        );
      }
    } catch (error) {
      // The temporary file is ours and nothing else will collect it; leaving it is a slow leak on
      // somebody else's disk. A failure to clean up must not mask the failure that caused it.
      await this.client
        .request('DELETE', temporary, { expect: (status) => status < 500 })
        .then(drain)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Check that the object the server now holds is the one that was sent.
   *
   * This exists because neither checksum header can be relied upon. A server that quietly truncated
   * the body — a proxy body limit, a full disk, a dropped connection the server treated as
   * end-of-request — returns 201 Created and looks perfect until somebody reads the blob.
   */
  private async confirmWrite(segments: readonly string[], spooled: SpooledBlob): Promise<void> {
    if (this.verifyOnWrite === 'none') return;

    const stored = await this.statAt(segments);
    if (stored === null) {
      throw new StorageRequestError('webdav', {
        method: 'HEAD',
        url: this.client.url(segments),
        status: 404,
        body:
          'The upload was accepted but the object is not there. On an eventually consistent ' +
          'gateway this can be a replication lag; on anything else it is a lost write.',
      });
    }
    if (stored !== spooled.size) {
      throw new StorageRequestError('webdav', {
        method: 'HEAD',
        url: this.client.url(segments),
        status: 200,
        body: `The server stored ${stored} bytes of the ${spooled.size} that were sent.`,
      });
    }
    if (this.verifyOnWrite === 'digest') {
      const actual = await this.digestAt(segments);
      if (actual !== spooled.sha256) {
        throw new StorageRequestError('webdav', {
          method: 'GET',
          url: this.client.url(segments),
          status: 200,
          body: `The object read back hashes to ${String(actual)}, not ${spooled.sha256}.`,
        });
      }
    }
  }

  /** The length the server reports for a path, or null when there is nothing there. */
  private async statAt(segments: readonly string[]): Promise<number | null> {
    const response = await this.client.request('HEAD', segments, {
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });
    await drain(response);
    if (response.status === 404) return null;
    const advertised = response.headers.get('content-length');
    if (advertised === null) {
      throw new StorageUnsupportedError(
        'webdav',
        'Content-Length on HEAD',
        `${this.client.url(segments)} exists but the server did not send Content-Length with its ` +
          'HEAD response, so its size cannot be checked without downloading it. Set verifyOnPut ' +
          "and verifyOnWrite to 'digest' if this server will never send one.",
      );
    }
    return Number(advertised);
  }

  /** Hash whatever the server currently has at a path. */
  private async digestAt(segments: readonly string[]): Promise<string | null> {
    const response = await this.client.request('GET', segments, {
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });
    if (response.status === 404 || response.body === null) {
      await drain(response);
      return null;
    }
    const stream = NodeReadable.fromWeb(response.body as Parameters<typeof NodeReadable.fromWeb>[0]);
    return (await digestOf(stream)).sha256;
  }
}

/** `<aa>/<bb>/<sha256>` as path segments, with the digest checked before it is joined to anything. */
const segmentsFor = (sha256: string): string[] => storageKeyFor(sha256).split('/');

/** The `Content-MD5` this backend would send for these bytes. Exported so a test can assert it. */
export const contentMd5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('base64');
