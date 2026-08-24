/**
 * The S3 storage backend (CONCEPT §5.1, ADR-0004).
 *
 * Layout is the same `<aa>/<bb>/<sha256>` the local and WebDAV backends use, under an optional key
 * prefix. Object stores do not have directories, so the fan-out buys nothing operationally here —
 * it is kept because P10 is a promise about the *store*, not about one backend: an operator who
 * syncs the bucket down with `rclone` gets the same tree they would have had locally, and a blob
 * copied from one backend to another keeps its key.
 *
 * The interesting differences from the local case:
 *
 * - **Uploads are checksummed by the server.** `x-amz-checksum-sha256` carries the digest that was
 *   computed while spooling, and S3 (and MinIO, and Garage) recompute it and reject the upload
 *   with `BadDigest` if it does not match. This is the one backend where the store's own identity
 *   function is verified end-to-end by somebody else's server, and it is worth using.
 * - **Above `multipartThreshold` an upload is multipart**, which is not one operation but three:
 *   create, N × upload-part, complete. A failure between the first and the last leaves parts on the
 *   server that no `ListObjects` will show and that are billed until something removes them. This
 *   backend aborts on every failure path and raises `StorageAbandonedUploadError` — loudly, with
 *   the upload id — when even the abort fails. Set a lifecycle rule as well; see the README.
 * - **A read can be served by a replica that has not caught up.** S3 itself has been strongly
 *   read-after-write consistent since 2020, but MinIO in distributed mode, Garage mid-rebalance and
 *   every caching gateway in front of either are not. That is why `put` ends by confirming the
 *   write and why `get` verifies as it streams: a stale or partial read fails as an integrity
 *   error rather than arriving as plausible-looking bytes.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { CompletedPart, S3ClientConfig, StorageClass } from '@aws-sdk/client-s3';
import { assertSha256, storageKeyFor } from '@recueil/core';
import type {
  BlobSource,
  BlobStat,
  PutOptions,
  PutResult,
  PutVerification,
  StorageBackend,
} from '@recueil/core';

import { StorageAbandonedUploadError, StorageBackendError, StorageRequestError } from '../errors.js';
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy, withRetry } from '../retry.js';
import type { RetryAttempt, RetryPolicy } from '../retry.js';
import { defaultScratchDirectory, spool } from '../spool.js';
import type { SpooledBlob } from '../spool.js';
import { collect, digestOf, verifyingStream } from '../verify.js';
import type { WriteVerification } from '../verify.js';

/** S3 refuses a part below 5 MiB unless it is the last one. */
const MINIMUM_PART_SIZE = 5 * 1024 * 1024;

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

const DEFAULT_MULTIPART_THRESHOLD = 16 * 1024 * 1024;

/** 10 000 parts is the hard S3 limit; the part size is grown to stay inside it. */
const MAXIMUM_PARTS = 10_000;

export interface S3BackendOptions {
  bucket: string;
  /** Default `us-east-1`. Irrelevant to MinIO and Garage, but the SDK insists on one. */
  region?: string;
  /**
   * A non-AWS endpoint: `http://127.0.0.1:9000` for MinIO, `http://garage:3900` for Garage.
   *
   * Setting it turns on path-style addressing unless `forcePathStyle` says otherwise, because
   * neither of those speaks virtual-host style without DNS wildcards that a self-hoster is unlikely
   * to have set up.
   */
  endpoint?: string;
  /**
   * `true` puts the bucket in the path (`http://host/bucket/key`), `false` in the host
   * (`http://bucket.host/key`). Defaults to `true` when `endpoint` is set and `false` otherwise.
   */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Prepended to every key. `recueil/` puts the store in a folder of a shared bucket. */
  prefix?: string;
  /** Where blobs are spooled and hashed before upload. Needs room for the largest blob. */
  scratchDirectory?: string;
  /** As `LocalFsBackendOptions.verifyOnPut`. */
  verifyOnPut?: PutVerification;
  /**
   * How hard a freshly written object is checked. `size` — the default — is one `HeadObject`, and
   * on a store that honours `x-amz-checksum-sha256` it is belt on top of braces. `digest` reads the
   * object back. `none` trusts the 200.
   */
  verifyOnWrite?: WriteVerification;
  /** Above this many bytes an upload becomes multipart. Default 16 MiB. */
  multipartThreshold?: number;
  /** Part size for a multipart upload. Default 8 MiB; raised automatically past 10 000 parts. */
  partSize?: number;
  /**
   * Send `x-amz-checksum-sha256` so the server verifies the upload. Default true. Turn it off only
   * for a gateway that rejects the header — and know that the write is then unverified until the
   * `HeadObject` that follows it, which only checks the length.
   */
  serverSideChecksums?: boolean;
  /** `STANDARD`, `GLACIER_IR`, whatever the provider offers. Left unset by default. */
  storageClass?: StorageClass;
  retry?: Partial<RetryPolicy>;
  onRetry?: (attempt: RetryAttempt & { operation: string; key: string }) => void;
  /** Bring your own client — for a custom credential provider, a proxy agent, or a test double. */
  client?: S3Client;
  /** Anything else the SDK client takes. Merged under the options above. */
  clientConfig?: Partial<S3ClientConfig>;
  /** Swapped by the tests so a backoff run does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class S3Backend implements StorageBackend {
  readonly backend = 's3' as const;

  readonly bucket: string;

  readonly prefix: string;

  readonly client: S3Client;

  private readonly ownsClient: boolean;

  private readonly scratchDirectory: string;

  private readonly verifyOnPutDefault: PutVerification;

  private readonly verifyOnWrite: WriteVerification;

  private readonly multipartThreshold: number;

  private readonly configuredPartSize: number;

  private readonly serverSideChecksums: boolean;

  private readonly storageClass: StorageClass | undefined;

  private readonly policy: RetryPolicy;

  private readonly onRetry: S3BackendOptions['onRetry'];

  private readonly sleep: S3BackendOptions['sleep'];

  constructor(options: S3BackendOptions) {
    this.bucket = options.bucket;
    this.prefix = normalisePrefix(options.prefix);
    this.scratchDirectory = options.scratchDirectory ?? join(defaultScratchDirectory(), 's3');
    this.verifyOnPutDefault = options.verifyOnPut ?? 'size';
    this.verifyOnWrite = options.verifyOnWrite ?? 'size';
    this.multipartThreshold = options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
    this.configuredPartSize = Math.max(MINIMUM_PART_SIZE, options.partSize ?? DEFAULT_PART_SIZE);
    this.serverSideChecksums = options.serverSideChecksums ?? true;
    this.storageClass = options.storageClass;
    this.policy = resolveRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
    this.onRetry = options.onRetry;
    this.sleep = options.sleep;

    this.ownsClient = options.client === undefined;
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? 'us-east-1',
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        // The retry loop in this package is the one that is tested and the one whose backoff is
        // documented. Two nested retry loops multiply, and turn a five-attempt policy into
        // fifteen requests against a server that is already struggling.
        maxAttempts: 1,
        // Do not add a CRC32 to every request. Where a checksum is wanted this backend supplies a
        // SHA-256 explicitly, which is the digest the store is addressed by; a second, different
        // checksum verifies nothing extra and breaks gateways that only implement one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        // The SDK's own response validation compares the body against the checksum the *server*
        // stored. This backend compares it against the digest the object is *named by*, which is
        // strictly stronger — it catches a rotted object whose stored checksum rotted with it — and
        // hashing every byte twice to get the weaker answer is not worth the CPU.
        responseChecksumValidation: 'WHEN_REQUIRED',
        ...(options.clientConfig ?? {}),
      } as S3ClientConfig);
  }

  /** The object key, prefix included. This is what `documents.storage_key` maps onto for S3. */
  path(sha256: string): string {
    return `${this.prefix}${storageKeyFor(sha256)}`;
  }

  /**
   * The backend-relative key, without the prefix: the same string every backend produces for the
   * same digest, which is what makes a blob portable between them.
   */
  key(sha256: string): string {
    return storageKeyFor(sha256);
  }

  async put(source: BlobSource, options: PutOptions = {}): Promise<PutResult> {
    const spooled = await spool(source, this.scratchDirectory);

    try {
      const { sha256, size } = spooled;
      const key = storageKeyFor(sha256);
      const head = await this.head(sha256);

      if (head !== null) {
        const verification = options.verify ?? this.verifyOnPutDefault;
        const sound = head.size === size && (verification === 'size' || (await this.soundDigest(sha256, head)));

        if (sound) {
          return { sha256, size: head.size, key, created: false, repaired: false };
        }

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
    const response = await this.run('GetObject', digest, async () =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.path(digest) })),
    ).catch((error: unknown) => {
      if (isNotFound(error)) throw new Error(`Blob not in the store: ${digest}`);
      throw error;
    });

    const body = response.Body;
    if (body === undefined) throw new Error(`Blob not in the store: ${digest} (no body).`);

    const stream =
      body instanceof NodeReadable
        ? body
        : NodeReadable.fromWeb(
            (body as { transformToWebStream(): ReadableStream }).transformToWebStream() as Parameters<
              typeof NodeReadable.fromWeb
            >[0],
          );

    return verifyingStream(
      stream,
      digest,
      's3',
      response.ContentLength === undefined ? undefined : Number(response.ContentLength),
    );
  }

  async getBuffer(sha256: string): Promise<Buffer> {
    return collect(await this.get(sha256));
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.head(sha256)) !== null;
  }

  async stat(sha256: string): Promise<BlobStat | null> {
    const head = await this.head(sha256);
    if (head === null) return null;
    return { sha256: assertSha256(sha256), size: head.size, key: storageKeyFor(sha256) };
  }

  async delete(sha256: string): Promise<boolean> {
    const digest = assertSha256(sha256);
    // `DeleteObject` answers 204 whether or not the key was there, so the only way to give the
    // caller the `false` the contract promises is to look first. On a store that is not strongly
    // read-after-delete consistent this is a best-effort answer, and the delete itself is not.
    const existed = (await this.head(digest)) !== null;
    await this.run('DeleteObject', digest, async () =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.path(digest) })),
    );
    return existed;
  }

  /** Re-read a blob and confirm it still hashes to its name (the storage half of D2). */
  async verify(sha256: string): Promise<boolean> {
    if (!(await this.has(sha256))) return false;
    try {
      const stream = await this.get(sha256);
      for await (const _chunk of stream) {
        // discard; `get` verifies as it goes
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Close the SDK client's sockets, unless the client was supplied from outside. */
  destroy(): void {
    if (this.ownsClient) this.client.destroy();
  }

  private async head(
    sha256: string,
  ): Promise<{ size: number; checksumSha256: string | undefined } | null> {
    const digest = assertSha256(sha256);
    try {
      const response = await this.run('HeadObject', digest, async () =>
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.path(digest) })),
      );
      return {
        size: Number(response.ContentLength ?? 0),
        checksumSha256: response.ChecksumSHA256,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Is the object already there really these bytes?
   *
   * The object's own `x-amz-checksum-sha256` is used only to say **no** cheaply. It cannot be used
   * to say yes, and the temptation to do so is the same mistake as trusting a filename: that header
   * records what was computed at upload time, S3 does not recompute it when the object is read
   * without `ChecksumMode`, and an object whose bytes have rotted still carries the checksum it was
   * written with. A store that accepted it as proof would answer `created: false` over a corrupt
   * blob and discard the good bytes in hand — ADR-0004's one forbidden outcome, reached by a
   * different road.
   *
   * There is a second trap in the same header. An object assembled from parts carries a *composite*
   * checksum — the hash of the concatenated part hashes, with `-N` appended — which is not the
   * SHA-256 of the object at all, and comparing it to one would fail every multipart blob in the
   * store and "repair" it on every put.
   *
   * So: a non-composite checksum that disagrees is a definite mismatch and is worth the one call it
   * cost. Everything else is settled by reading the object back and hashing it, which is what
   * `verify: 'digest'` is understood to cost.
   */
  private async soundDigest(
    sha256: string,
    head: { checksumSha256: string | undefined },
  ): Promise<boolean> {
    const advertised = head.checksumSha256;
    if (advertised !== undefined && !/-\d+$/u.test(advertised) && advertised !== base64Digest(sha256)) {
      return false;
    }
    return (await this.remoteDigest(sha256)) === sha256;
  }

  private async remoteDigest(sha256: string): Promise<string | null> {
    try {
      const response = await this.run('GetObject', sha256, async () =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.path(sha256) })),
      );
      const body = response.Body;
      if (body === undefined) return null;
      const stream =
        body instanceof NodeReadable
          ? body
          : NodeReadable.fromWeb(
              (body as { transformToWebStream(): ReadableStream }).transformToWebStream() as Parameters<
                typeof NodeReadable.fromWeb
              >[0],
            );
      return (await digestOf(stream)).sha256;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async upload(spooled: SpooledBlob): Promise<void> {
    if (spooled.size < this.multipartThreshold) await this.putObject(spooled);
    else await this.multipartUpload(spooled);
    await this.confirmWrite(spooled);
  }

  private async putObject(spooled: SpooledBlob): Promise<void> {
    // A whole part is buffered rather than streamed: below the multipart threshold the blob is
    // small by definition, a `Buffer` body lets the SDK send an ordinary `Content-Length` request
    // instead of `aws-chunked` trailers (which several S3-compatible gateways do not implement),
    // and it makes a retry a matter of resending the same bytes.
    const body = await collect(spooled.open());
    await this.run('PutObject', spooled.sha256, async () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.path(spooled.sha256),
          Body: body,
          ContentLength: spooled.size,
          ContentType: 'application/octet-stream',
          Metadata: { sha256: spooled.sha256 },
          ...(this.serverSideChecksums ? { ChecksumSHA256: base64Digest(spooled.sha256) } : {}),
          ...(this.storageClass === undefined ? {} : { StorageClass: this.storageClass }),
        }),
      ),
    );
  }

  private async multipartUpload(spooled: SpooledBlob): Promise<void> {
    const key = this.path(spooled.sha256);
    const partSize = this.partSizeFor(spooled.size);

    const created = await this.run('CreateMultipartUpload', spooled.sha256, async () =>
      this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: 'application/octet-stream',
          Metadata: { sha256: spooled.sha256 },
          ...(this.serverSideChecksums ? { ChecksumAlgorithm: 'SHA256' as const } : {}),
          ...(this.storageClass === undefined ? {} : { StorageClass: this.storageClass }),
        }),
      ),
    );

    const uploadId = created.UploadId;
    if (uploadId === undefined) {
      throw new StorageBackendError('s3', `CreateMultipartUpload for '${key}' returned no UploadId.`);
    }

    try {
      const parts: CompletedPart[] = [];
      for (let offset = 0, partNumber = 1; offset < spooled.size; offset += partSize, partNumber += 1) {
        const end = Math.min(offset + partSize, spooled.size) - 1;
        const body = await collect(spooled.open({ start: offset, end }));
        const uploaded = await this.run(`UploadPart#${partNumber}`, spooled.sha256, async () =>
          this.client.send(
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: body,
              ContentLength: body.byteLength,
              ...(this.serverSideChecksums
                ? { ChecksumSHA256: bufferDigestBase64(body), ChecksumAlgorithm: 'SHA256' as const }
                : {}),
            }),
          ),
        );
        parts.push({
          PartNumber: partNumber,
          ETag: uploaded.ETag,
          ...(uploaded.ChecksumSHA256 === undefined ? {} : { ChecksumSHA256: uploaded.ChecksumSHA256 }),
        });
      }

      await this.run('CompleteMultipartUpload', spooled.sha256, async () =>
        this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        ),
      );
    } catch (error) {
      // Every failure path aborts. Parts left behind by an abandoned multipart upload are invisible
      // to `ListObjects` and billed until something removes them, which is how a bucket quietly
      // grows a cost nobody can account for.
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
        );
      } catch (abortError) {
        throw new StorageAbandonedUploadError('s3', { key, uploadId, cause: abortError });
      }
      throw error;
    }
  }

  /** Grow the part size until the blob fits inside the 10 000-part limit. */
  private partSizeFor(size: number): number {
    return partSizeFor(size, this.configuredPartSize);
  }

  private async confirmWrite(spooled: SpooledBlob): Promise<void> {
    if (this.verifyOnWrite === 'none') return;

    const head = await this.head(spooled.sha256);
    if (head === null) {
      throw new StorageRequestError('s3', {
        method: 'HeadObject',
        url: `s3://${this.bucket}/${this.path(spooled.sha256)}`,
        status: 404,
        body:
          'The upload was accepted but the object is not there. On a store that is not strongly ' +
          'read-after-write consistent this can be replication lag; on S3 itself it is a lost write.',
      });
    }
    if (head.size !== spooled.size) {
      throw new StorageRequestError('s3', {
        method: 'HeadObject',
        url: `s3://${this.bucket}/${this.path(spooled.sha256)}`,
        status: 200,
        body: `The store holds ${head.size} bytes of the ${spooled.size} that were sent.`,
      });
    }
    if (this.verifyOnWrite === 'digest' && !(await this.soundDigest(spooled.sha256, head))) {
      throw new StorageRequestError('s3', {
        method: 'GetObject',
        url: `s3://${this.bucket}/${this.path(spooled.sha256)}`,
        status: 200,
        body: `The object read back does not hash to ${spooled.sha256}.`,
      });
    }
  }

  /** One SDK call, retried on the failures a retry can fix. */
  private async run<T>(operation: string, key: string, call: () => Promise<T>): Promise<T> {
    return withRetry(call, {
      policy: this.policy,
      isRetryable: isRetryableS3Error,
      retryAfterMs: (error) => {
        const header = headerOf(error, 'retry-after');
        if (header === undefined) return undefined;
        const seconds = Number(header);
        return Number.isFinite(seconds) ? seconds * 1000 : undefined;
      },
      onRetry: (attempt) => this.onRetry?.({ ...attempt, operation, key }),
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
  }
}

/**
 * The part size to use for a blob of `size`, given a configured preference.
 *
 * S3 allows at most 10 000 parts, so a fixed 8 MiB part size caps an object at 80 GB and fails —
 * late, after 10 000 successful uploads — on anything larger. Doubling until it fits is the cheap
 * fix. Exported because it is pure, and because a limit that is only exercised by an 80 GB test is
 * a limit that is never exercised.
 */
export const partSizeFor = (size: number, configuredPartSize: number): number => {
  let partSize = Math.max(MINIMUM_PART_SIZE, configuredPartSize);
  while (Math.ceil(size / partSize) > MAXIMUM_PARTS) partSize *= 2;
  return partSize;
};

const normalisePrefix = (prefix: string | undefined): string => {
  if (prefix === undefined || prefix === '') return '';
  const trimmed = prefix.replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (trimmed === '' ) return '';
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Refusing an S3 key prefix with a relative segment: '${prefix}'.`);
  }
  return `${trimmed}/`;
};

/** The base64 form S3 wants a SHA-256 in. */
export const base64Digest = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

const bufferDigestBase64 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('base64');

const statusOf = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;

const headerOf = (error: unknown, name: string): string | undefined => {
  const headers = (error as { $response?: { headers?: Record<string, string> } } | undefined)?.$response
    ?.headers;
  return headers?.[name];
};

/** `NoSuchKey` for a GET, `NotFound` for a HEAD, and a bare 404 from a gateway that says neither. */
export const isNotFound = (error: unknown): boolean => {
  const name = (error as { name?: string } | undefined)?.name;
  return name === 'NoSuchKey' || name === 'NotFound' || statusOf(error) === 404;
};

const RETRYABLE_S3_NAMES = new Set([
  'InternalError',
  'RequestTimeout',
  'RequestTimeTooSkewed',
  'ServiceUnavailable',
  'SlowDown',
  'ThrottlingException',
  'TooManyRequestsException',
]);

export const isRetryableS3Error = (error: unknown): boolean => {
  if (error instanceof StorageAbandonedUploadError) return false;
  const name = (error as { name?: string } | undefined)?.name;
  if (name !== undefined && RETRYABLE_S3_NAMES.has(name)) return true;

  const status = statusOf(error);
  if (status !== undefined) return status === 429 || (status >= 500 && status < 600);

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET'
  );
};
