/**
 * Retry with exponential backoff, for the two backends that talk to a machine they do not control.
 *
 * The local filesystem backend has no equivalent and needs none: an `EIO` from a local disk is not
 * a transient condition and retrying it just delays the bad news. A remote store is different —
 * a 503 during a Nextcloud cron run, a 500 from a Garage node mid-rebalance, a TCP reset from a
 * reverse proxy recycling a worker are all ordinary and all pass.
 *
 * What is deliberately **not** retried is as important as what is. A 4xx other than 429 and 423 is
 * the server saying the request itself is wrong; repeating it is noise. And nothing here retries a
 * request whose body has already been consumed — every call site streams from a spooled file and
 * opens a fresh read stream per attempt, because a retry that resends half a body is how a store
 * ends up with a blob that is not what its name says.
 */

export interface RetryPolicy {
  /** Total attempts, the first one included. 1 disables retrying. */
  attempts: number;
  /** Delay before the second attempt. Doubles from there. */
  baseDelayMs: number;
  /** Ceiling for a single delay. */
  maxDelayMs: number;
  /**
   * Spread the delay over `[0.5, 1] × delay`.
   *
   * Without it, twenty ingest workers that all met the same 503 come back in lockstep and meet it
   * again. On by default; the tests turn it off so a delay is a number and not a range.
   */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  jitter: true,
};

export const resolveRetryPolicy = (policy?: Partial<RetryPolicy>): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  ...policy,
});

/** What a caller learns about an attempt that failed, before the next one is made. */
export interface RetryAttempt {
  /** 1 for the first failure. */
  attempt: number;
  /** How long the retry loop is about to wait. */
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  policy: RetryPolicy;
  /** Which failures are worth repeating. Anything else is rethrown at once. */
  isRetryable: (error: unknown) => boolean;
  /**
   * A server-supplied wait, in milliseconds, taken from `Retry-After`.
   *
   * It wins over the computed backoff when it is longer, because a server that says "not before
   * 30s" means it — but it is still bounded by `maxDelayMs`. An unbounded, server-controlled sleep
   * inside an ingest worker is a way for a misconfigured proxy to stall a queue for an hour, and
   * the honest failure (give up, report the 503) is better than the silent one.
   */
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (attempt: RetryAttempt) => void;
  /** Injected by the tests so a backoff run does not actually take ten seconds. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** `Retry-After` is either delta-seconds or an HTTP-date. Both are in the wild. */
export const parseRetryAfter = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
};

export const backoffDelay = (attempt: number, policy: RetryPolicy): number => {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  if (!policy.jitter) return exponential;
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
};

/**
 * Run `operation`, retrying the failures `isRetryable` accepts.
 *
 * `operation` is given the attempt number so it can build a fresh request — a new read stream over
 * the spooled file, a new signed URL — rather than replay a consumed one.
 */
export const withRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const { policy, isRetryable } = options;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt >= Math.max(1, policy.attempts);
      if (isLast || !isRetryable(error)) throw error;

      const advertised = options.retryAfterMs?.(error);
      const delayMs = Math.min(
        policy.maxDelayMs,
        Math.max(backoffDelay(attempt, policy), advertised ?? 0),
      );
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError;
};
