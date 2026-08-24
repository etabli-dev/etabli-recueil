/**
 * The same suite, three backends.
 *
 * `CreateRecueilOptions.storage` says any `StorageBackend` will do. This file is what turns that
 * from an assertion in a type into something that has been checked: the local filesystem backend
 * from `@recueil/core` runs the identical suite as the two written here, and a divergence in any of
 * the twenty-odd properties fails somebody's build rather than somebody's library.
 */
import { runStorageBackendConformance } from '../src/conformance/index.js';
import { localHarness, s3Harness, webdavHarness } from './harnesses.js';

runStorageBackendConformance({
  name: 'LocalFsBackend',
  create: localHarness,
  largeBlobSize: 1024 * 1024,
  // The local backend hands back a plain read stream and offers `verify()` separately. That is a
  // defensible choice for bytes on the same disk as the process, and the suite records it as a
  // difference rather than pretending it away.
  capabilities: { verifiesOnRead: false },
});

runStorageBackendConformance({
  name: 'WebDavBackend',
  create: webdavHarness,
  largeBlobSize: 4 * 1024 * 1024,
  capabilities: { verifiesOnRead: true },
});

runStorageBackendConformance({
  name: 'S3Backend',
  create: s3Harness,
  // Above the harness's 6 MiB multipart threshold, so the three-call upload path is part of
  // conformance and not a footnote in a file nobody runs.
  largeBlobSize: 12 * 1024 * 1024,
  capabilities: { verifiesOnRead: true },
});
