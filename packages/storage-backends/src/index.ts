/**
 * `@recueil/storage-backends` — the WebDAV and S3 implementations of `StorageBackend`.
 *
 * `@recueil/core` owns the contract and the local filesystem implementation. This package adds the
 * two remote ones CONCEPT §5.1 promises, and the conformance suite that establishes all three are
 * interchangeable rather than merely similarly named. Nothing here is imported by `@recueil/core`:
 * the dependency runs one way, so a deployment that only ever writes to a local disk does not pull
 * in the AWS SDK.
 *
 * ```ts
 * const storage = new S3Backend({ bucket: 'library', endpoint: 'http://minio:9000', … });
 * const recueil = createRecueil({ databaseUrl, storagePath: '/unused', storage });
 * ```
 *
 * Read `README.md` before putting either of these in front of a library. Both have failure modes
 * the local backend does not, and two of them — an abandoned multipart upload and a WebDAV server
 * that silently drops a checksum header — are invisible unless you go looking.
 */
export * from './errors.js';
export * from './retry.js';
export * from './spool.js';
export * from './verify.js';

export { WebDavBackend, contentMd5 } from './webdav/backend.js';
export type { WebDavBackendOptions } from './webdav/backend.js';
export { WebDavClient, assertSegment, drain, isRetryableWebDavError } from './webdav/client.js';
export type {
  WebDavAuth,
  WebDavCapabilities,
  WebDavClientOptions,
  WebDavResponse,
} from './webdav/client.js';

export { S3Backend, base64Digest, isNotFound, isRetryableS3Error, partSizeFor } from './s3/backend.js';
export type { S3BackendOptions } from './s3/backend.js';

/**
 * The conformance suite is **not** re-exported here.
 *
 * It imports `vitest`, and this module is imported by the server. A production process that pulled
 * in a test framework because a barrel file was tidy would be a real bug and a slow one to find, so
 * the suite lives behind `@recueil/storage-backends/conformance` and the fakes behind
 * `@recueil/storage-backends/testing`. `test/packaging.test.ts` checks that it stays that way.
 */
