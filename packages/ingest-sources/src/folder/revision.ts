/**
 * What "the same file" means to a watched folder, and how a stale claim about it is caught.
 *
 * A candidate is offered under a `revision`, and every later operation on the path it names — the
 * read, and above all the delete or the move — is only correct if the file at that path is still
 * the file the revision described. `spec/hardening-2026-08.md` H1 exists because it was not:
 * `acknowledge` deleted whatever happened to be at the path, and a file that replaced the original
 * between the pipeline run and the acknowledgement was destroyed having never been read.
 *
 * Three facts make up the revision, and each catches something the others do not:
 *
 *   - **size**, which changes for almost every rewrite;
 *   - **mtime**, truncated to the millisecond, which changes for a rewrite of exactly the same
 *     length (`dd conv=notrunc`) that leaves the size alone;
 *   - **inode**, which changes for the write-then-rename every well-behaved producer uses, and
 *     which is the only one of the three a writer can preserve neither by accident nor on purpose
 *     while replacing the contents.
 *
 * The inode is carried as `dev/ino` because an inode number is only unique within a filesystem, and
 * a watched root may have a mount under it.
 *
 * **The comparison is deliberately tolerant of a shorter revision string.** Revisions written by an
 * earlier version of Recueil have two fields rather than three, and those rows are replayed through
 * `SourceRunner.recover()` after an upgrade. A two-field revision is compared on the two fields it
 * has, and the missing inode is reported as absent rather than treated as a mismatch — refusing
 * every pending acknowledgement across an upgrade would be a different way to lose the operator's
 * work.
 */
import type { Stats } from 'node:fs';

/** The three facts that together identify the file a candidate was offered under. */
export interface FileRevision {
  /** Truncated to the millisecond, which is the resolution the revision string carries. */
  mtimeMs: number;
  byteSize: number;
  /** `dev/ino`. Null only in a revision string written before this field existed. */
  inode: string | null;
}

/** The revision of a file as it is right now, from a `stat` of it. */
export const fileRevision = (info: Pick<Stats, 'mtimeMs' | 'size' | 'dev' | 'ino'>): FileRevision => ({
  mtimeMs: Math.trunc(info.mtimeMs),
  byteSize: info.size,
  inode: `${String(info.dev)}/${String(info.ino)}`,
});

export const formatRevision = (revision: FileRevision): string => {
  const head = `${String(Math.trunc(revision.mtimeMs))}:${String(revision.byteSize)}`;
  return revision.inode === null ? head : `${head}:${revision.inode}`;
};

/** Read a revision string back. Null when it is not one, which is itself a refusal-worthy answer. */
export const parseRevision = (value: string): FileRevision | null => {
  const parts = value.split(':');
  if (parts.length < 2) return null;
  const mtimeMs = Number(parts[0]);
  const byteSize = Number(parts[1]);
  if (!Number.isFinite(mtimeMs) || !Number.isInteger(byteSize)) return null;
  const inode = parts.length > 2 ? parts.slice(2).join(':') : null;
  return { mtimeMs: Math.trunc(mtimeMs), byteSize, inode: inode === '' ? null : inode };
};

/**
 * Compare the revision a candidate was offered under with the file on disk now.
 *
 * Null when they agree. When they do not, a sentence naming every field that differs — the string
 * goes into a refusal, a log line and a review-queue entry, all of which a person reads.
 */
export const revisionDrift = (offered: string | undefined, now: FileRevision): string | null => {
  if (offered === undefined || offered === '') return null;

  const was = parseRevision(offered);
  if (was === null) {
    return `the revision it was offered under ('${offered}') cannot be read as one`;
  }

  const differences: string[] = [];
  if (was.byteSize !== now.byteSize) {
    differences.push(`${String(was.byteSize)} bytes then, ${String(now.byteSize)} now`);
  }
  if (was.mtimeMs !== now.mtimeMs) {
    differences.push(
      `last written ${new Date(was.mtimeMs).toISOString()} then, ` +
        `${new Date(now.mtimeMs).toISOString()} now`,
    );
  }
  if (was.inode !== null && now.inode !== null && was.inode !== now.inode) {
    differences.push(`a different file altogether: inode ${was.inode} then, ${now.inode} now`);
  }
  return differences.length === 0 ? null : differences.join('; ');
};
