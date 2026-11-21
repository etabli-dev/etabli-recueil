/**
 * The bridge's own records: which libraries are bridged, which rows are linked, which conflicts
 * are open (`zotero_sync_*`, ADR-0025).
 */
import { newId, nowTimestamp, schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { ZoteroLibraryRef } from './api/types.js';
import type { FieldConflict } from './merge.js';

export type SyncObjectType = (typeof schema.ZOTERO_OBJECT_TYPES)[number];
export type SyncLibraryRow = schema.ZoteroSyncLibraryRow;
export type SyncLinkRow = schema.ZoteroSyncLinkRow;
export type SyncConflictRow = schema.ZoteroSyncConflictRow;

export class SyncState {
  constructor(private readonly recueil: Recueil) {}

  private get db() {
    return this.recueil.db;
  }

  /* Libraries ---------------------------------------------------------------------------------- */

  ensureLibrary(ref: ZoteroLibraryRef, name: string | null): SyncLibraryRow {
    const existing = this.findLibrary(ref);
    if (existing !== undefined) {
      if (name !== null && existing.name !== name) {
        this.db
          .update(schema.zoteroSyncLibraries)
          .set({ name, updatedAt: nowTimestamp() })
          .where(eq(schema.zoteroSyncLibraries.id, existing.id))
          .run();
      }
      return this.findLibrary(ref)!;
    }
    const now = nowTimestamp();
    const row: SyncLibraryRow = {
      id: newId(),
      libraryType: ref.type,
      libraryId: String(ref.id),
      name,
      version: 0,
      lastPulledAt: null,
      lastPushedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.zoteroSyncLibraries).values(row).run();
    return row;
  }

  findLibrary(ref: ZoteroLibraryRef): SyncLibraryRow | undefined {
    return this.db
      .select()
      .from(schema.zoteroSyncLibraries)
      .where(
        and(
          eq(schema.zoteroSyncLibraries.libraryType, ref.type),
          eq(schema.zoteroSyncLibraries.libraryId, String(ref.id)),
        ),
      )
      .get();
  }

  listLibraries(): SyncLibraryRow[] {
    return this.db.select().from(schema.zoteroSyncLibraries).all();
  }

  /** Move the pull cursor. It never moves backwards. */
  recordPull(libraryId: string, version: number): void {
    const current = this.db
      .select()
      .from(schema.zoteroSyncLibraries)
      .where(eq(schema.zoteroSyncLibraries.id, libraryId))
      .get();
    if (current === undefined) return;
    const now = nowTimestamp();
    this.db
      .update(schema.zoteroSyncLibraries)
      .set({ version: Math.max(current.version, version), lastPulledAt: now, updatedAt: now })
      .where(eq(schema.zoteroSyncLibraries.id, libraryId))
      .run();
  }

  recordPush(libraryId: string): void {
    const now = nowTimestamp();
    this.db
      .update(schema.zoteroSyncLibraries)
      .set({ lastPushedAt: now, updatedAt: now })
      .where(eq(schema.zoteroSyncLibraries.id, libraryId))
      .run();
  }

  /* Links -------------------------------------------------------------------------------------- */

  links(libraryId: string, objectType: SyncObjectType): SyncLinkRow[] {
    return this.db
      .select()
      .from(schema.zoteroSyncLinks)
      .where(
        and(eq(schema.zoteroSyncLinks.syncLibraryId, libraryId), eq(schema.zoteroSyncLinks.objectType, objectType)),
      )
      .all();
  }

  linkByKey(libraryId: string, objectType: SyncObjectType, key: string): SyncLinkRow | undefined {
    return this.db
      .select()
      .from(schema.zoteroSyncLinks)
      .where(
        and(
          eq(schema.zoteroSyncLinks.syncLibraryId, libraryId),
          eq(schema.zoteroSyncLinks.objectType, objectType),
          eq(schema.zoteroSyncLinks.zoteroKey, key),
        ),
      )
      .get();
  }

  linkByRecueilId(libraryId: string, objectType: SyncObjectType, recueilId: string): SyncLinkRow | undefined {
    return this.db
      .select()
      .from(schema.zoteroSyncLinks)
      .where(
        and(
          eq(schema.zoteroSyncLinks.syncLibraryId, libraryId),
          eq(schema.zoteroSyncLinks.objectType, objectType),
          eq(schema.zoteroSyncLinks.recueilId, recueilId),
        ),
      )
      .get();
  }

  /** Whether a Recueil row is linked to any bridged library (adoption must not take it twice). */
  isLinkedAnywhere(objectType: SyncObjectType, recueilId: string): boolean {
    return (
      this.db
        .select({ id: schema.zoteroSyncLinks.id })
        .from(schema.zoteroSyncLinks)
        .where(and(eq(schema.zoteroSyncLinks.objectType, objectType), eq(schema.zoteroSyncLinks.recueilId, recueilId)))
        .get() !== undefined
    );
  }

  saveLink(input: {
    libraryId: string;
    objectType: SyncObjectType;
    key: string;
    recueilId: string;
    version: number;
    base: unknown;
    fileMd5?: string | null;
  }): void {
    const now = nowTimestamp();
    const existing = this.linkByKey(input.libraryId, input.objectType, input.key);
    const base = JSON.stringify(input.base);
    if (existing === undefined) {
      this.db
        .insert(schema.zoteroSyncLinks)
        .values({
          id: newId(),
          syncLibraryId: input.libraryId,
          objectType: input.objectType,
          zoteroKey: input.key,
          recueilId: input.recueilId,
          zoteroVersion: input.version,
          base,
          fileMd5: input.fileMd5 ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return;
    }
    const patch: Partial<SyncLinkRow> = {
      recueilId: input.recueilId,
      zoteroVersion: input.version,
      base,
      updatedAt: now,
    };
    if (input.fileMd5 !== undefined) patch.fileMd5 = input.fileMd5;
    this.db.update(schema.zoteroSyncLinks).set(patch).where(eq(schema.zoteroSyncLinks.id, existing.id)).run();
  }

  dropLink(id: string): void {
    this.db.delete(schema.zoteroSyncLinks).where(eq(schema.zoteroSyncLinks.id, id)).run();
  }

  /* Conflicts ---------------------------------------------------------------------------------- */

  openConflicts(libraryId: string, objectType?: SyncObjectType, key?: string): SyncConflictRow[] {
    const conditions = [
      eq(schema.zoteroSyncConflicts.syncLibraryId, libraryId),
      eq(schema.zoteroSyncConflicts.state, 'open'),
    ];
    if (objectType !== undefined) conditions.push(eq(schema.zoteroSyncConflicts.objectType, objectType));
    if (key !== undefined) conditions.push(eq(schema.zoteroSyncConflicts.zoteroKey, key));
    return this.db
      .select()
      .from(schema.zoteroSyncConflicts)
      .where(and(...conditions))
      .all();
  }

  allOpenConflicts(): SyncConflictRow[] {
    return this.db
      .select()
      .from(schema.zoteroSyncConflicts)
      .where(eq(schema.zoteroSyncConflicts.state, 'open'))
      .all();
  }

  getConflict(id: string): SyncConflictRow | undefined {
    return this.db.select().from(schema.zoteroSyncConflicts).where(eq(schema.zoteroSyncConflicts.id, id)).get();
  }

  /** Record or refresh one open conflict per field. */
  recordConflict(
    libraryId: string,
    objectType: SyncObjectType,
    key: string,
    recueilId: string | null,
    conflict: FieldConflict,
  ): void {
    const existing = this.openConflicts(libraryId, objectType, key).find((row) => row.field === conflict.field);
    if (existing !== undefined) {
      this.db
        .update(schema.zoteroSyncConflicts)
        .set({ baseValue: conflict.base, recueilValue: conflict.recueil, zoteroValue: conflict.zotero })
        .where(eq(schema.zoteroSyncConflicts.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(schema.zoteroSyncConflicts)
      .values({
        id: newId(),
        syncLibraryId: libraryId,
        objectType,
        zoteroKey: key,
        recueilId,
        field: conflict.field,
        baseValue: conflict.base,
        recueilValue: conflict.recueil,
        zoteroValue: conflict.zotero,
        state: 'open',
        detectedAt: nowTimestamp(),
      })
      .run();
  }

  /** Conflicts a person has decided and the next sync has not applied yet. */
  pendingResolutions(libraryId: string, objectType: SyncObjectType, key: string): SyncConflictRow[] {
    return this.db
      .select()
      .from(schema.zoteroSyncConflicts)
      .where(
        and(
          eq(schema.zoteroSyncConflicts.syncLibraryId, libraryId),
          eq(schema.zoteroSyncConflicts.objectType, objectType),
          eq(schema.zoteroSyncConflicts.zoteroKey, key),
          inArray(schema.zoteroSyncConflicts.state, ['resolved_zotero', 'resolved_recueil']),
          isNull(schema.zoteroSyncConflicts.resolvedAt),
        ),
      )
      .all();
  }

  /** A decision: which side wins. Applied by the next sync, which then stamps `resolved_at`. */
  decideConflict(id: string, choice: 'zotero' | 'recueil'): void {
    this.db
      .update(schema.zoteroSyncConflicts)
      .set({ state: choice === 'zotero' ? 'resolved_zotero' : 'resolved_recueil', resolvedAt: null })
      .where(eq(schema.zoteroSyncConflicts.id, id))
      .run();
  }

  markApplied(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(schema.zoteroSyncConflicts)
      .set({ resolvedAt: nowTimestamp() })
      .where(inArray(schema.zoteroSyncConflicts.id, [...ids]))
      .run();
  }

  resolveConflicts(ids: readonly string[], state: Exclude<SyncConflictRow['state'], 'open'>): void {
    if (ids.length === 0) return;
    this.db
      .update(schema.zoteroSyncConflicts)
      .set({ state, resolvedAt: nowTimestamp() })
      .where(inArray(schema.zoteroSyncConflicts.id, [...ids]))
      .run();
  }
}
