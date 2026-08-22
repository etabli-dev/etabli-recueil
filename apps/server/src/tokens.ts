/**
 * API tokens: minting, hashing at rest, and verification (`spec/data-model.md` §3.2).
 *
 * The whole security property of this file is one sentence from §3.2: "the secret itself is shown
 * once and never stored". What is stored is the SHA-256 of the secret and its first twelve
 * characters in clear — the prefix exists so that verification is one indexed lookup rather than a
 * scan-and-compare over every token, and so that a token list can identify a credential without
 * being able to reproduce it.
 *
 * SHA-256 rather than argon2id, and that is a deliberate difference from `users.password_hash`. A
 * password is low-entropy and chosen by a person, so it needs a slow hash to survive an offline
 * attack on the database. A token here is 256 bits from `randomBytes`, so a slow hash buys nothing
 * against brute force and costs a KDF on every single request. §3.2 specifies SHA-256 for exactly
 * this reason.
 *
 * Three further rules, each from the invariants:
 *
 * - **A1** decides usability: not revoked, not expired, and the owning user active.
 * - **A2** keeps a `.bib` feed honest: a `bib_feed` token may hold no write scope, because a
 *   credential that lives in an Overleaf URL is a credential that has been published.
 * - **A3** means revocation is a timestamp, never a delete: `audit_log.actor_token_id` has to keep
 *   resolving for as long as the log does (P5).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  newId,
  nowTimestamp,
  schema,
  toTimestamp,
} from '@recueil/core';
import type { Actor, AuditService, RecueilDatabase } from '@recueil/core';
import { and, desc, eq } from 'drizzle-orm';

import { ADMIN_SCOPE, isGrantableScope, isReadOnly } from './scopes.js';

/** The clients a token may be issued to (`api_tokens.client`, a closed vocabulary). */
export const TOKEN_CLIENTS = schema.TOKEN_CLIENTS;

export type TokenClient = (typeof TOKEN_CLIENTS)[number];

/**
 * The human-visible prefix of every secret.
 *
 * `rcu_` so that a leaked token is greppable — secret scanners key off exactly this kind of marker,
 * and a token that cannot be recognised in a paste cannot be revoked by anyone who finds it.
 */
export const TOKEN_SECRET_PREFIX = 'rcu_';

/** Characters of the secret kept in clear, as `token_prefix` (§3.2). */
export const TOKEN_PREFIX_LENGTH = 12;

/** Bytes of entropy behind the secret. 256 bits; the encoding is base64url, so 43 characters. */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * How stale `last_used_at` may get.
 *
 * §3.2: "written at most once per minute per token to avoid a write per request". A token used by
 * a polling client would otherwise turn every read into a write, which on SQLite means every read
 * takes the write lock.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

export const hashTokenSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/** Compare two hex digests without leaking their difference through timing. */
const digestsMatch = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface CreateTokenInput {
  name: string;
  client?: TokenClient;
  scopes?: readonly string[];
  /** ISO-8601; `null` or absent means no expiry. */
  expiresAt?: string | null;
  note?: string | null;
  /** The account the token acts as. Defaults to the actor's, then to the single local account. */
  userId?: string;
}

export interface CreatedToken {
  row: schema.ApiTokenRow;
  /**
   * The secret, in the clear, for the only time it will ever exist outside the client. Nothing in
   * the server retains it: it is returned by value and the hash is what goes to the database.
   */
  secret: string;
}

/** A verified caller: the token row, the account it acts as, and what it may do. */
export interface TokenPrincipal {
  token: schema.ApiTokenRow;
  user: schema.UserRow;
  scopes: readonly string[];
}

export class TokenService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    /** The account a token belongs to when the caller names none. In v1 there is exactly one. */
    private readonly defaultUserId: string,
  ) {}

  /**
   * Mint a token.
   *
   * The secret is generated here and returned once; the row carries its hash. A prefix collision
   * is astronomically unlikely and is still retried rather than surfaced, because
   * `ux_api_tokens_token_prefix` is a unique index and a 500 on a coin-flip is not an error a
   * caller can act on.
   */
  create(input: CreateTokenInput, actor: Actor): CreatedToken {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A token needs a name; it is how it is revoked.');

    const client: TokenClient = input.client ?? 'other';
    const scopes = [...(input.scopes ?? [ADMIN_SCOPE])];

    for (const scope of scopes) {
      if (!isGrantableScope(scope)) {
        throw new ValidationError(
          `'${scope}' is not a scope. Scopes are 'resource:verb' pairs, either half of which may ` +
            "be '*' — for example 'items:read', 'export:read', 'admin:*'.",
          { scope },
        );
      }
    }

    // A2. A feed URL travels in an Overleaf project setting and in a Quarto `_quarto.yml`; it is
    // published the moment it is used. A write scope on such a token is refused, not warned about.
    if (client === 'bib_feed' && !isReadOnly(scopes)) {
      throw new ConflictError(
        'A bib_feed token lives in a URL and is therefore public. It may hold read scopes only ' +
          '(invariant A2).',
        { scopes },
      );
    }

    const userId = input.userId ?? actor.userId ?? this.defaultUserId;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const secret = `${TOKEN_SECRET_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
      const row: schema.ApiTokenRow = {
        id: newId(),
        userId,
        name,
        tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
        tokenHash: hashTokenSecret(secret),
        scopes: JSON.stringify(scopes),
        client,
        createdAt: nowTimestamp(),
        createdByUserId: actor.userId ?? null,
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        note: input.note ?? null,
      };

      try {
        this.db.transaction((tx) => {
          tx.insert(schema.apiTokens).values(row).run();
          this.audit.record(
            {
              actor,
              action: 'token.created',
              entityType: 'api_token',
              entityId: row.id,
              // Never the secret and never the hash: the audit log is read far more widely than
              // the token table, and a hash is a verifier.
              after: { name, client, scopes, expiresAt: row.expiresAt, tokenPrefix: row.tokenPrefix },
            },
            tx,
          );
        });
      } catch (error) {
        if (attempt < 4 && /unique/iu.test(error instanceof Error ? error.message : '')) continue;
        throw error;
      }

      return { row, secret };
    }

    /* c8 ignore next */
    throw new ConflictError('Could not mint a token with an unused prefix after five attempts.');
  }

  list(options: { includeRevoked?: boolean } = {}): schema.ApiTokenRow[] {
    const rows = this.db
      .select()
      .from(schema.apiTokens)
      .orderBy(desc(schema.apiTokens.createdAt))
      .all();
    return options.includeRevoked === true ? rows : rows.filter((row) => row.revokedAt === null);
  }

  get(id: string): schema.ApiTokenRow {
    const row = this.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get();
    if (row === undefined) throw new NotFoundError('api_token', id);
    return row;
  }

  /** Revoke. A3: the row survives so that every audit row naming it still resolves. */
  revoke(id: string, actor: Actor): schema.ApiTokenRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get();
      if (current === undefined) throw new NotFoundError('api_token', id);
      if (current.revokedAt !== null) return current;

      const revokedAt = nowTimestamp();
      tx.update(schema.apiTokens)
        .set({ revokedAt })
        .where(eq(schema.apiTokens.id, id))
        .run();

      this.audit.record(
        {
          actor,
          action: 'token.revoked',
          entityType: 'api_token',
          entityId: id,
          before: { revokedAt: null },
          after: { revokedAt },
        },
        tx,
      );

      return { ...current, revokedAt };
    });
  }

  /**
   * Verify a presented secret.
   *
   * Returns `null` for every failure — wrong prefix, wrong hash, revoked, expired, inactive user —
   * because distinguishing them for the caller is an oracle, and the operator gets the distinction
   * from the log instead.
   */
  verify(secret: string, now: Date = new Date()): TokenPrincipal | null {
    if (secret.length <= TOKEN_PREFIX_LENGTH) return null;

    const prefix = secret.slice(0, TOKEN_PREFIX_LENGTH);
    const row = this.db
      .select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.tokenPrefix, prefix))
      .get();
    if (row === undefined) return null;
    if (!digestsMatch(row.tokenHash, hashTokenSecret(secret))) return null;

    // A1, in the order the spec states it.
    if (row.revokedAt !== null) return null;
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime()) return null;

    const user = this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, row.userId)))
      .get();
    if (user === undefined || !user.isActive) return null;

    this.touch(row, now);

    return { token: row, user, scopes: parseScopes(row) };
  }

  /** `last_used_at`, at most once a minute per token (§3.2). */
  private touch(row: schema.ApiTokenRow, now: Date): void {
    const previous = row.lastUsedAt === null ? 0 : Date.parse(row.lastUsedAt);
    if (Number.isFinite(previous) && now.getTime() - previous < LAST_USED_RESOLUTION_MS) return;

    const lastUsedAt = toTimestamp(now);
    this.db
      .update(schema.apiTokens)
      .set({ lastUsedAt })
      .where(eq(schema.apiTokens.id, row.id))
      .run();
  }
}

/** The scope array on a row, which is a JSON column, decoded defensively. */
export const parseScopes = (row: schema.ApiTokenRow): string[] => {
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    /* c8 ignore next */
    return [];
  }
};
