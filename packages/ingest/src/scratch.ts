/**
 * Scratch space.
 *
 * CONCEPT §5.3 says it in one clause: "scratch space for archive extraction is cleaned after
 * hashing". The clause is doing more work than it looks. It means the scratch directory is not a
 * cache, not a staging area and not somewhere a later stage may reach back into — once the members
 * of an archive have been hashed and handed to the content store, the bytes on disk are redundant,
 * and a pipeline that leaves them behind fills a disk one import at a time.
 *
 * "Even on failure" is the other half, and it is the half that gets forgotten. Every scratch
 * directory here is created through `withScratch`, which disposes in a `finally`, so a throw from
 * anywhere inside the extraction still leaves nothing behind. `ScratchManager.isEmpty()` exists so
 * a test can assert that rather than trust it.
 *
 * ## The two things a `finally` cannot do
 *
 * A `finally` does not run after `SIGKILL`, and it cannot create a directory that was never there.
 * Both were open findings, and both are answered here rather than left to the operator.
 *
 * **The configured root is created.** `config.ts` says `scratchRoot` "defaults to the OS temporary
 * directory", which reads as though any path will do; `mkdtemp` disagrees, and an operator who
 * points it at a directory that does not exist yet — a fresh deployment, a tmpfs path, a
 * subdirectory of the data volume — got `ENOENT` on the first archive and on every archive
 * afterwards, surfacing as an `archive_unreadable` review entry proposing a retry that can never
 * succeed. Zip and `.eml` ingestion is silently dead for that deployment. So the root is created,
 * once, with the rest of its path.
 *
 * **Abandoned roots are swept.** A hard kill leaks one `recueil-ingest-XXXXXX` directory per
 * crashed run, each with a fresh random name, so the "one place to look" this class promised was a
 * growing pile of places. `sweep()` is what reclaims them, and the question it has to answer is
 * which directories are *abandoned* rather than *in use* — a sweep that cannot tell the difference
 * deletes a concurrent run's members while it is hashing them. It is answered by identity and not
 * by metadata: every root carries `OWNER_FILE`, naming the process that made it, and a root is
 * removed only when that process is demonstrably gone from this host. Every ambiguity resolves
 * towards keeping: an unreadable marker, a marker from another host, a pid that still answers,
 * a directory younger than the grace period. Deleting a live run's scratch would be losing a file,
 * and P1 outranks a tidy disk.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The prefix every run's scratch root is created with. The sweep will touch nothing else. */
export const SCRATCH_ROOT_PREFIX = 'recueil-ingest-';

/** Names the process that owns a scratch root, so a sweep can tell abandoned from in use. */
const OWNER_FILE = '.recueil-run.json';

interface ScratchOwner {
  pid: number;
  hostname: string;
  startedAt: string;
}

/** One temporary directory, owned by one archive extraction. */
export class ScratchSpace {
  private disposed = false;

  private constructor(
    readonly path: string,
    private readonly onDispose: (space: ScratchSpace) => void,
  ) {}

  static async create(
    root: string,
    prefix: string,
    onDispose: (space: ScratchSpace) => void = () => {},
  ): Promise<ScratchSpace> {
    const path = await mkdtemp(join(root, prefix));
    return new ScratchSpace(path, onDispose);
  }

  /** A path inside this scratch directory. The name is not trusted; see `archive/safe-path.ts`. */
  resolve(...segments: string[]): string {
    return resolve(this.path, ...segments);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Remove the directory and everything in it. Idempotent, so a `finally` may always call it. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose(this);
    await rm(this.path, { recursive: true, force: true });
  }
}

/** What one sweep did. Returned rather than logged, so a caller decides what to say about it. */
export interface ScratchSweepReport {
  /** The directory that was swept. */
  root: string;
  /** Abandoned roots removed, by absolute path. */
  removed: string[];
  /** Roots left alone, with the reason. A sweep that keeps something says why. */
  kept: Array<{ path: string; reason: string }>;
  /** Roots that could not be removed, with the error. Never thrown: a sweep is best-effort. */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * How old an unmarked root must be before a sweep will reclaim it.
 *
 * A root exists for the moment between `mkdtemp` and the owner file being written, so a sweep
 * running in that window would see a directory it cannot attribute. An hour is far longer than
 * that window and far shorter than the time it takes a leaked directory to matter.
 */
export const DEFAULT_SWEEP_GRACE_MS = 60 * 60_000;

/**
 * The pipeline's scratch root: one directory per run, holding one directory per extraction.
 *
 * Per run rather than per archive so that an operator can point `scratchRoot` at a fast disk and
 * see, in one place, whether a crashed run left anything behind. `outstanding` is how the run
 * report tells the truth about that instead of asserting it.
 */
export class ScratchManager {
  private readonly live = new Set<ScratchSpace>();
  private root: string | null = null;

  constructor(private readonly configuredRoot?: string) {}

  /** Where roots are made: the configured directory, or the OS temporary one. */
  get baseDirectory(): string {
    return this.configuredRoot ?? tmpdir();
  }

  private async ensureRoot(): Promise<string> {
    if (this.root === null) {
      // `mkdtemp` does not create the parent. An operator pointing `scratchRoot` at a path that
      // does not exist yet is the ordinary case on a fresh deployment, not a misconfiguration.
      await mkdir(this.baseDirectory, { recursive: true });
      const root = await mkdtemp(join(this.baseDirectory, SCRATCH_ROOT_PREFIX));
      const owner: ScratchOwner = {
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      };
      // Written before the root is handed out, so a sweep never sees a directory this process is
      // already writing into without also seeing who owns it.
      await writeFile(join(root, OWNER_FILE), JSON.stringify(owner), 'utf8');
      this.root = root;
    }
    return this.root;
  }

  /** The run's scratch root, or null when no scratch has been needed yet. */
  get rootPath(): string | null {
    return this.root;
  }

  /** How many scratch directories are still open. Zero once every extraction has finished. */
  get outstanding(): number {
    return this.live.size;
  }

  /**
   * Run `body` with a scratch directory, and dispose of it whatever happens.
   *
   * The only way to obtain a `ScratchSpace` from the manager, precisely so that no caller can
   * forget the `finally`.
   */
  async with<T>(prefix: string, body: (space: ScratchSpace) => Promise<T>): Promise<T> {
    const root = await this.ensureRoot();
    const space = await ScratchSpace.create(root, prefix, (s) => this.live.delete(s));
    this.live.add(space);
    try {
      return await body(space);
    } finally {
      await space.dispose();
    }
  }

  /** Nothing left on disk under the run's scratch root. What the "scratch is empty" test asks. */
  async isEmpty(): Promise<boolean> {
    if (this.root === null) return true;
    try {
      const entries = await readdir(this.root);
      // The owner file is this class's own bookkeeping, not a leftover of the run.
      return entries.filter((entry) => entry !== OWNER_FILE).length === 0;
    } catch {
      // The root is gone, which is emptier than empty.
      return true;
    }
  }

  /** Remove the run's scratch root. Called from the run's `finally`. */
  async dispose(): Promise<void> {
    for (const space of [...this.live]) await space.dispose();
    if (this.root !== null) {
      await rm(this.root, { recursive: true, force: true });
      this.root = null;
    }
  }

  /** Sweep this manager's base directory. See `sweepAbandonedScratch`. */
  async sweep(options: { graceMs?: number } = {}): Promise<ScratchSweepReport> {
    return sweepAbandonedScratch(this.baseDirectory, options);
  }
}

/**
 * Reclaim scratch roots left behind by runs that are no longer running.
 *
 * Called once per pipeline before its first run, and exported so that a server's start-up can call
 * it too. It is best-effort by construction: it never throws, and every case it cannot decide is
 * decided in favour of keeping the directory.
 *
 * The check is over **identity, not metadata**. A root is removed only when its owner file names
 * this host and a process that no longer exists — not because it looks old, not because it is
 * empty. `process.kill(pid, 0)` is the question "does this pid exist", and its three answers are
 * all handled: it returns for a live process (keep), throws `ESRCH` for a dead one (remove) and
 * throws `EPERM` for one owned by another user (keep — something is running under that pid).
 */
export const sweepAbandonedScratch = async (
  base: string,
  options: { graceMs?: number } = {},
): Promise<ScratchSweepReport> => {
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const report: ScratchSweepReport = { root: base, removed: [], kept: [], failed: [] };
  const here = hostname();

  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    // No base directory yet is nothing to sweep, which is the ordinary case on a first run.
    return report;
  }

  for (const name of entries) {
    // Only ever our own naming, and only ever one level down. The path is joined here rather than
    // taken from anywhere, so it cannot address anything outside `base`.
    if (!name.startsWith(SCRATCH_ROOT_PREFIX)) continue;
    const path = join(base, name);

    let info;
    try {
      // `lstat`, not `stat`: a symbolic link named like a scratch root is not a scratch root, and
      // following it would make this sweep delete whatever it points at.
      info = await lstat(path);
    } catch (error) {
      report.failed.push({ path, reason: describe(error) });
      continue;
    }
    if (!info.isDirectory()) {
      report.kept.push({ path, reason: 'it is not a directory' });
      continue;
    }

    const owner = await readOwner(path);
    if (owner === null) {
      const ageMs = Date.now() - info.mtimeMs;
      if (ageMs < graceMs) {
        report.kept.push({
          path,
          reason: `it carries no owner file and is only ${Math.round(ageMs / 1000)}s old, which is inside the grace period`,
        });
        continue;
      }
    } else if (owner.hostname !== here) {
      report.kept.push({ path, reason: `it belongs to '${owner.hostname}', not to this host` });
      continue;
    } else if (isRunning(owner.pid)) {
      report.kept.push({ path, reason: `process ${String(owner.pid)} is still running` });
      continue;
    }

    try {
      await rm(path, { recursive: true, force: true });
      report.removed.push(path);
    } catch (error) {
      report.failed.push({ path, reason: describe(error) });
    }
  }

  return report;
};

const readOwner = async (root: string): Promise<ScratchOwner | null> => {
  try {
    const raw = await readFile(join(root, OWNER_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, hostname: host, startedAt } = parsed as Partial<ScratchOwner>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof host !== 'string' || host.length === 0) return null;
    return { pid, hostname: host, startedAt: typeof startedAt === 'string' ? startedAt : '' };
  } catch {
    return null;
  }
};

/** Does a process with this pid exist on this host? Every uncertain answer is "yes". */
const isRunning = (pid: number): boolean => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `ESRCH` is "no such process". Anything else — `EPERM` for a process owned by another user,
    // an unexpected errno — means something is there, or that we cannot tell, and both keep it.
    return (error as { code?: unknown }).code !== 'ESRCH';
  }
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
