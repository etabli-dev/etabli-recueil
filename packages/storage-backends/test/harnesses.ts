/**
 * The three harnesses the conformance suite is run against.
 *
 * They are here rather than in `src/` because they are wiring for this package's own test run: a
 * temporary directory, a fake server, a way to reach behind the backend and corrupt a blob. The
 * suite itself is exported; these are not.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalFsBackend, storageKeyFor } from '@recueil/core';

import { S3Backend } from '../src/s3/backend.js';
import { startFakeS3Server } from '../src/testing/s3-server.js';
import { startFakeWebDavServer } from '../src/testing/webdav-server.js';
import type { ConformanceSubject } from '../src/conformance/index.js';
import { WebDavBackend } from '../src/webdav/backend.js';

export const temporaryDirectory = async (label: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `recueil-${label}-`));

export const localHarness = async (): Promise<ConformanceSubject> => {
  const root = await temporaryDirectory('local-store');
  const backend = new LocalFsBackend({ root });
  return {
    backend,
    corrupt: async (sha256, bytes) => writeFile(backend.path(sha256), bytes),
    dispose: async () => rm(root, { recursive: true, force: true }),
  };
};

export const webdavHarness = async (): Promise<ConformanceSubject> => {
  const server = await startFakeWebDavServer({
    auth: { kind: 'basic', username: 'rh', password: 'app-password' },
  });
  const scratch = await temporaryDirectory('webdav-scratch');
  const backend = new WebDavBackend({
    url: server.url,
    auth: { kind: 'basic', username: 'rh', password: 'app-password' },
    scratchDirectory: scratch,
    retry: { attempts: 3, baseDelayMs: 1, jitter: false },
  });
  return {
    backend,
    corrupt: async (sha256, bytes) => server.corrupt(storageKeyFor(sha256), bytes),
    dispose: async () => {
      await server.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
};

export const s3Harness = async (): Promise<ConformanceSubject> => {
  const server = await startFakeS3Server({ buckets: ['library'] });
  const scratch = await temporaryDirectory('s3-scratch');
  const backend = new S3Backend({
    bucket: 'library',
    endpoint: server.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
    scratchDirectory: scratch,
    // Small enough that the conformance suite's large-blob case really does go through the
    // multipart path, and no larger, because every byte crosses a loopback socket.
    multipartThreshold: 6 * 1024 * 1024,
    partSize: 5 * 1024 * 1024,
    retry: { attempts: 3, baseDelayMs: 1, jitter: false },
    clientConfig: { requestHandler: { httpAgent: server.agent } },
  });
  return {
    backend,
    corrupt: async (sha256, bytes) => {
      server.corrupt('library', storageKeyFor(sha256), bytes);
    },
    dispose: async () => {
      backend.destroy();
      await server.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
};
