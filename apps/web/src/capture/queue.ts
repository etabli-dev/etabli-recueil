/**
 * The capture queue (CONCEPT §7 Phase 8; `docs/platform-roadmap.md` §4.4–4.5).
 *
 * A phone captures where the network is worst, so a capture is written to the device first and
 * uploaded when it can be. The rules:
 *
 * - A capture is stored before anything is sent; closing the app loses nothing.
 * - A failure to reach the server (offline, timeout, 5xx, 408, 429) leaves the capture queued and
 *   counts the attempt; the next flush tries again.
 * - A refusal by the server (any other 4xx) is final for that capture: it stays in the queue with
 *   the server's reason, so the person can see why, and is never retried on its own.
 * - An upload that succeeded is removed, and its outcome is reported to the caller.
 *
 * The queue lives in the web layer so the browser, the PWA and both mobile shells share it; the
 * storage is IndexedDB in production and an in-memory store in tests.
 */
import { ApiError } from '../api/problem.js';
import type { IngestUploadResult } from '../api/ingestion.js';

export type CaptureKind = 'file' | 'isbn';
export type CaptureStatus = 'queued' | 'refused';

export interface Capture {
  id: string;
  kind: CaptureKind;
  createdAt: string;
  status: CaptureStatus;
  attempts: number;
  lastAttemptAt: string | null;
  /** The reason the server or the network gave last time. */
  lastError: string | null;
  /** How it arrived: `camera`, `scan`, `share`, `file`, `barcode`, `typed`. */
  origin: string;
  filename?: string;
  mediaType?: string;
  blob?: Blob;
  isbn?: string;
  note?: string;
}

export interface CaptureStore {
  all(): Promise<Capture[]>;
  put(capture: Capture): Promise<void>;
  delete(id: string): Promise<void>;
}

/** What the queue needs from the API client. */
export interface CaptureUploader {
  uploadForIngestion(file: Blob, fields: { filename: string; sourceKind?: string; title?: string }, signal?: AbortSignal): Promise<IngestUploadResult>;
  createItemFromIsbn(isbn: string): Promise<{ id: string }>;
}

export interface FlushReport {
  uploaded: { capture: Capture; outcome: string }[];
  refused: Capture[];
  /** Still queued because the server could not be reached. */
  deferred: Capture[];
}

const RETRYABLE = new Set([0, 408, 425, 429]);

/**
 * Whether an error means "try again later" rather than "the server said no". Only a failure to
 * reach the server is retryable; a local fault (a capture missing its bytes, say) is not, or one
 * broken capture would hold up every capture behind it.
 */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof ApiError) return RETRYABLE.has(error.problem.status) || error.problem.status >= 500;
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
};

/** 401 and 403: the token, not the capture, is the problem — stop and keep everything queued. */
const isAuthFailure = (error: unknown): boolean => error instanceof ApiError && (error.problem.status === 401 || error.problem.status === 403);

/** What `/ingestion/upload` answers when the library now holds the capture (or will, after review). */
const KEPT_OUTCOMES = new Set(['ingested', 'duplicate', 'review', 'container']);

/** How long one upload may take before the queue gives up on it for this pass. */
const UPLOAD_TIMEOUT_MS = 120_000;

const ISBN = /^(?:97[89])?\d{9}[\dX]$/u;

/**
 * Digits only, check digit verified, and always ISBN-13: an ISBN-10 becomes `978` plus its nine
 * digits with a new check digit, which is the form the server stores. Null when it is not an ISBN.
 * Exported for the test.
 */
export const normaliseIsbn = (raw: string): string | null => {
  const compact = raw.replace(/[\s-]/gu, '').toUpperCase();
  if (!ISBN.test(compact)) return null;
  const check13 = (twelve: string): number => (10 - ([...twelve].reduce((acc, char, index) => acc + Number(char) * (index % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
  if (compact.length === 10) {
    const sum = [...compact].reduce((acc, char, index) => acc + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    if (sum % 11 !== 0 || compact.slice(0, 9).includes('X')) return null;
    const twelve = `978${compact.slice(0, 9)}`;
    return `${twelve}${check13(twelve)}`;
  }
  if (compact.includes('X')) return null;
  return check13(compact.slice(0, 12)) === Number(compact[12]) ? compact : null;
};

const newCaptureId = (): string => `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export class CaptureQueue {
  private flushing: Promise<FlushReport> | null = null;

  constructor(
    private readonly store: CaptureStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<Capture[]> {
    return (await this.store.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addFile(blob: Blob, filename: string, origin: string, note?: string): Promise<Capture> {
    const capture: Capture = {
      id: newCaptureId(),
      kind: 'file',
      createdAt: this.now().toISOString(),
      status: 'queued',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      origin,
      filename,
      mediaType: blob.type === '' ? 'application/octet-stream' : blob.type,
      blob,
      ...(note === undefined ? {} : { note }),
    };
    await this.store.put(capture);
    return capture;
  }

  async addIsbn(raw: string, origin: string): Promise<Capture> {
    const isbn = normaliseIsbn(raw);
    if (isbn === null) throw new Error(`'${raw}' is not a valid ISBN.`);
    const capture: Capture = { id: newCaptureId(), kind: 'isbn', createdAt: this.now().toISOString(), status: 'queued', attempts: 0, lastAttemptAt: null, lastError: null, origin, isbn };
    await this.store.put(capture);
    return capture;
  }

  /** Put a refused capture back in the queue, after the person has fixed what the server objected to. */
  async retry(id: string): Promise<void> {
    const capture = (await this.store.all()).find((candidate) => candidate.id === id);
    if (capture === undefined) return;
    await this.store.put({ ...capture, status: 'queued', lastError: null });
  }

  async discard(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /**
   * Upload what is queued, oldest first. Concurrent calls share one pass, and the pass looks again
   * when it is done, so a capture added while it ran is not left waiting for the next trigger.
   */
  flush(uploader: CaptureUploader): Promise<FlushReport> {
    this.flushing ??= this.run(uploader).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(uploader: CaptureUploader): Promise<FlushReport> {
    const report: FlushReport = { uploaded: [], refused: [], deferred: [] };
    const tried = new Set<string>();
    for (;;) {
      const queued = (await this.list()).filter((capture) => capture.status === 'queued' && !tried.has(capture.id));
      if (queued.length === 0) return report;
      for (const [position, capture] of queued.entries()) {
        tried.add(capture.id);
        const attempted = { ...capture, attempts: capture.attempts + 1, lastAttemptAt: this.now().toISOString() };
        // A capture discarded while its upload was under way must not be written back.
        const keep = async (row: Capture): Promise<void> => {
          if ((await this.store.all()).some((candidate) => candidate.id === row.id)) await this.store.put(row);
        };
        try {
          let outcome: string;
          if (capture.kind === 'file') {
            if (capture.blob === undefined) throw new Error('This capture lost its file on the device; capture it again.');
            const result = await uploader.uploadForIngestion(
              capture.blob,
              { filename: capture.filename ?? 'capture', sourceKind: 'mobile', ...(capture.note === undefined ? {} : { title: capture.note }) },
              AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
            );
            outcome = result.outcome;
            if (!KEPT_OUTCOMES.has(outcome)) {
              // The server answered but did not keep the file: the device's copy is the only one.
              const reason = result.detail === '' ? `The server did not keep the file (${outcome}).` : result.detail;
              if (outcome === 'failed') {
                await keep({ ...attempted, lastError: reason });
                report.deferred.push({ ...attempted, lastError: reason });
              } else {
                const refused = { ...attempted, status: 'refused' as const, lastError: reason };
                await keep(refused);
                report.refused.push(refused);
              }
              continue;
            }
          } else {
            await uploader.createItemFromIsbn(capture.isbn!);
            outcome = 'created';
          }
          await this.store.delete(capture.id);
          report.uploaded.push({ capture: attempted, outcome });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isRetryable(error) || isAuthFailure(error)) {
            await keep({ ...attempted, lastError: message });
            // The server is unreachable or refuses the token: the rest would fail the same way.
            report.deferred.push({ ...attempted, lastError: message }, ...queued.slice(position + 1));
            return report;
          }
          const refused = { ...attempted, status: 'refused' as const, lastError: message };
          await keep(refused);
          report.refused.push(refused);
        }
      }
    }
  }
}

export const memoryCaptureStore = (): CaptureStore => {
  const rows = new Map<string, Capture>();
  return {
    all: async () => [...rows.values()].map((row) => ({ ...row })),
    put: async (capture) => {
      rows.set(capture.id, { ...capture });
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
};

/** IndexedDB, which keeps Blobs as they are; one object store keyed by id. */
export const indexedDbCaptureStore = (name = 'recueil-captures', factory: IDBFactory = indexedDB): CaptureStore => {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('captures')) request.result.createObjectStore('captures', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open'));
    });
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('captures', mode);
        const request = body(tx.objectStore('captures'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  };
  return {
    all: () => run('readonly', (store) => store.getAll() as IDBRequest<Capture[]>),
    put: async (capture) => {
      await run('readwrite', (store) => store.put(capture));
    },
    delete: async (id) => {
      await run('readwrite', (store) => store.delete(id));
    },
  };
};
