/**
 * Notes (§4.8).
 *
 * Markdown notes, attached to an item or standalone, and also the destination for IMAP message
 * bodies (CONCEPT §5.3) and for Citavi-style quotes and thoughts.
 *
 * Two rules are enforced here and nowhere else:
 *
 * - **N1.** `content_markdown` is always populated, including for HTML imports. A caller may hand
 *   over HTML instead of Markdown; the HTML is kept verbatim in `content_original` for a lossless
 *   round trip (P10) and converted on write, so that the search index and the export path read one
 *   column and never have to know which form the note arrived in.
 * - **N2.** Notes are full-text indexed. The index write happens in the same transaction as the
 *   note write, so a note is searchable the moment it is saved or never at all.
 *
 * `version` is optimistic concurrency, exactly as it is on items (§1.7): a conditional write with a
 * stale version is refused, the refusal is audited as `note.conflict`, and nothing is merged (P1).
 */
import { and, asc, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { items, notes } from '../db/schema.js';
import type { NoteRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { deriveNoteTitle, htmlToMarkdown } from '../markdown.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import { diffFields } from './audit.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';
import type { SearchIndexer } from './search.js';
import type { TrashOptions } from './trash-record.js';
import { closeTrashRecord, findOpenTrashRecord, openTrashRecord } from './trash-record.js';

export type NoteKind = 'note' | 'quote' | 'thought' | 'summary' | 'email_body';

export interface CreateNoteInput {
  /** Null or absent for a standalone note. */
  itemId?: string | null;
  /** Give one of these. `contentHtml` is converted and kept verbatim as well (N1). */
  contentMarkdown?: string;
  contentHtml?: string;
  /** Derived from the first heading or line when absent (§4.8). */
  title?: string | null;
  noteKind?: NoteKind;
  parentAnnotationId?: string | null;
  ownerUserId?: string;
  publicId?: string;
  /** Importers preserve the original; ordinary writes leave it unset (§1.8). */
  createdAt?: string;
}

export interface UpdateNoteInput {
  itemId?: string | null;
  contentMarkdown?: string;
  contentHtml?: string;
  title?: string | null;
  noteKind?: NoteKind;
}

export interface ListNotesOptions {
  /** `null` asks for standalone notes specifically. */
  itemId?: string | null;
  ownerUserId?: string;
  noteKind?: NoteKind;
  includeTrashed?: boolean;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

export class NoteService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly defaultOwnerUserId: string,
    private readonly search?: SearchIndexer,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Create and read                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  create(input: CreateNoteInput, actor: Actor): NoteRow {
    const { contentMarkdown, sourceFormat, contentOriginal } = resolveContent(input);
    if (contentMarkdown.trim() === '') {
      throw new ValidationError('A note needs content (§4.8, N1).');
    }

    const ownerUserId = input.ownerUserId ?? actor.userId ?? this.defaultOwnerUserId;

    return this.db.transaction((tx) => {
      const itemId = input.itemId ?? null;
      if (itemId !== null) {
        const item = tx.select().from(items).where(eq(items.id, itemId)).get();
        if (item === undefined) throw new NotFoundError('item', itemId);
        if (item.trashedAt !== null) {
          throw new ConflictError(`Item '${itemId}' is in the trash; restore it before adding notes.`, {
            itemId,
          });
        }
      }

      const now = nowTimestamp();
      const row: NoteRow = {
        id: newId(),
        publicId: input.publicId ?? this.mintPublicId(tx),
        itemId,
        parentAnnotationId: input.parentAnnotationId ?? null,
        ownerUserId,
        title: input.title !== undefined ? input.title : deriveNoteTitle(contentMarkdown),
        contentMarkdown,
        sourceFormat,
        contentOriginal,
        noteKind: input.noteKind ?? 'note',
        version: 1,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        trashedAt: null,
      };
      tx.insert(notes).values(row).run();

      this.audit.record(
        {
          actor,
          action: 'note.created',
          entityType: 'note',
          entityId: row.id,
          after: {
            itemId,
            noteKind: row.noteKind,
            sourceFormat,
            characters: contentMarkdown.length,
          },
        },
        tx,
      );

      this.search?.indexNote(row.id, tx);
      return row;
    });
  }

  get(id: string, options: { includeTrashed?: boolean } = {}): NoteRow {
    const row = this.db.select().from(notes).where(eq(notes.id, id)).get();
    if (row === undefined) throw new NotFoundError('note', id);
    if (row.trashedAt !== null && options.includeTrashed !== true) throw new NotFoundError('note', id);
    return row;
  }

  getByPublicId(publicId: string, options: { includeTrashed?: boolean } = {}): NoteRow {
    const row = this.db.select().from(notes).where(eq(notes.publicId, publicId)).get();
    if (row === undefined) throw new NotFoundError('note', publicId);
    return this.get(row.id, options);
  }

  /** A page of notes, ordered by `(updated_at, id)` so the cursor order is total. */
  list(options: ListNotesOptions = {}): Page<NoteRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const conditions = [];
    if (options.includeTrashed !== true) conditions.push(isNull(notes.trashedAt));
    if (options.itemId !== undefined) {
      conditions.push(options.itemId === null ? isNull(notes.itemId) : eq(notes.itemId, options.itemId));
    }
    if (options.ownerUserId !== undefined) conditions.push(eq(notes.ownerUserId, options.ownerUserId));
    if (options.noteKind !== undefined) conditions.push(eq(notes.noteKind, options.noteKind));

    if (options.cursor !== undefined) {
      const { k, i } = decodeCursor(options.cursor);
      conditions.push(
        order === 'desc'
          ? or(lt(notes.updatedAt, k), and(eq(notes.updatedAt, k), lt(notes.id, i)))!
          : or(gt(notes.updatedAt, k), and(eq(notes.updatedAt, k), gt(notes.id, i)))!,
      );
    }

    const direction = order === 'desc' ? desc : asc;
    const rows = this.db
      .select()
      .from(notes)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(direction(notes.updatedAt), direction(notes.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data.at(-1);

    return {
      data,
      page: {
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ k: last.updatedAt, i: last.id }) : null,
        hasMore,
        limit,
      },
    };
  }

  /** How many live notes an item carries. The count an item pane shows beside the tab. */
  countForItem(itemId: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(notes)
        .where(and(eq(notes.itemId, itemId), isNull(notes.trashedAt)))
        .get()?.value ?? 0
    );
  }

  /** Every live note on an item, oldest first — the order the item pane reads them in. */
  forItem(itemId: string): NoteRow[] {
    return this.db
      .select()
      .from(notes)
      .where(and(eq(notes.itemId, itemId), isNull(notes.trashedAt)))
      .orderBy(asc(notes.createdAt), asc(notes.id))
      .all();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Update                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  update(
    id: string,
    patch: UpdateNoteInput,
    actor: Actor,
    options: { expectedVersion?: number } = {},
  ): NoteRow {
    // Outside the transaction, for the same reason as `LibraryService.updateItem`: the audit row
    // that records the refusal must survive the rollback of the write it refuses (§1.7).
    if (options.expectedVersion !== undefined) {
      const seen = this.db.select().from(notes).where(eq(notes.id, id)).get();
      if (seen !== undefined && seen.version !== options.expectedVersion) {
        this.audit.record({
          actor,
          action: 'note.conflict',
          entityType: 'note',
          entityId: id,
          before: { version: seen.version },
          after: { version: options.expectedVersion },
          reason: 'stale conditional write, refused (§1.7, P1)',
        });
        throw new VersionConflictError('note', id, options.expectedVersion, seen.version);
      }
    }

    return this.db.transaction((tx) => {
      const current = tx.select().from(notes).where(eq(notes.id, id)).get();
      if (current === undefined) throw new NotFoundError('note', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(`Note '${id}' is in the trash. Restore it before editing it.`, {
          noteId: id,
        });
      }
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new VersionConflictError('note', id, options.expectedVersion, current.version);
      }

      const rewritingContent = patch.contentMarkdown !== undefined || patch.contentHtml !== undefined;
      const content = rewritingContent
        ? resolveContent(patch)
        : {
            contentMarkdown: current.contentMarkdown,
            sourceFormat: current.sourceFormat,
            contentOriginal: current.contentOriginal,
          };
      if (content.contentMarkdown.trim() === '') {
        throw new ValidationError('A note needs content (§4.8, N1).');
      }

      if (patch.itemId !== undefined && patch.itemId !== null) {
        const item = tx.select().from(items).where(eq(items.id, patch.itemId)).get();
        if (item === undefined) throw new NotFoundError('item', patch.itemId);
      }

      const now = nowTimestamp();
      const next: NoteRow = {
        ...current,
        itemId: patch.itemId !== undefined ? patch.itemId : current.itemId,
        title:
          patch.title !== undefined
            ? patch.title
            : rewritingContent
              ? deriveNoteTitle(content.contentMarkdown)
              : current.title,
        contentMarkdown: content.contentMarkdown,
        sourceFormat: content.sourceFormat,
        contentOriginal: content.contentOriginal,
        noteKind: patch.noteKind ?? current.noteKind,
        version: current.version + 1,
        updatedAt: now,
      };

      tx.update(notes)
        .set({
          itemId: next.itemId,
          title: next.title,
          contentMarkdown: next.contentMarkdown,
          sourceFormat: next.sourceFormat,
          contentOriginal: next.contentOriginal,
          noteKind: next.noteKind,
          version: next.version,
          updatedAt: next.updatedAt,
        })
        .where(eq(notes.id, id))
        .run();

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        itemId: next.itemId,
        title: next.title,
        noteKind: next.noteKind,
        sourceFormat: next.sourceFormat,
      });

      this.audit.record(
        {
          actor,
          action: 'note.updated',
          entityType: 'note',
          entityId: id,
          before: { ...(delta.before ?? {}), version: current.version },
          after: {
            ...(delta.after ?? {}),
            version: next.version,
            ...(rewritingContent ? { characters: next.contentMarkdown.length } : {}),
          },
        },
        tx,
      );

      this.search?.indexNote(id, tx);
      if (current.itemId !== null) this.search?.indexItem(current.itemId, tx);
      if (next.itemId !== null && next.itemId !== current.itemId) {
        this.search?.indexItem(next.itemId, tx);
      }

      return next;
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash and restore (P5)                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  trash(id: string, actor: Actor, options: TrashOptions = {}): NoteRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(notes).where(eq(notes.id, id)).get();
      if (current === undefined) throw new NotFoundError('note', id);
      if (current.trashedAt !== null) return current;

      const now = nowTimestamp();
      tx.update(notes)
        .set({ trashedAt: now, updatedAt: now, version: current.version + 1 })
        .where(eq(notes.id, id))
        .run();

      openTrashRecord(tx, {
        entityType: 'note',
        entityId: id,
        groupId: newId(),
        trashedAt: now,
        trashedByUserId: actor.userId ?? null,
        reason: options.reason ?? 'user',
        reasonDetail: options.reasonDetail ?? null,
        restorePayload: { itemId: current.itemId, version: current.version },
      });

      this.audit.record(
        {
          actor,
          action: 'note.trashed',
          entityType: 'note',
          entityId: id,
          before: { trashedAt: null, version: current.version },
          after: { trashedAt: now, version: current.version + 1 },
          reason: options.reason ?? 'user',
        },
        tx,
      );

      this.search?.removeEntity('note', id, tx);
      return { ...current, trashedAt: now, updatedAt: now, version: current.version + 1 };
    });
  }

  restore(id: string, actor: Actor): NoteRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(notes).where(eq(notes.id, id)).get();
      if (current === undefined) throw new NotFoundError('note', id);

      const record = findOpenTrashRecord(tx, 'note', id);
      if (record === undefined) {
        if (current.trashedAt === null) return current;
        throw new ConflictError(
          `Note '${id}' is trashed but has no open trash record, which breaks invariant T1.`,
          { noteId: id },
        );
      }

      const now = nowTimestamp();
      tx.update(notes)
        .set({ trashedAt: null, updatedAt: now, version: current.version + 1 })
        .where(eq(notes.id, id))
        .run();
      closeTrashRecord(tx, record.id, now, actor.userId ?? null);

      this.audit.record(
        {
          actor,
          action: 'note.restored',
          entityType: 'note',
          entityId: id,
          before: { trashedAt: current.trashedAt, version: current.version },
          after: { trashedAt: null, version: current.version + 1 },
          reason: record.reason,
        },
        tx,
      );

      this.search?.indexNote(id, tx);
      return { ...current, trashedAt: null, updatedAt: now, version: current.version + 1 };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private mintPublicId(tx: Pick<RecueilDatabase, 'select'>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = newPublicId();
      const taken = tx.select({ id: notes.id }).from(notes).where(eq(notes.publicId, candidate)).get();
      if (taken === undefined) return candidate;
    }
    throw new ConflictError('Could not mint an unused public id in eight attempts.');
  }
}

/** N1: whichever form the caller supplied, `content_markdown` ends up populated. */
const resolveContent = (
  input: Pick<CreateNoteInput, 'contentMarkdown' | 'contentHtml'>,
): { contentMarkdown: string; sourceFormat: 'markdown' | 'html'; contentOriginal: string | null } => {
  if (input.contentHtml !== undefined) {
    return {
      contentMarkdown: htmlToMarkdown(input.contentHtml),
      sourceFormat: 'html',
      contentOriginal: input.contentHtml,
    };
  }
  if (input.contentMarkdown !== undefined) {
    return {
      contentMarkdown: input.contentMarkdown,
      sourceFormat: 'markdown',
      contentOriginal: null,
    };
  }
  throw new ValidationError(
    'A note needs either contentMarkdown or contentHtml (§4.8, N1).',
  );
};
