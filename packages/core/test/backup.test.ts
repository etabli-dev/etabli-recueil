/**
 * Backup and restore, against the failures a backup exists to survive.
 *
 * Two of these are regressions for defects an adversarial review reproduced, and both are the same
 * mistake in different clothing: **trusting data that came from outside the process**.
 *
 * - M1. A manifest is not configuration. It arrives on removable media, years later, from wherever
 *   the snapshot has been. Its `path` fields are joined onto the snapshot root to read *and* onto
 *   the restore target to write, so an entry saying `../../…` reads outside the snapshot, writes
 *   outside the target, and is then deleted by the rollback that tidies up after the failure.
 * - M2. A blob's filename is not its digest, it is a claim about its digest. An incremental
 *   snapshot that hashed only the destination stopped reading the live store from the second night
 *   onward, so rot in the live store became invisible and `onCorruptBlob: 'fail'` could not fire.
 */
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BackupFormatError,
  DATABASE_FILE,
  MANIFEST_FILE,
  blobPath,
  createBackup,
  MAX_MANIFEST_BYTES,
  parseManifest,
  readManifestFile,
  restoreBackup,
  verifyBackup,
} from '../src/index.js';
import type { BackupManifest } from '../src/index.js';
import { makeLibrary, makeTempDirectory } from './helpers.js';

const disposables: { dispose(): void }[] = [];

const library = () => {
  const made = makeLibrary();
  disposables.push(made);
  return made;
};

const directory = () => {
  const made = makeTempDirectory();
  disposables.push(made);
  return made.path;
};

afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose();
});

/** A library with two blobs in its store, closed so the database file is quiescent. */
const libraryWithBlobs = async (): Promise<{ databaseFile: string; storageRoot: string; digests: string[] }> => {
  const recueil = library();
  const digests: string[] = [];
  for (const text of ['the first blob, at some length', 'the second blob, also of some length']) {
    const ingested = await recueil.documents.ingestBuffer(Buffer.from(text, 'utf8'), {
      sourceKind: 'upload',
      originalFilename: `${text.slice(4, 9)}.txt`,
    });
    digests.push(ingested.document.sha256);
  }
  return { databaseFile: recueil.databaseFile, storageRoot: recueil.storageRoot, digests };
};

/** Rewrite a snapshot's manifest through a mutator, as an attacker with the media would. */
const rewriteManifest = (root: string, mutate: (manifest: BackupManifest) => unknown): void => {
  const path = join(root, MANIFEST_FILE);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
  writeFileSync(path, `${JSON.stringify(mutate(parsed) ?? parsed, null, 2)}\n`, 'utf8');
};

describe('a manifest path is hostile until it has been checked (M1)', () => {
  it('refuses a manifest entry that climbs out of the snapshot, before any I/O', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    const snapshot = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    expect(snapshot.manifest.storage.blobs.length).toBeGreaterThan(0);

    rewriteManifest(out, (manifest) => {
      (manifest.storage.blobs as unknown as { path: string }[])[0]!.path = '../../escaped.txt';
    });

    await expect(verifyBackup(out)).rejects.toThrow(BackupFormatError);
    await expect(verifyBackup(out)).rejects.toThrow(/not a path inside the snapshot/u);
  });

  it('does not write outside the restore target, and does not delete outside it either', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();

    // The snapshot and the restore target are siblings, so one `../precious.txt` in the manifest
    // names the same bystander file on both sides — which is how the reviewer reproduced it: the
    // entry is read from outside the snapshot, written outside the target, and then *deleted* by
    // the rollback that runs when the copy fails verification.
    const workspace = directory();
    const out = join(workspace, 'snapshot');
    const into = join(workspace, 'restored');
    mkdirSync(into, { recursive: true });
    const bystander = join(workspace, 'precious.txt');
    writeFileSync(bystander, 'do not touch me', 'utf8');

    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    rewriteManifest(out, (manifest) => {
      (manifest.storage.blobs as unknown as { path: string }[])[0]!.path = '../precious.txt';
    });

    await expect(restoreBackup({ from: out, into, force: true })).rejects.toThrow(BackupFormatError);

    expect(existsSync(bystander), 'the rollback deleted a file outside the target').toBe(true);
    expect(readFileSync(bystander, 'utf8')).toBe('do not touch me');
  });

  it('refuses an absolute path, a backslash and a lone dot as well as ..', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    const original = readFileSync(join(out, MANIFEST_FILE), 'utf8');

    for (const hostile of [
      '/etc/passwd',
      'C:\\Windows\\system32',
      'storage/./../../out',
      'storage//aa/bb/x',
      'storage/../secret',
      '',
    ]) {
      const manifest = JSON.parse(original) as BackupManifest;
      (manifest.storage.blobs as unknown as { path: string }[])[0]!.path = hostile;
      expect(() => parseManifest(`${JSON.stringify(manifest)}\n`, 'test'), hostile).toThrow(
        BackupFormatError,
      );
    }

    // And the check is not simply refusing everything: the real manifest still parses.
    expect(parseManifest(original, 'test').storage.blobs.length).toBeGreaterThan(0);
  });

  it('rejects a traversal in the database entry, not only in a blob', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });

    rewriteManifest(out, (manifest) => {
      (manifest.database as unknown as { path: string }).path = '../../library.sqlite';
    });

    const into = join(directory(), 'restored');
    await expect(restoreBackup({ from: out, into })).rejects.toThrow(/not a path inside the snapshot/u);
  });
});

describe('an incremental snapshot reads the live store (M2)', () => {
  it('fails on rot in the source even when the destination still holds a good copy', async () => {
    const { databaseFile, storageRoot, digests } = await libraryWithBlobs();
    const out = directory();

    const first = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    expect(first.blobsCopied).toBe(2);
    expect(first.corruptBlobs).toEqual([]);

    // Rot one live blob. The snapshot from a moment ago still holds the good bytes, which is
    // exactly the condition under which the old reuse branch never opened the source again.
    const rotted = digests[0] as string;
    truncateSync(join(storageRoot, ...blobPath(rotted).split('/').slice(1)), 3);

    await expect(
      createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out, force: true }),
    ).rejects.toThrow(/hashes to .*, not to its own name/u);

    const skipping = await createBackup({
      databaseUrl: databaseFile,
      storagePath: storageRoot,
      out,
      force: true,
      onCorruptBlob: 'skip',
    });
    expect(skipping.corruptBlobs.map((blob) => blob.expectedSha256)).toEqual([rotted]);
    expect(skipping.manifest.storage.blobs.map((blob) => blob.sha256)).not.toContain(rotted);
    // The rotted blob is not left standing in the snapshot from the previous run either: a backup
    // that quietly kept yesterday's copy of a file the manifest no longer names is not a snapshot.
    expect(existsSync(join(out, blobPath(rotted)))).toBe(false);
  });

  it('still reuses an unchanged blob rather than re-copying it', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();

    const first = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    expect(first.blobsCopied).toBe(2);
    expect(first.blobsReused).toBe(0);

    const second = await createBackup({
      databaseUrl: databaseFile,
      storagePath: storageRoot,
      out,
      force: true,
    });
    expect(second.blobsReused).toBe(2);
    expect(second.blobsCopied).toBe(0);
  });

  it('re-copies a blob that rotted at the destination', async () => {
    const { databaseFile, storageRoot, digests } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });

    const target = join(out, blobPath(digests[0] as string));
    writeFileSync(target, 'the backup rotted', 'utf8');

    const second = await createBackup({
      databaseUrl: databaseFile,
      storagePath: storageRoot,
      out,
      force: true,
    });
    expect(second.blobsCopied).toBe(1);
    expect(second.blobsReused).toBe(1);
    expect((await verifyBackup(out)).failures).toEqual([]);
  });
});

describe('a snapshot restores', () => {
  it('round-trips the database and the store, and verifies what it wrote', async () => {
    const { databaseFile, storageRoot, digests } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out, config: { a: 1 } });

    expect((await verifyBackup(out)).failures).toEqual([]);

    const into = join(directory(), 'restored');
    const restored = await restoreBackup({ from: out, into });

    expect(restored.integrityCheck).toBe('ok');
    expect(restored.blobsRestored).toBe(2);
    expect(existsSync(join(into, 'library.sqlite'))).toBe(true);
    for (const digest of digests) {
      expect(existsSync(join(into, blobPath(digest)))).toBe(true);
    }
    expect(existsSync(join(out, DATABASE_FILE))).toBe(true);
  });
});

/**
 * A snapshot's blob list is the index a restore reads, and its totals are a summary of that list.
 *
 * When the two disagree the report becomes a comparison of nothing against nothing: the reviewer's
 * `blobs: []` over a `blobCount: 5` made `verifyBackup` report zero failures and `restoreBackup`
 * complete with `blobsRestored: 0` into an empty store — a restore that "verified everything it
 * wrote", having written nothing. ADR-0021 §3: a check that cannot fail is decoration, and a
 * blocking set that can be emptied is the same defect one level up.
 */
describe('a snapshot cannot pass by holding nothing (ADR-0021)', () => {
  it('refuses a manifest whose blob list disagrees with its own count', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    const snapshot = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    expect(snapshot.manifest.storage.blobCount).toBeGreaterThan(0);

    rewriteManifest(out, (manifest) => {
      (manifest.storage as unknown as { blobs: unknown[] }).blobs = [];
    });

    await expect(verifyBackup(out)).rejects.toThrow(BackupFormatError);
    await expect(verifyBackup(out)).rejects.toThrow(/lists 0/u);
    await expect(restoreBackup({ from: out, into: directory(), force: true })).rejects.toThrow(
      /lists 0/u,
    );
  });

  it('refuses a manifest whose byte total disagrees with the blobs it lists', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });

    rewriteManifest(out, (manifest) => {
      (manifest.storage as unknown as { totalBytes: number }).totalBytes += 1;
    });

    await expect(verifyBackup(out)).rejects.toThrow(/come to /u);
  });

  it('fails the restore when fewer blobs were verified than the snapshot claims', async () => {
    // The floor under the loop, for a manifest that is self-consistent and still hides a blob:
    // aliasing the database entry onto a blob's path sends both through `targetFor` to the database
    // destination, so one listed blob is never restored as a blob while every total agrees.
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const workspace = directory();
    const out = join(workspace, 'snapshot');
    const into = join(workspace, 'restored');
    const snapshot = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    const victim = snapshot.manifest.storage.blobs[0]!;

    writeFileSync(join(out, DATABASE_FILE), readFileSync(join(out, victim.path)));
    rewriteManifest(out, (manifest) => {
      const database = manifest.database as unknown as { path: string; sha256: string; size: number };
      database.path = victim.path;
      database.sha256 = victim.sha256;
      database.size = victim.size;
    });

    await expect(restoreBackup({ from: out, into, force: true })).rejects.toThrow(
      /claims a store of \d+ blob\(s\)/u,
    );
    expect(existsSync(join(into, DATABASE_FILE)), 'a half-restored library was left behind').toBe(false);
  });

  it('counts the blobs it actually read, so a caller can compare that with the claim', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    const snapshot = await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });

    const verified = await verifyBackup(out);
    expect(verified.failures).toEqual([]);
    expect(verified.blobsChecked).toBe(snapshot.manifest.storage.blobCount);
  });
});

/**
 * A manifest is read whole into a string before `JSON.parse` sees a key, and it arrives on
 * removable media, so the read is over bytes a stranger chose (ADR-0022 §2).
 */
describe('the manifest read is bounded', () => {
  it('refuses a manifest larger than the ceiling, naming it', async () => {
    const { databaseFile, storageRoot } = await libraryWithBlobs();
    const out = directory();
    await createBackup({ databaseUrl: databaseFile, storagePath: storageRoot, out });
    const path = join(out, MANIFEST_FILE);
    const size = readFileSync(path, 'utf8').length;

    // Both bounds share the limit: the `stat` is the fast rejection over metadata, and the running
    // total over the stream is the one that holds when the file grows between the two calls. Only
    // the first can be driven from a static file, which is why the second is written as a running
    // total rather than as a second size comparison.
    await expect(readManifestFile(path)).resolves.toContain('"format"');
    await expect(readManifestFile(path, size - 1)).rejects.toThrow(BackupFormatError);
    await expect(readManifestFile(path, size - 1)).rejects.toThrow(/will not read more than/u);
    expect(MAX_MANIFEST_BYTES).toBe(256 * 1024 * 1024);
  });
});
