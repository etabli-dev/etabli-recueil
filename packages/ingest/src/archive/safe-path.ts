/**
 * Archive member names are hostile input.
 *
 * A name inside a zip is a string an attacker chose. It can be absolute (`/etc/cron.d/x`), it can
 * climb (`../../.ssh/authorized_keys`), it can use the other separator (`..\\..\\x`), it can be a
 * Windows drive or UNC path (`C:\\x`, `\\\\host\\share\\x`), it can carry a NUL to truncate a
 * syscall's view of it, and on a case-insensitive filesystem it can differ from a sibling only by
 * case. Every one of those is a way to write outside the extraction root, and Phase 1's review
 * found the same class of bug in the backup restorer: a manifest path validated only as "is a
 * string" both read outside the snapshot and wrote outside the target.
 *
 * So this module does not sanitise. It **resolves and then checks**, which is the only version of
 * the test that is not defeated by the next encoding trick: build the candidate path, resolve it
 * against the root, and require the result to be the root or to sit under the root plus a
 * separator. A name that fails is refused by name, and the archive it came from is refused with it
 * — an archive containing a traversal entry is not an archive with one bad file, it is an archive
 * built to escape, and extracting the rest of it anyway would be a strange thing to do.
 */
import { isAbsolute, resolve, sep } from 'node:path';

import { UnsafeArchivePathError } from '../errors.js';

export interface SafeMemberPath {
  /** The member's own name, as recorded in the archive. Kept for provenance, never for I/O. */
  entryName: string;
  /** The name with separators normalised, relative, safe to join. */
  relativePath: string;
  /** The absolute path under the extraction root. */
  absolutePath: string;
}

const WINDOWS_DRIVE = /^[a-z]:/iu;

/**
 * Resolve one member name under `root`, or throw.
 *
 * `root` must already be an absolute, real path — the caller owns the scratch directory, so it is.
 */
export const resolveMemberPath = (root: string, entryName: string): SafeMemberPath => {
  if (entryName.length === 0) throw new UnsafeArchivePathError(entryName, 'the name is empty');
  if (entryName.includes('\0')) {
    throw new UnsafeArchivePathError(entryName, 'the name contains a NUL byte');
  }

  // Backslash is a path separator on Windows and a legal filename character on POSIX. Treating it
  // as a separator everywhere is the conservative reading: it can only ever refuse more.
  const normalised = entryName.replace(/\\/gu, '/');

  if (normalised.startsWith('//')) {
    throw new UnsafeArchivePathError(entryName, 'the name is a UNC path');
  }
  if (WINDOWS_DRIVE.test(normalised)) {
    throw new UnsafeArchivePathError(entryName, 'the name carries a drive letter');
  }
  if (normalised.startsWith('/') || isAbsolute(normalised)) {
    throw new UnsafeArchivePathError(entryName, 'the name is absolute');
  }

  const segments = normalised.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new UnsafeArchivePathError(entryName, "the name contains a '..' segment");
  }
  if (segments.length === 0) {
    throw new UnsafeArchivePathError(entryName, 'the name resolves to the root itself');
  }

  const relativePath = segments.join('/');
  const absolutePath = resolve(root, ...segments);

  // The belt to the braces above. Refusing `..` by inspection is not enough on its own, because
  // inspection has to anticipate every encoding; comparing the resolved result to the root does
  // not have to anticipate anything.
  if (!isInside(root, absolutePath)) {
    throw new UnsafeArchivePathError(entryName, `it resolves to '${absolutePath}', outside the root`);
  }

  return { entryName, relativePath, absolutePath };
};

/** True when `candidate` is `root` or sits beneath it. Pure string comparison over resolved paths. */
export const isInside = (root: string, candidate: string): boolean => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolvedCandidate.startsWith(prefix);
};
