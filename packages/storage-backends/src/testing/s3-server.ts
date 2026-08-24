/**
 * An in-process, S3-compatible HTTP server, for testing the S3 backend without a container.
 *
 * **What this is not.** It is not MinIO, it is not Garage and it is certainly not S3, and passing
 * against it is not a compatibility claim about any of them — a fake written alongside the client
 * agrees with the client by construction. What it implements is the eight operations the store
 * uses, the parts of their contract the store depends on (`BadDigest` on a checksum mismatch,
 * `EntityTooSmall` on a short part, composite checksums on multipart objects, 404 shapes for
 * `NoSuchKey` and `NotFound`), and — the reason it exists — the failures that are impossible to
 * arrange against a real service: a 503 on the third request only, a part upload that fails, an
 * abort that fails after it, and a read that misses immediately after a write.
 *
 * Signatures are not checked. The `Authorization` header is required to be present, so a test can
 * prove credentials are being sent, but its contents are ignored: verifying SigV4 here would test
 * the AWS SDK, which is not this package's job.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Agent as HttpAgent, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Agent } from 'node:http';

export interface FakeS3Fault {
  /** Answer the first `n` matching requests with a failure, then behave. */
  failFirst?: number;
  /** HTTP status of the injected failure. Default 503. */
  status?: number;
  /** S3 error code of the injected failure. Default `SlowDown`. */
  code?: string;
  /** Restrict the failure to one operation: `PutObject`, `UploadPart`, `HeadObject`… */
  operation?: string;
  /** Sent with the failure so the retry loop's `Retry-After` handling can be exercised. */
  retryAfter?: string;
}

export interface FakeS3Options {
  /** Buckets that exist. Anything else answers `NoSuchBucket`. */
  buckets: readonly string[];
  fault?: FakeS3Fault;
  /** Fail this part number, once, whatever else is going on. For testing the abort path. */
  failPartNumber?: number;
  /** Make `AbortMultipartUpload` fail, so the abandoned-upload error can be tested. */
  breakAbort?: boolean;
  /**
   * Answer the first `n` reads of a freshly written key with 404.
   *
   * S3 has been strongly read-after-write consistent since December 2020. MinIO in distributed
   * mode, Garage during a rebalance and any caching gateway in front of either are not, and this
   * is what that looks like from the client's side.
   */
  readAfterWriteMisses?: number;
  /** Never echo `x-amz-checksum-sha256`: a gateway that drops the header it was sent. */
  dropChecksumHeaders?: boolean;
  /** Store only the first `n` bytes of each `PutObject` body, and answer 200 regardless. */
  truncatePutsTo?: number;
  /**
   * Flip one byte of each stored `PutObject` body, after the checksum has been verified.
   *
   * A store that accepted the upload, agreed with its checksum, and then wrote something else — rot
   * at rest, or a gateway that verifies and then loses a block. The length is unchanged, so it is
   * the case a size check cannot see.
   */
  flipStoredByte?: number;
  /** Enforce the 5 MiB minimum on every part but the last, as S3 does. Default true. */
  enforceMinimumPartSize?: boolean;
}

export interface FakeS3Object {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  /** Base64, and `…-N` for an object assembled from parts. Undefined when none was sent. */
  checksumSha256: string | undefined;
  etag: string;
}

export interface FakeS3Upload {
  bucket: string;
  key: string;
  parts: Map<number, { body: Buffer; etag: string; checksumSha256: string | undefined }>;
  metadata: Record<string, string>;
}

export interface FakeS3Server {
  /** Endpoint URL for the SDK, pointing at the loopback address the server bound. */
  endpoint: string;
  /**
   * An agent whose DNS always resolves to the loopback address the server bound, whatever hostname
   * the SDK put in the URL. It is what makes virtual-host-style addressing testable without
   * wildcard DNS: the `Host` header says `bucket.s3.example`, the socket goes to 127.0.0.1.
   */
  agent: HttpAgent;
  /** A hostname to use as the endpoint for virtual-host-style addressing. Never resolved. */
  virtualHostEndpoint: string;
  objects: Map<string, FakeS3Object>;
  /** Multipart uploads that have been created and neither completed nor aborted. */
  uploads: Map<string, FakeS3Upload>;
  readonly requests: Array<{
    operation: string;
    method: string;
    url: string;
    host: string;
    bucket: string;
    key: string;
    headers: Record<string, string>;
  }>;
  setFault(fault: FakeS3Fault | undefined): void;
  /** Replace an object's bytes out of band, to simulate rot. */
  corrupt(bucket: string, key: string, bytes: Buffer): void;
  close(): Promise<void>;
}

const xmlError = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>fake</RequestId></Error>`;

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const md5 = (bytes: Buffer): Buffer => createHash('md5').update(bytes).digest();

const sha256 = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();

/** The five predefined XML entities. The SDK escapes an ETag's quotes, so this is not optional. */
const unescapeXml = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** Pull the values of one repeated element out of a small XML document. */
const elements = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gu'))].map((match) =>
    unescapeXml(match[1] ?? ''),
  );

export const startFakeS3Server = async (options: FakeS3Options): Promise<FakeS3Server> => {
  const buckets = new Set(options.buckets);
  const objects = new Map<string, FakeS3Object>();
  const uploads = new Map<string, FakeS3Upload>();
  const requests: FakeS3Server['requests'] = [];
  const missesLeft = new Map<string, number>();
  let fault = options.fault;
  let faultsServed = 0;
  let partFailuresLeft = options.failPartNumber === undefined ? 0 : 1;

  const fail = (response: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void => {
    const body = xmlError(code, message);
    response.writeHead(status, {
      'content-type': 'application/xml',
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    });
    response.end(body);
  };

  const ok = (response: ServerResponse, status: number, headers: Record<string, string>, body = ''): void => {
    response.writeHead(status, { 'content-length': String(Buffer.byteLength(body)), ...headers });
    response.end(body);
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.url ?? '/', 'http://placeholder');
    const hostHeader = (request.headers.host ?? '').split(':')[0] ?? '';

    // Virtual-host style when the host begins with a known bucket name; path style otherwise.
    let bucket = '';
    let key = '';
    const virtualBucket = [...buckets].find((name) => hostHeader.startsWith(`${name}.`));
    if (virtualBucket !== undefined) {
      bucket = virtualBucket;
      key = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
    } else {
      const [first = '', ...rest] = url.pathname.replace(/^\/+/u, '').split('/');
      bucket = decodeURIComponent(first);
      key = rest.map((segment) => decodeURIComponent(segment)).join('/');
    }

    const uploadId = url.searchParams.get('uploadId');
    const partNumber = url.searchParams.get('partNumber');
    const operation =
      method === 'POST' && url.searchParams.has('uploads')
        ? 'CreateMultipartUpload'
        : method === 'PUT' && uploadId !== null
          ? 'UploadPart'
          : method === 'POST' && uploadId !== null
            ? 'CompleteMultipartUpload'
            : method === 'DELETE' && uploadId !== null
              ? 'AbortMultipartUpload'
              : method === 'PUT'
                ? 'PutObject'
                : method === 'HEAD'
                  ? 'HeadObject'
                  : method === 'DELETE'
                    ? 'DeleteObject'
                    : 'GetObject';

    requests.push({
      operation,
      method,
      url: request.url ?? '',
      host: String(request.headers.host ?? ''),
      bucket,
      key,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : (value ?? ''),
        ]),
      ),
    });

    if (request.headers.authorization === undefined) {
      await readBody(request).catch(() => undefined);
      fail(response, 403, 'AccessDenied', 'No Authorization header was sent.');
      return;
    }

    if (
      fault?.failFirst !== undefined &&
      faultsServed < fault.failFirst &&
      (fault.operation === undefined || fault.operation === operation)
    ) {
      faultsServed += 1;
      await readBody(request).catch(() => undefined);
      fail(
        response,
        fault.status ?? 503,
        fault.code ?? 'SlowDown',
        'injected fault',
        fault.retryAfter === undefined ? {} : { 'retry-after': fault.retryAfter },
      );
      return;
    }

    if (!buckets.has(bucket)) {
      await readBody(request).catch(() => undefined);
      fail(response, 404, 'NoSuchBucket', `No bucket named '${bucket}'.`);
      return;
    }

    const objectId = `${bucket}/${key}`;

    switch (operation) {
      case 'PutObject': {
        const encoding = String(request.headers['content-encoding'] ?? '');
        const payloadHash = String(request.headers['x-amz-content-sha256'] ?? '');
        if (encoding.includes('aws-chunked') || payloadHash.startsWith('STREAMING')) {
          await readBody(request).catch(() => undefined);
          fail(
            response,
            501,
            'NotImplemented',
            'This fake does not decode aws-chunked bodies. The backend is expected to send a ' +
              'plain Content-Length request; if it stopped doing so, that is the bug.',
          );
          return;
        }

        const body = await readBody(request);
        const advertisedLength = request.headers['content-length'];
        if (advertisedLength !== undefined && Number(advertisedLength) !== body.byteLength) {
          fail(response, 400, 'IncompleteBody', 'The body is shorter than Content-Length said.');
          return;
        }

        const advertised = request.headers['x-amz-checksum-sha256'];
        if (typeof advertised === 'string' && advertised !== sha256(body).toString('base64')) {
          fail(
            response,
            400,
            'BadDigest',
            'The SHA-256 you specified did not match what the server received.',
          );
          return;
        }

        let stored =
          options.truncatePutsTo === undefined ? body : body.subarray(0, options.truncatePutsTo);
        if (options.flipStoredByte !== undefined && options.flipStoredByte < stored.byteLength) {
          const mutated = Buffer.from(stored);
          mutated.writeUInt8(mutated.readUInt8(options.flipStoredByte) ^ 0xff, options.flipStoredByte);
          stored = mutated;
        }
        const etag = `"${md5(stored).toString('hex')}"`;
        objects.set(objectId, {
          body: stored,
          contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
          metadata: metadataFrom(request),
          checksumSha256: typeof advertised === 'string' ? advertised : undefined,
          etag,
        });
        if (options.readAfterWriteMisses !== undefined) {
          missesLeft.set(objectId, options.readAfterWriteMisses);
        }
        ok(response, 200, {
          etag,
          ...(typeof advertised === 'string' && options.dropChecksumHeaders !== true
            ? { 'x-amz-checksum-sha256': advertised }
            : {}),
        });
        return;
      }

      case 'GetObject':
      case 'HeadObject': {
        const remaining = missesLeft.get(objectId) ?? 0;
        if (remaining > 0) {
          missesLeft.set(objectId, remaining - 1);
          fail(response, 404, operation === 'HeadObject' ? 'NotFound' : 'NoSuchKey', 'not yet');
          return;
        }
        const found = objects.get(objectId);
        if (found === undefined) {
          fail(response, 404, operation === 'HeadObject' ? 'NotFound' : 'NoSuchKey', 'no such key');
          return;
        }
        const headers: Record<string, string> = {
          'content-length': String(found.body.byteLength),
          'content-type': found.contentType,
          etag: found.etag,
          'accept-ranges': 'bytes',
        };
        if (found.checksumSha256 !== undefined && options.dropChecksumHeaders !== true) {
          headers['x-amz-checksum-sha256'] = found.checksumSha256;
        }
        for (const [name, value] of Object.entries(found.metadata)) {
          headers[`x-amz-meta-${name}`] = value;
        }
        if (operation === 'HeadObject') {
          response.writeHead(200, headers);
          response.end();
          return;
        }
        response.writeHead(200, headers);
        response.end(found.body);
        return;
      }

      case 'DeleteObject': {
        objects.delete(objectId);
        ok(response, 204, {});
        return;
      }

      case 'CreateMultipartUpload': {
        await readBody(request).catch(() => undefined);
        const id = randomUUID();
        uploads.set(id, { bucket, key, parts: new Map(), metadata: metadataFrom(request) });
        ok(
          response,
          200,
          { 'content-type': 'application/xml' },
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }

      case 'UploadPart': {
        const upload = uploadId === null ? undefined : uploads.get(uploadId);
        const body = await readBody(request);
        if (upload === undefined) {
          fail(response, 404, 'NoSuchUpload', 'The upload id is unknown, or already completed.');
          return;
        }
        const number = Number(partNumber);
        if (!Number.isInteger(number) || number < 1 || number > 10_000) {
          fail(response, 400, 'InvalidArgument', 'Part number must be between 1 and 10000.');
          return;
        }
        if (options.failPartNumber === number && partFailuresLeft > 0) {
          partFailuresLeft -= 1;
          fail(response, 500, 'InternalError', `injected failure on part ${number}`);
          return;
        }
        const advertised = request.headers['x-amz-checksum-sha256'];
        if (typeof advertised === 'string' && advertised !== sha256(body).toString('base64')) {
          fail(response, 400, 'BadDigest', 'The part checksum did not match the part.');
          return;
        }
        const etag = `"${md5(body).toString('hex')}"`;
        upload.parts.set(number, {
          body,
          etag,
          checksumSha256: typeof advertised === 'string' ? advertised : sha256(body).toString('base64'),
        });
        ok(response, 200, {
          etag,
          ...(options.dropChecksumHeaders === true
            ? {}
            : { 'x-amz-checksum-sha256': upload.parts.get(number)?.checksumSha256 ?? '' }),
        });
        return;
      }

      case 'CompleteMultipartUpload': {
        const xml = (await readBody(request)).toString('utf8');
        const upload = uploadId === null ? undefined : uploads.get(uploadId);
        if (upload === undefined) {
          fail(response, 404, 'NoSuchUpload', 'The upload id is unknown, or already completed.');
          return;
        }

        const requested = elements(xml, 'Part').map((part) => ({
          number: Number(elements(part, 'PartNumber')[0] ?? '0'),
          etag: (elements(part, 'ETag')[0] ?? '').trim(),
          checksum: elements(part, 'ChecksumSHA256')[0],
        }));
        if (requested.length === 0) {
          fail(response, 400, 'InvalidRequest', 'No parts were listed.');
          return;
        }

        const ordered = [...requested].sort((left, right) => left.number - right.number);
        const bodies: Buffer[] = [];
        for (const [index, part] of ordered.entries()) {
          const stored = upload.parts.get(part.number);
          if (stored === undefined) {
            fail(response, 400, 'InvalidPart', `Part ${part.number} was never uploaded.`);
            return;
          }
          if (part.etag.replaceAll('"', '') !== stored.etag.replaceAll('"', '')) {
            fail(response, 400, 'InvalidPart', `Part ${part.number} has the wrong ETag.`);
            return;
          }
          if (part.checksum !== undefined && part.checksum !== stored.checksumSha256) {
            fail(response, 400, 'BadDigest', `Part ${part.number} has the wrong checksum.`);
            return;
          }
          const isLast = index === ordered.length - 1;
          if (
            options.enforceMinimumPartSize !== false &&
            !isLast &&
            stored.body.byteLength < 5 * 1024 * 1024
          ) {
            fail(
              response,
              400,
              'EntityTooSmall',
              `Part ${part.number} is ${stored.body.byteLength} bytes; every part but the last must be at least 5 MiB.`,
            );
            return;
          }
          bodies.push(stored.body);
        }

        const whole = Buffer.concat(bodies);
        // A multipart object's ETag and checksum are both *composite*: a hash of the concatenated
        // per-part hashes, with the part count appended. Neither is the hash of the object, which
        // is exactly the trap the backend has to avoid falling into.
        const compositeEtag = `"${md5(Buffer.concat(ordered.map((part) => md5(upload.parts.get(part.number)?.body ?? Buffer.alloc(0))))).toString('hex')}-${ordered.length}"`;
        const compositeChecksum = `${sha256(
          Buffer.concat(
            ordered.map((part) =>
              Buffer.from(upload.parts.get(part.number)?.checksumSha256 ?? '', 'base64'),
            ),
          ),
        ).toString('base64')}-${ordered.length}`;

        objects.set(`${upload.bucket}/${upload.key}`, {
          body: whole,
          contentType: 'application/octet-stream',
          metadata: upload.metadata,
          checksumSha256: compositeChecksum,
          etag: compositeEtag,
        });
        uploads.delete(uploadId as string);
        if (options.readAfterWriteMisses !== undefined) {
          missesLeft.set(`${upload.bucket}/${upload.key}`, options.readAfterWriteMisses);
        }

        ok(
          response,
          200,
          { 'content-type': 'application/xml' },
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>http://${hostHeader}/${upload.key}</Location><Bucket>${upload.bucket}</Bucket><Key>${upload.key}</Key><ETag>&quot;${compositeEtag.replaceAll('"', '')}&quot;</ETag><ChecksumSHA256>${compositeChecksum}</ChecksumSHA256></CompleteMultipartUploadResult>`,
        );
        return;
      }

      case 'AbortMultipartUpload': {
        await readBody(request).catch(() => undefined);
        if (options.breakAbort === true) {
          fail(response, 500, 'InternalError', 'injected: this abort will not work');
          return;
        }
        if (uploadId !== null) uploads.delete(uploadId);
        ok(response, 204, {});
        return;
      }

      default:
        fail(response, 501, 'NotImplemented', `${operation} is not implemented by this fake.`);
    }
  };

  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) fail(response, 500, 'InternalError', String(error));
      else response.end();
    });
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The fake S3 server did not bind.');

  // Whatever hostname the SDK signs and sends, the socket goes here. That is what lets one fake
  // serve both addressing styles without wildcard DNS.
  const agent = new Agent({
    keepAlive: false,
    // `net.connect` asks for every address at once when `autoSelectFamily` is on, which it is by
    // default from Node 20, so the callback has two shapes to satisfy.
    lookup: (
      _hostname: string,
      opts: { all?: boolean },
      callback: (
        error: null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => {
      if (opts.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    },
  } as unknown as ConstructorParameters<typeof Agent>[0]);

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    virtualHostEndpoint: `http://s3.recueil.invalid:${address.port}`,
    agent,
    objects,
    uploads,
    requests,
    setFault: (next) => {
      fault = next;
      faultsServed = 0;
    },
    corrupt: (bucketName, key, bytes) => {
      const found = objects.get(`${bucketName}/${key}`);
      if (found === undefined) throw new Error(`No object at ${bucketName}/${key} to corrupt.`);
      objects.set(`${bucketName}/${key}`, {
        ...found,
        body: bytes,
        // A store that rots does not helpfully update its own checksum metadata.
        etag: found.etag,
      });
    },
    close: async () => {
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
    },
  };
};

const metadataFrom = (request: IncomingMessage): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.startsWith('x-amz-meta-')) continue;
    metadata[name.slice('x-amz-meta-'.length)] = Array.isArray(value) ? value.join(', ') : (value ?? '');
  }
  return metadata;
};
