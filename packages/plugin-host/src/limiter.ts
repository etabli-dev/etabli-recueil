/**
 * The adaptive per-source rate limiter (CONCEPT §5.4).
 *
 * Metadata Mender used a fixed rate per source (spec/parity-zotero-plugins.md §1.6); this keeps
 * its spacing and its constants as the starting point and adds what CONCEPT §5.4 asks for:
 *
 * - requests to one source are spaced at least `1000 / rate` ms apart, with `concurrency` in flight;
 * - a 429 or 503 halves the rate (never below `minRate`) and honours `Retry-After` for the whole
 *   source, not just the request that saw it;
 * - every `recoverAfter` consecutive successes raise the rate by 10 %, never above the declared
 *   ceiling — the host never exceeds what the resolver says the source allows.
 */
export interface LimiterOptions {
  requestsPerSecond: number;
  concurrency?: number;
  minRate?: number;
  recoverAfter?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AdaptiveLimiter {
  readonly ceiling: number;
  private rate: number;
  private readonly concurrency: number;
  private readonly minRate: number;
  private readonly recoverAfter: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextStart = 0;
  private pausedUntil = 0;
  private inFlight = 0;
  private successes = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: LimiterOptions) {
    this.ceiling = options.requestsPerSecond;
    this.rate = options.requestsPerSecond;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.minRate = options.minRate ?? Math.min(options.requestsPerSecond, 0.1);
    this.recoverAfter = options.recoverAfter ?? 20;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get currentRate(): number {
    return this.rate;
  }

  async schedule<T>(work: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.inFlight += 1;
    try {
      const start = Math.max(this.now(), this.nextStart, this.pausedUntil);
      this.nextStart = start + 1000 / this.rate;
      const wait = start - this.now();
      if (wait > 0) await this.sleep(wait);
      return await work();
    } finally {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    }
  }

  /** Report a throttling answer from the source. */
  throttled(retryAfterMs: number | null): void {
    this.successes = 0;
    this.rate = Math.max(this.minRate, this.rate / 2);
    if (retryAfterMs !== null && retryAfterMs > 0) this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
  }

  succeeded(): void {
    this.successes += 1;
    if (this.successes >= this.recoverAfter) {
      this.successes = 0;
      this.rate = Math.min(this.ceiling, this.rate * 1.1);
    }
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export const parseRetryAfter = (value: string | null | undefined, now = Date.now()): number | null => {
  if (value === null || value === undefined || value.trim() === '') return null;
  if (/^\d+(\.\d+)?$/u.test(value.trim())) return Math.max(0, Number(value.trim()) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};
