/**
 * The errors the Paperless client raises.
 *
 * Every one of them carries the request that produced it, minus the credential: the token appears
 * in exactly one place in this package (the `Authorization` header built in `client.ts`) and must
 * never reach a message, a log line or a report.
 */

export interface PaperlessErrorContext {
  method: string;
  /** The URL with any userinfo and query credential removed. */
  url: string;
  status?: number;
  /** The first 500 characters of the body, for a server that explained itself. */
  body?: string;
}

export class PaperlessError extends Error {
  readonly context: PaperlessErrorContext;

  constructor(message: string, context: PaperlessErrorContext) {
    super(message);
    this.name = 'PaperlessError';
    this.context = context;
  }
}

/** 401 or 403: the token is wrong, missing, or not permitted to see what was asked for. */
export class PaperlessAuthError extends PaperlessError {
  constructor(context: PaperlessErrorContext) {
    super(
      context.status === 403
        ? 'Paperless-ngx refused the request (403). The token is valid but lacks permission for ' +
            'this object; a migration needs a token belonging to a superuser or to the owner of ' +
            'every document.'
        : 'Paperless-ngx rejected the token (401). Check `token` and that the server has ' +
            '`rest_framework.authentication.TokenAuthentication` enabled.',
      context,
    );
    this.name = 'PaperlessAuthError';
  }
}

/**
 * 406: the server does not allow the API version this client asked for.
 *
 * Worth its own class because the remedy is specific and because guessing another version would
 * mean silently importing through an envelope this package has not been written against.
 */
export class PaperlessApiVersionError extends PaperlessError {
  readonly requested: string;

  constructor(requested: string, context: PaperlessErrorContext) {
    super(
      `Paperless-ngx does not allow API version ${requested} (406). This client understands the ` +
        'envelope of versions 9 and 10; a server older than that needs an older importer, not a ' +
        'guess.',
      context,
    );
    this.name = 'PaperlessApiVersionError';
    this.requested = requested;
  }
}

/** A 404 for something the importer expected to be there. */
export class PaperlessNotFoundError extends PaperlessError {
  constructor(what: string, context: PaperlessErrorContext) {
    super(`Paperless-ngx has no ${what} (404).`, context);
    this.name = 'PaperlessNotFoundError';
  }
}

/** The server answered, but not with what the endpoint is documented to answer with. */
export class PaperlessProtocolError extends PaperlessError {
  constructor(message: string, context: PaperlessErrorContext) {
    super(message, context);
    this.name = 'PaperlessProtocolError';
  }
}

/**
 * A `next` link, a redirect or a download URL that points somewhere other than the configured
 * server.
 *
 * A pagination link is a URL the server composes out of the request it saw, so anything able to
 * spoof `Host` or an `X-Forwarded-*` header can aim it elsewhere — at which point a client that
 * follows it blindly posts the migration token to a third party. This client refuses instead.
 */
export class PaperlessUntrustedUrlError extends PaperlessError {
  readonly untrusted: string;

  constructor(untrusted: string, context: PaperlessErrorContext) {
    super(
      `Paperless-ngx returned a link outside the configured server (${untrusted}). Refusing to ` +
        'follow it: the credential travels with every request, and a link is not a place to put ' +
        'trust.',
      context,
    );
    this.name = 'PaperlessUntrustedUrlError';
    this.untrusted = untrusted;
  }
}

/** Strip anything credential-shaped out of a URL before it goes anywhere a person can read. */
export const redactUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/token|key|secret|password|signature/iu.test(key)) url.searchParams.set(key, 'REDACTED');
  }
  return url.toString();
};
