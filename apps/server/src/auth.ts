/**
 * Authentication, scope enforcement and audit attribution.
 *
 * Three things happen to every request that reaches `/api/v1`, in this order.
 *
 * 1. **Identify.** A `Bearer` token in `Authorization`, or — on the feed endpoints only — a `token`
 *    query parameter, is verified against `api_tokens` (`tokens.ts`). A request with no credential
 *    at all is either refused (`RECUEIL_REQUIRE_AUTH=true`) or admitted as the single local account
 *    with full scopes, which is what makes a fresh `recueil serve` on a laptop usable.
 * 2. **Authorise.** Each route declares the scope it needs in `config.scope`; the `preHandler` here
 *    checks it. Declaring the scope on the route rather than checking it inside the handler is the
 *    point: a handler that forgets to check is a hole, whereas a route that forgets to declare
 *    fails the test in `test/auth.test.ts` that walks the route table.
 * 3. **Attribute.** `request.actor` is built once and threaded into every service call, so the
 *    `audit_log` row for a write through a token carries `actor_type = 'token'` and
 *    `actor_token_id` (AL2, AL3), along with the request id, the route, the client address and the
 *    user agent (§6.5). P4 is about derived facts carrying their source; this is the same idea one
 *    level up — every mutation carries who asked for it.
 *
 * The query-parameter credential deserves its own note. CONCEPT.md §5.11 requires
 * `.bib` endpoints "reachable with a scoped token in the URL so Overleaf and Quarto can fetch
 * them", and neither of those tools can set a header. A token in a URL is a token in a browser
 * history, a proxy log and a `_quarto.yml` in version control, so it is accepted **only** on routes
 * that opt in with `config.allowQueryToken`, and invariant A2 (`tokens.ts`) stops such a token from
 * ever holding a write scope.
 */
import { userActor } from '@recueil/core';
import type { Actor } from '@recueil/core';
import fp from 'fastify-plugin';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';

import { scopeRequired, unauthenticated } from './problem.js';
import { ADMIN_SCOPE, hasScope } from './scopes.js';
import type { TokenPrincipal, TokenService } from './tokens.js';

/** The query parameter a feed URL carries its credential in (CONCEPT.md §5.11). */
export const TOKEN_QUERY_PARAM = 'token';

/** What the server knows about the caller of one request. */
export interface RequestPrincipal {
  /** The verified token, when one was presented. */
  readonly token: TokenPrincipal['token'] | null;
  readonly userId: string;
  readonly scopes: readonly string[];
  /** True when no credential was presented and the server is not requiring one. */
  readonly anonymous: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified caller. Set by the `onRequest` hook for every route. */
    principal: RequestPrincipal;
    /** The audit actor for this request (§6.5). Pass it to every service call. */
    actor: Actor;
  }

  interface FastifyContextConfig {
    /** The scope this route requires. Absent means the route is public. */
    scope?: string;
    /** Accept the credential from the `token` query parameter as well as the header. */
    allowQueryToken?: boolean;
    /** Skip authentication entirely: `/health`, `/openapi.json`, the connector handshake. */
    public?: boolean;
  }
}

export interface AuthPluginOptions {
  readonly tokens: TokenService;
  /** The single local account a credential-free request acts as. */
  readonly localUserId: string;
  /** Refuse a request with no credential (`RECUEIL_REQUIRE_AUTH`). */
  readonly requireAuth: boolean;
}

/** The bearer token in `Authorization`, if there is one and it is well-formed. */
const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
};

const queryToken = (request: FastifyRequest): string | null => {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[TOKEN_QUERY_PARAM];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * Build the audit actor.
 *
 * `type` is `token` when a credential was presented and `user` when it was not, which is exactly
 * the distinction `actorColumns` (`@recueil/core`) turns into `actor_token_id` versus
 * `actor_user_id` under AL2.
 */
export const actorForRequest = (request: FastifyRequest): Actor => {
  const { principal } = request;
  const context: Partial<Actor> = {
    requestId: String(request.id),
    apiRoute: `${request.method} ${request.routeOptions.url ?? request.url}`,
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };

  if (principal.token !== null) {
    return {
      type: 'token',
      tokenId: principal.token.id,
      userId: principal.userId,
      ...context,
    };
  }

  return userActor(principal.userId, context);
};

const plugin: FastifyPluginCallback<AuthPluginOptions> = (app, options, done) => {
  const { tokens, localUserId, requireAuth } = options;

  // Declared up front so that every request object has the same hidden class and so that a
  // handler reached before the hook — which cannot happen, but would be a silent `undefined` if it
  // did — is a type error rather than a mystery.
  app.decorateRequest('principal', null as unknown as RequestPrincipal);
  app.decorateRequest('actor', null as unknown as Actor);

  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config;
    const isPublic = config.public === true;

    const presented =
      bearerToken(request) ?? (config.allowQueryToken === true ? queryToken(request) : null);

    if (presented !== null) {
      const verified = tokens.verify(presented);
      if (verified === null) {
        // Logged at `warn`, never with the secret: a rejected credential in a log file is still a
        // credential someone may try elsewhere.
        request.log.warn({ route: request.url }, 'rejected an API token');
        throw unauthenticated('The token is not valid, has been revoked, or has expired.');
      }
      request.principal = {
        token: verified.token,
        userId: verified.user.id,
        scopes: verified.scopes,
        anonymous: false,
      };
      request.actor = actorForRequest(request);
      return;
    }

    if (requireAuth && !isPublic) {
      throw unauthenticated(
        'This server requires a token. Send `Authorization: Bearer <token>`, or mint one with ' +
          '`recueil token create`.',
      );
    }

    request.principal = {
      token: null,
      userId: localUserId,
      // The local account is the owner of the library; withholding scopes from it would only
      // make the single-user default harder to use without making anything safer.
      scopes: [ADMIN_SCOPE],
      anonymous: true,
    };
    request.actor = actorForRequest(request);
    void reply;
  });

  app.addHook('preHandler', async (request) => {
    const required = request.routeOptions.config.scope;
    if (required === undefined) return;
    if (hasScope(request.principal.scopes, required)) return;
    throw scopeRequired(required);
  });

  done();
};

/**
 * Registered with `fastify-plugin` so the hooks apply to the whole instance rather than only to
 * routes registered inside this plugin's own encapsulation context.
 */
export const authPlugin = fp(plugin, { name: 'recueil-auth' });
