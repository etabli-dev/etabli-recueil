/**
 * Who did it.
 *
 * Every mutation in Recueil is attributable (P5, §6.5). The `Actor` is threaded through every
 * service call rather than read from a module-level "current user", because the same process serves
 * an HTTP request, an MCP tool call, a background job and an importer, and an ambient global would
 * mislabel three of them.
 *
 * Invariant AL2 says exactly one `actor_*` column is populated and agrees with `actor_type`. Two
 * of the seven types have no id to record — `system` is the server acting on its own behalf (the
 * boot-time bootstrap, a scheduled sweep) and `import` is a bulk load whose per-record actor is the
 * importer, not a token. For those two the actor columns are all null, which is the only reading of
 * AL2 that does not require inventing a synthetic user row.
 */
import type { ACTOR_TYPES } from '../db/schema.js';

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  type: ActorType;
  userId?: string | null;
  tokenId?: string | null;
  pluginId?: string | null;
  jobId?: string | null;
  /** Correlates every audit row written by one HTTP request (§6.5). */
  requestId?: string | null;
  apiRoute?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** The server acting on its own behalf. */
export const systemActor = (): Actor => ({ type: 'system' });

/** A signed-in user, which in v1 is the single local account. */
export const userActor = (userId: string, overrides: Partial<Actor> = {}): Actor => ({
  type: 'user',
  userId,
  ...overrides,
});

/** The `actor_*` columns for an actor, with the ones AL2 forbids left null. */
export const actorColumns = (
  actor: Actor,
): {
  actorType: ActorType;
  actorUserId: string | null;
  actorTokenId: string | null;
  actorPluginId: string | null;
  actorJobId: string | null;
} => {
  const empty = {
    actorUserId: null as string | null,
    actorTokenId: null as string | null,
    actorPluginId: null as string | null,
    actorJobId: null as string | null,
  };

  switch (actor.type) {
    case 'user':
      return { actorType: actor.type, ...empty, actorUserId: actor.userId ?? null };
    case 'token':
    case 'mcp':
      // An MCP write is a token write; it is distinguishable in the record and identical in
      // privilege (AL3, CONCEPT §5.12).
      return { actorType: actor.type, ...empty, actorTokenId: actor.tokenId ?? null };
    case 'plugin':
      return { actorType: actor.type, ...empty, actorPluginId: actor.pluginId ?? null };
    case 'job':
      return { actorType: actor.type, ...empty, actorJobId: actor.jobId ?? null };
    case 'system':
    case 'import':
      return { actorType: actor.type, ...empty };
  }
};

/** The user an owned record should belong to, when the actor implies one. */
export const actorUserId = (actor: Actor): string | null => actor.userId ?? null;
