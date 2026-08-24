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
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

  private async ensureRoot(): Promise<string> {
    if (this.root === null) {
      this.root = await mkdtemp(join(this.configuredRoot ?? tmpdir(), 'recueil-ingest-'));
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
      return entries.length === 0;
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
}
