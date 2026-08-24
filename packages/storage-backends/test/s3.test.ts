/**
 * What the S3 backend does that the conformance suite does not cover: the two addressing styles,
 * the multipart path and everything that can go wrong on it, the server-side checksum, and the two
 * failure modes a local disk does not have — an abandoned multipart upload and a read that misses
 * immediately after a write.
 *
 * Everything runs against the in-process fake in `src/testing/s3-server.ts`. It is not MinIO and it
 * is not S3; passing here is not a compatibility claim about either. See the README.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { storageKeyFor } from '@recueil/core';
import { afterEach, describe, expect, it } from 'vitest';

import { StorageAbandonedUploadError, StorageRequestError } from '../src/errors.js';
import { S3Backend, base64Digest, partSizeFor } from '../src/s3/backend.js';
import type { S3BackendOptions } from '../src/s3/backend.js';
import { startFakeS3Server } from '../src/testing/s3-server.js';
import type { FakeS3Options, FakeS3Server } from '../src/testing/s3-server.js';

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Deterministic incompressible-ish bytes, so a truncation cannot hide behind a repeat. */
const bytesOfLength = (length: number, seed: string): Buffer => {
  const out = Buffer.alloc(length);
  let block = createHash('sha256').update(seed).digest();
  for (let offset = 0; offset < length; offset += block.byteLength) {
    block.copy(out, offset, 0, Math.min(block.byteLength, length - offset));
    block = createHash('sha256').update(block).digest();
  }
  return out;
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

interface Fixture {
  server: FakeS3Server;
  backend: S3Backend;
  slept: number[];
}

const fixture = async (
  serverOptions: Partial<FakeS3Options> = {},
  backendOptions: Partial<S3BackendOptions> = {},
): Promise<Fixture> => {
  const server = await startFakeS3Server({ buckets: ['library'], ...serverOptions });
  const scratch = await mkdtemp(join(tmpdir(), 'recueil-s3-scratch-'));
  const slept: number[] = [];
  const backend = new S3Backend({
    bucket: 'library',
    endpoint: server.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
    scratchDirectory: scratch,
    multipartThreshold: 6 * 1024 * 1024,
    partSize: 5 * 1024 * 1024,
    retry: { attempts: 4, baseDelayMs: 10, maxDelayMs: 1000, jitter: false },
    sleep: async (ms) => {
      slept.push(ms);
    },
    clientConfig: { requestHandler: { httpAgent: server.agent } },
    ...backendOptions,
  });
  cleanup.push(async () => {
    backend.destroy();
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return { server, backend, slept };
};

describe('S3Backend addressing', () => {
  it('puts the bucket in the path when path-style addressing is asked for', async () => {
    const { server, backend } = await fixture();

    await backend.put(Buffer.from('path style', 'utf8'));

    const put = server.requests.find((request) => request.operation === 'PutObject');
    expect(put?.url.split('?')[0]).toBe(`/library/${storageKeyFor(digestOf(Buffer.from('path style', 'utf8')))}`);
    expect(put?.host.startsWith('library.')).toBe(false);
  });

  it('puts the bucket in the host when virtual-host addressing is asked for', async () => {
    const server = await startFakeS3Server({ buckets: ['library'] });
    const scratch = await mkdtemp(join(tmpdir(), 'recueil-s3-scratch-'));
    const backend = new S3Backend({
      bucket: 'library',
      // A hostname that is never resolved: the fake's agent sends every socket to the loopback
      // address it bound, which is what makes this testable without wildcard DNS.
      endpoint: server.virtualHostEndpoint,
      forcePathStyle: false,
      credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
      scratchDirectory: scratch,
      clientConfig: { requestHandler: { httpAgent: server.agent } },
    });
    cleanup.push(async () => {
      backend.destroy();
      await server.close();
      await rm(scratch, { recursive: true, force: true });
    });
    const bytes = Buffer.from('virtual host style', 'utf8');

    const result = await backend.put(bytes);

    const put = server.requests.find((request) => request.operation === 'PutObject');
    expect(put?.host.startsWith('library.s3.recueil.invalid')).toBe(true);
    expect(put?.url.split('?')[0]).toBe(`/${storageKeyFor(result.sha256)}`);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });

  it('puts the store under a key prefix without changing the portable key', async () => {
    const { server, backend } = await fixture({}, { prefix: 'recueil/blobs' });
    const bytes = Buffer.from('prefixed', 'utf8');

    const result = await backend.put(bytes);

    expect(result.key).toBe(storageKeyFor(result.sha256));
    expect(backend.path(result.sha256)).toBe(`recueil/blobs/${storageKeyFor(result.sha256)}`);
    expect(server.objects.has(`library/recueil/blobs/${storageKeyFor(result.sha256)}`)).toBe(true);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });

  it('refuses a prefix that could climb out of itself', () => {
    expect(
      () => new S3Backend({ bucket: 'library', prefix: 'recueil/../../etc' }),
    ).toThrow(/relative segment/u);
  });
});

describe('S3Backend server-side checksums', () => {
  it('sends the digest as x-amz-checksum-sha256 so the server verifies the upload', async () => {
    const { server, backend } = await fixture();
    const bytes = Buffer.from('checked by the server', 'utf8');

    const result = await backend.put(bytes);

    const put = server.requests.find((request) => request.operation === 'PutObject');
    expect(put?.headers['x-amz-checksum-sha256']).toBe(base64Digest(result.sha256));
    expect(server.objects.get(`library/${storageKeyFor(result.sha256)}`)?.checksumSha256).toBe(
      base64Digest(result.sha256),
    );
  });

  it('sends a plain Content-Length body, not an aws-chunked one', async () => {
    // Several S3-compatible gateways do not implement `aws-chunked` trailers. The fake answers
    // 501 if it ever sees one, so this test fails loudly if the SDK's defaults drift.
    const { server, backend } = await fixture();

    await backend.put(Buffer.from('plain body', 'utf8'));

    const put = server.requests.find((request) => request.operation === 'PutObject');
    expect(put?.headers['content-encoding'] ?? '').not.toContain('aws-chunked');
    expect(put?.headers['content-length']).toBe('10');
  });

  it('can be told not to send a checksum, and then relies on the size check alone', async () => {
    const { server, backend } = await fixture({}, { serverSideChecksums: false });

    const result = await backend.put(Buffer.from('unchecked', 'utf8'));

    const put = server.requests.find((request) => request.operation === 'PutObject');
    expect(put?.headers['x-amz-checksum-sha256']).toBeUndefined();
    expect(server.objects.get(`library/${storageKeyFor(result.sha256)}`)?.checksumSha256).toBeUndefined();
  });

  it('never treats the stored checksum as proof that the bytes are still right', async () => {
    // The trap: `x-amz-checksum-sha256` records what was computed at upload time and is not
    // recomputed on an ordinary read. An object whose bytes have rotted still advertises the
    // checksum it was written with, so believing it would discard the good bytes in hand.
    const { server, backend } = await fixture();
    const bytes = Buffer.from('rot me in place', 'utf8');
    const rotted = Buffer.from('rot me in plaice'.slice(0, bytes.byteLength), 'utf8');
    expect(rotted.byteLength).toBe(bytes.byteLength);

    const first = await backend.put(bytes);
    server.corrupt('library', storageKeyFor(first.sha256), rotted);
    expect(server.objects.get(`library/${storageKeyFor(first.sha256)}`)?.checksumSha256).toBe(
      base64Digest(first.sha256),
    );

    const second = await backend.put(bytes, { verify: 'digest' });

    expect(second.repaired).toBe(true);
    expect(await backend.getBuffer(first.sha256)).toEqual(bytes);
  });

  it('falls back to reading the object back when the gateway drops the checksum header', async () => {
    const { server, backend } = await fixture({ dropChecksumHeaders: true });
    const bytes = Buffer.from('no checksum came back', 'utf8');
    const first = await backend.put(bytes);
    const before = server.requests.length;

    const second = await backend.put(bytes, { verify: 'digest' });

    expect(second.created).toBe(false);
    expect(second.repaired).toBe(false);
    expect(first.sha256).toBe(second.sha256);
    expect(
      server.requests.slice(before).filter((request) => request.operation === 'GetObject'),
    ).toHaveLength(1);
  });
});

describe('S3Backend multipart uploads', () => {
  it('uses a single PutObject below the threshold', async () => {
    const { server, backend } = await fixture();

    await backend.put(bytesOfLength(1024 * 1024, 'small'));

    expect(server.requests.map((request) => request.operation)).toContain('PutObject');
    expect(server.requests.map((request) => request.operation)).not.toContain(
      'CreateMultipartUpload',
    );
  });

  it('cuts a large blob into parts and completes the upload', async () => {
    const { server, backend } = await fixture();
    const bytes = bytesOfLength(12 * 1024 * 1024, 'multipart');

    const result = await backend.put(bytes);

    const operations = server.requests.map((request) => request.operation);
    expect(operations).toContain('CreateMultipartUpload');
    expect(operations.filter((operation) => operation === 'UploadPart')).toHaveLength(3);
    expect(operations).toContain('CompleteMultipartUpload');
    expect(server.uploads.size).toBe(0);

    const stored = server.objects.get(`library/${storageKeyFor(result.sha256)}`);
    expect(stored?.body.byteLength).toBe(bytes.byteLength);
    expect(digestOf(stored?.body ?? Buffer.alloc(0))).toBe(result.sha256);
    expect(digestOf(await backend.getBuffer(result.sha256))).toBe(result.sha256);
  });

  it('sends a per-part checksum that the server verifies', async () => {
    const { server, backend } = await fixture();
    const bytes = bytesOfLength(12 * 1024 * 1024, 'multipart-checksums');

    await backend.put(bytes);

    const parts = server.requests.filter((request) => request.operation === 'UploadPart');
    expect(parts).toHaveLength(3);
    const firstPart = bytes.subarray(0, 5 * 1024 * 1024);
    expect(parts[0]?.headers['x-amz-checksum-sha256']).toBe(
      createHash('sha256').update(firstPart).digest('base64'),
    );
  });

  it('does not mistake a multipart object’s composite checksum for its digest', async () => {
    // A completed multipart object advertises `<hash of the part hashes>-N`, which is not the
    // SHA-256 of anything the store knows about. Comparing it to the key would fail every large
    // blob and "repair" it on every put — an infinite re-upload of the whole library.
    const { server, backend } = await fixture();
    const bytes = bytesOfLength(12 * 1024 * 1024, 'composite');

    const first = await backend.put(bytes);
    const stored = server.objects.get(`library/${storageKeyFor(first.sha256)}`);
    expect(stored?.checksumSha256).toMatch(/-3$/u);
    expect(stored?.checksumSha256).not.toBe(base64Digest(first.sha256));

    const second = await backend.put(bytes, { verify: 'digest' });

    expect(second.created).toBe(false);
    expect(second.repaired).toBe(false);
  });

  it('aborts the upload when a part fails, leaving nothing billable behind', async () => {
    const { server, backend } = await fixture(
      { failPartNumber: 2 },
      { retry: { attempts: 1, baseDelayMs: 1, jitter: false } },
    );

    await expect(backend.put(bytesOfLength(12 * 1024 * 1024, 'doomed'))).rejects.toThrow(
      /injected failure on part 2/u,
    );

    expect(server.requests.map((request) => request.operation)).toContain('AbortMultipartUpload');
    expect(server.uploads.size).toBe(0);
    expect([...server.objects.keys()]).toEqual([]);
  });

  it('names the upload that could not be aborted, because nothing else will', async () => {
    const { server, backend } = await fixture(
      { failPartNumber: 2, breakAbort: true },
      { retry: { attempts: 1, baseDelayMs: 1, jitter: false } },
    );

    const error = await backend
      .put(bytesOfLength(12 * 1024 * 1024, 'abandoned'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageAbandonedUploadError);
    const abandoned = error as StorageAbandonedUploadError;
    expect(abandoned.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(abandoned.key).toBe(storageKeyFor(digestOf(bytesOfLength(12 * 1024 * 1024, 'abandoned'))));
    expect(abandoned.message).toMatch(/billable/u);
    // And the point of the error: the parts really are still there.
    expect(server.uploads.size).toBe(1);
  });

  it('retries a part that failed transiently rather than abandoning the whole upload', async () => {
    const { server, backend, slept } = await fixture({ failPartNumber: 2 });

    const result = await backend.put(bytesOfLength(12 * 1024 * 1024, 'flaky-part'));

    expect(result.created).toBe(true);
    expect(slept).toEqual([10]);
    expect(server.uploads.size).toBe(0);
    expect(server.requests.map((request) => request.operation)).not.toContain(
      'AbortMultipartUpload',
    );
  });
});

describe('S3Backend consistency and retrying', () => {
  it('retries a 503 with a doubling backoff and then succeeds', async () => {
    const { server, backend, slept } = await fixture();
    server.setFault({ failFirst: 2, status: 503, code: 'SlowDown', operation: 'PutObject' });

    const result = await backend.put(Buffer.from('third time lucky', 'utf8'));

    expect(result.created).toBe(true);
    expect(slept).toEqual([10, 20]);
    expect(
      server.requests.filter((request) => request.operation === 'PutObject'),
    ).toHaveLength(3);
  });

  it('does not retry an AccessDenied', async () => {
    const { server, backend, slept } = await fixture();
    server.setFault({ failFirst: 99, status: 403, code: 'AccessDenied', operation: 'PutObject' });

    const error = await backend.put(Buffer.from('forbidden', 'utf8')).catch((e: unknown) => e);

    expect((error as { name?: string }).name).toBe('AccessDenied');
    expect(slept).toEqual([]);
    expect(server.requests.filter((request) => request.operation === 'PutObject')).toHaveLength(1);
  });

  it('reports a write that the store cannot read back yet rather than believing the 200', async () => {
    // Eventual consistency, as seen from the client: the upload was accepted and the object is
    // not there. On MinIO in distributed mode or Garage mid-rebalance this is replication lag; on
    // S3 itself, which has been strongly read-after-write consistent since 2020, it is a lost
    // write. The backend cannot tell them apart and does not pretend to.
    const { backend } = await fixture({ readAfterWriteMisses: 1 });

    const error = await backend.put(Buffer.from('not there yet', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as StorageRequestError).status).toBe(404);
    expect((error as Error).message).toMatch(/read-after-write/u);
  });

  it('does not notice the same lag when the write check is switched off', async () => {
    // The other half of the trade-off, stated as a test rather than as a promise: with
    // `verifyOnWrite: 'none'` the put returns happily and the caller only finds out on the read —
    // which, on a store that is catching up, is a `get` that raises "not in the store" for a blob
    // the database is about to say exists.
    const bytes = Buffer.from('not there yet either', 'utf8');
    const { backend } = await fixture({ readAfterWriteMisses: 1 }, { verifyOnWrite: 'none' });

    const result = await backend.put(bytes);
    expect(result.created).toBe(true);

    await expect(backend.getBuffer(result.sha256)).rejects.toThrow(/not in the store/u);
    // And once the lag is over, the blob was there all along.
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });

  it('catches a store that truncated the object it was sent', async () => {
    const { backend } = await fixture({ truncatePutsTo: 3 });

    const error = await backend
      .put(Buffer.from('rather longer than three bytes', 'utf8'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as Error).message).toMatch(/holds 3 bytes of the 30/u);
  });
});

describe('S3Backend write verification levels', () => {
  it('lets a same-length corruption through when only the size is checked', async () => {
    // The store agreed with the checksum it was sent and then wrote something else. One
    // `HeadObject` cannot see that, and this backend does not pretend otherwise.
    const { backend } = await fixture({ flipStoredByte: 0 }, { verifyOnWrite: 'size' });

    const result = await backend.put(Buffer.from('one byte will be flipped', 'utf8'));

    expect(result.created).toBe(true);
    // The read is where it is caught, because reads verify against the key.
    await expect(backend.getBuffer(result.sha256)).rejects.toThrow(/Integrity failure/u);
  });

  it('catches the same corruption when the write is verified by digest', async () => {
    const { backend } = await fixture({ flipStoredByte: 0 }, { verifyOnWrite: 'digest' });

    const error = await backend
      .put(Buffer.from('one byte will be flipped', 'utf8'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as Error).message).toMatch(/does not hash to/u);
  });

  it('checks an existing object by digest on every put when built that way', async () => {
    const { server, backend } = await fixture({}, { verifyOnPut: 'digest' });
    const bytes = Buffer.from('rot me in place!', 'utf8');
    const rotted = Buffer.from('rot me in plaice', 'utf8');
    expect(rotted.byteLength).toBe(bytes.byteLength);

    const first = await backend.put(bytes);
    server.corrupt('library', storageKeyFor(first.sha256), rotted);

    // No per-call `verify`: the backend was constructed to check the digest every time.
    const second = await backend.put(bytes);

    expect(second.repaired).toBe(true);
    expect(await backend.getBuffer(first.sha256)).toEqual(bytes);
  });
});

describe('the S3 fake itself', () => {
  /**
   * A conformance run against a fake that accepts everything proves nothing. These three assert
   * that the fake really does enforce what the backend is relying on it to enforce.
   */
  it('rejects a PutObject whose x-amz-checksum-sha256 does not match the body', async () => {
    const server = await startFakeS3Server({ buckets: ['library'] });
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: server.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: { httpAgent: server.agent },
    });
    cleanup.push(async () => {
      client.destroy();
      await server.close();
    });

    const error = await client
      .send(
        new PutObjectCommand({
          Bucket: 'library',
          Key: 'aa/bb/whatever',
          Body: Buffer.from('these bytes', 'utf8'),
          ChecksumSHA256: base64Digest(digestOf(Buffer.from('different bytes', 'utf8'))),
        }),
      )
      .catch((e: unknown) => e);

    expect((error as { name?: string }).name).toBe('BadDigest');
    expect(server.objects.size).toBe(0);
  });

  it('enforces the 5 MiB minimum on every part but the last, as S3 does', async () => {
    // Driven directly, because the backend is not allowed to send this shape — which is the point:
    // the fake would catch it if a future change to `partSizeFor` ever let one through.
    const server = await startFakeS3Server({ buckets: ['library'] });
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: server.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: { httpAgent: server.agent },
    });
    cleanup.push(async () => {
      client.destroy();
      await server.close();
    });

    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: 'library', Key: 'aa/bb/too-small' }),
    );
    const parts = [];
    for (const partNumber of [1, 2]) {
      const uploaded = await client.send(
        new UploadPartCommand({
          Bucket: 'library',
          Key: 'aa/bb/too-small',
          UploadId: created.UploadId,
          PartNumber: partNumber,
          Body: Buffer.alloc(1024, partNumber),
        }),
      );
      parts.push({ PartNumber: partNumber, ETag: uploaded.ETag });
    }

    const error = await client
      .send(
        new CompleteMultipartUploadCommand({
          Bucket: 'library',
          Key: 'aa/bb/too-small',
          UploadId: created.UploadId,
          MultipartUpload: { Parts: parts },
        }),
      )
      .catch((e: unknown) => e);

    expect((error as { name?: string }).name).toBe('EntityTooSmall');
    expect(server.objects.size).toBe(0);
  });

  it('grows the part size so a blob cannot exceed the 10 000-part limit', () => {
    const eightMiB = 8 * 1024 * 1024;
    expect(partSizeFor(100 * 1024 * 1024, eightMiB)).toBe(eightMiB);
    // 80 GB is exactly 10 000 × 8 MiB; one byte more needs a bigger part.
    expect(partSizeFor(10_000 * eightMiB, eightMiB)).toBe(eightMiB);
    expect(partSizeFor(10_000 * eightMiB + 1, eightMiB)).toBe(2 * eightMiB);
    // 5 TiB is S3's largest object; it needs 1 GiB parts, which is inside the 5 GiB part limit.
    expect(partSizeFor(5 * 1024 ** 4, eightMiB)).toBe(1024 * 1024 * 1024);
    // And a configured part size below the S3 minimum is raised to it.
    expect(partSizeFor(1024, 1024)).toBe(5 * 1024 * 1024);
  });

  it('refuses a request with no Authorization header', async () => {
    const server = await startFakeS3Server({ buckets: ['library'] });
    cleanup.push(async () => server.close());

    const response = await fetch(`${server.endpoint}/library/aa/bb/anything`);

    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/AccessDenied/u);
  });
});
