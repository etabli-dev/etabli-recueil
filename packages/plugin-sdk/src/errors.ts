/**
 * The plugin error hierarchy (spec/hooks.md §3.2).
 *
 * Throwing anything else is legal but loses the metadata the host uses to decide what to do next,
 * and a bare `Error` is always treated as non-retryable.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

export interface PluginErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  /** Shown to the operator. Must not contain secrets. */
  userMessage?: string;
  detail?: JsonObject;
  cause?: unknown;
}

export class PluginError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly userMessage?: string;
  readonly detail?: JsonObject;

  constructor(code: string, message: string, options: PluginErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.userMessage !== undefined) this.userMessage = options.userMessage;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** Retryable; does not consume an attempt. */
export class RateLimitError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('rate_limited', message, { ...options, retryable: true });
  }
}

export class UpstreamUnavailableError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('upstream_unavailable', message, { ...options, retryable: true });
  }
}

/** Not retryable; usually return empty instead. */
export class NotFoundError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('not_found', message, { ...options, retryable: false });
  }
}

export class ValidationError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('validation', message, { ...options, retryable: false });
  }
}

/** Not retryable; always surfaced to the operator. */
export class IntegrityError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('integrity', message, { ...options, retryable: false });
  }
}

export class BudgetExceededError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('budget_exceeded', message, { ...options, retryable: false });
  }
}

export class PermissionDeniedError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('permission_denied', message, { ...options, retryable: false });
  }
}

/** Raised by the host, not the plugin. */
export class TimeoutError extends PluginError {
  constructor(message: string, options: PluginErrorOptions = {}) {
    super('timeout', message, { ...options, retryable: false });
  }
}
