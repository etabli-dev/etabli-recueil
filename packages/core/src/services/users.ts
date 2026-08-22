/**
 * The single local account (§3.1, §1.4).
 *
 * v1 is single-user, but every owned record carries `owner_user_id` and every audit row resolves to
 * an actor, so the row has to exist before anything else can be written. `ensureLocalUser` is the
 * boot-time bootstrap: it creates the account on an empty database and does nothing on every
 * subsequent start, which is the same "safe to run repeatedly" property the migrations have.
 */
import { asc, eq } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { users } from '../db/schema.js';
import type { UserRow } from '../db/schema.js';
import { newId } from '../ids.js';
import { normalise } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { AuditService } from './audit.js';
import { systemActor } from './actor.js';

export const DEFAULT_LOCAL_USERNAME = 'local';

export interface EnsureLocalUserOptions {
  username?: string;
  displayName?: string | null;
  email?: string | null;
}

/**
 * Return the library's user, creating it if the database is empty.
 *
 * Invariant U2 — at least one active admin exists at all times — starts here.
 */
export const ensureLocalUser = (
  db: RecueilDatabase,
  audit: AuditService,
  options: EnsureLocalUserOptions = {},
): UserRow => {
  const username = options.username ?? DEFAULT_LOCAL_USERNAME;
  const usernameNormalised = normalise(username);

  const existing = db
    .select()
    .from(users)
    .where(eq(users.usernameNormalised, usernameNormalised))
    .get();
  if (existing !== undefined) return existing;

  // A differently named account already present is still this library's user: v1 has exactly one,
  // and inventing a second here would break U2's spirit and every `owner_user_id` already written.
  const anyUser = db.select().from(users).orderBy(asc(users.id)).limit(1).get();
  if (anyUser !== undefined) return anyUser;

  return db.transaction((tx) => {
    const now = nowTimestamp();
    const row: UserRow = {
      id: newId(),
      username,
      usernameNormalised,
      email: options.email ?? null,
      displayName: options.displayName ?? null,
      passwordHash: null,
      isActive: true,
      isAdmin: true,
      locale: null,
      timezone: null,
      settings: '{}',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
      trashedAt: null,
    };
    tx.insert(users).values(row).run();

    audit.record(
      {
        actor: systemActor(),
        action: 'user.created',
        entityType: 'user',
        entityId: row.id,
        after: { username: row.username, isAdmin: true },
        reason: 'bootstrap of the single local account (§1.4)',
      },
      tx,
    );

    return row;
  });
};
