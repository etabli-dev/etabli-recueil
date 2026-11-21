/**
 * Reading annotations as records (ADR-0009, ADR-0017, `spec/data-model.md` §4.9).
 *
 * - **AN1.** The document's bytes are never touched; an annotation is a row.
 * - **AN2.** An annotation made in the context of an item needs a live attachment linking that
 *   item to the document. Checked on every create.
 * - **AN3.** The target is the document, so every item that carries the document sees it.
 * - **AN4.** At least one selector resolves without the text layer (enforced by the API schema;
 *   re-checked here because the service is also called by importers).
 *
 * The service maintains the derived columns: `quoted_text` and its context from the
 * `TextQuoteSelector`, `page_index` from the page selector, and `position_sort_key`, a fixed-width
 * reading-order key — page, then distance from the top, then from the left — so annotations list
 * in the order they are read. It also keeps `attachments.annotation_count` in step (AT4).
 *
 * An annotation trashed on its own is restorable on its own here; one trashed with its item comes
 * back with the item (I4), which the trash dispatcher enforces.
 */
import { and, asc, count, eq, isNull } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { ANNOTATION_BODY_FORMATS, ANNOTATION_MOTIVATIONS, ANNOTATION_TYPES, annotations, attachments, documents } from '../db/schema.js';
import type { AnnotationRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import { closeTrashRecord, findOpenTrashRecord, openTrashRecord } from './trash-record.js';

export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type AnnotationMotivation = (typeof ANNOTATION_MOTIVATIONS)[number];
export type AnnotationBodyFormat = (typeof ANNOTATION_BODY_FORMATS)[number];

/** The W3C selectors and Recueil's two extensions, as stored. */
export type AnnotationSelector =
  | { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string }
  | { type: 'TextPositionSelector'; start: number; end: number }
  | { type: 'FragmentSelector'; conformsTo?: string; value: string }
  | { type: 'RectangleSelector'; pageIndex: number; rectangles: { x: number; y: number; width: number; height: number }[] }
  | { type: 'InkSelector'; pageIndex: number; paths: { x: number; y: number }[][]; strokeWidth?: number };

export interface CreateAnnotationInput {
  documentId: string;
  itemId?: string | null;
  attachmentId?: string | null;
  annotationType: AnnotationType;
  motivation: AnnotationMotivation;
  selector: AnnotationSelector[];
  bodyText?: string | null;
  bodyFormat?: AnnotationBodyFormat;
  colour?: string | null;
  pageIndex?: number | null;
  pageLabel?: string | null;
  authorName?: string | null;
  isExternal?: boolean;
  externalRef?: string | null;
}

export type UpdateAnnotationInput = Partial<
  Pick<CreateAnnotationInput, 'annotationType' | 'motivation' | 'selector' | 'bodyText' | 'bodyFormat' | 'colour' | 'pageLabel'>
>;

export interface ListAnnotationsOptions {
  documentId?: string;
  itemId?: string;
  includeTrashed?: boolean;
}

const TEXT_INDEPENDENT = new Set(['FragmentSelector', 'RectangleSelector', 'InkSelector']);

/** Page from the selectors: a rectangle or ink page, else a PDF `page=N` fragment (1-based). */
export const selectorPage = (selectors: readonly AnnotationSelector[]): number | null => {
  for (const selector of selectors) {
    if (selector.type === 'RectangleSelector' || selector.type === 'InkSelector') return selector.pageIndex;
  }
  for (const selector of selectors) {
    if (selector.type === 'FragmentSelector') {
      const match = /(?:^|&)page=(\d+)/u.exec(selector.value);
      if (match !== null) return Math.max(0, Number(match[1]) - 1);
    }
  }
  return null;
};

/**
 * Reading order: `PPPPP|TTTTTT|LLLLLL`. PDF user space has its origin at the bottom left, so the
 * distance from the top is the page-relative inverse of the highest y; 99999 points is above any
 * real page.
 */
export const positionSortKey = (selectors: readonly AnnotationSelector[], pageIndex: number | null): string => {
  const page = String(pageIndex ?? 99_999).padStart(5, '0');
  let top = 999_999;
  let left = 999_999;
  for (const selector of selectors) {
    const points =
      selector.type === 'RectangleSelector'
        ? selector.rectangles.flatMap((r) => [{ x: r.x, y: r.y + r.height }])
        : selector.type === 'InkSelector'
          ? selector.paths.flat()
          : [];
    for (const point of points) {
      top = Math.min(top, Math.max(0, Math.round(99_999 - point.y)));
      left = Math.min(left, Math.max(0, Math.round(point.x)));
    }
  }
  return `${page}|${String(Math.min(top, 999_999)).padStart(6, '0')}|${String(Math.min(left, 999_999)).padStart(6, '0')}`;
};

export class AnnotationService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly ownerUserId: string,
  ) {}

  private assertSelectors(selectors: readonly AnnotationSelector[]): void {
    if (selectors.length === 0) throw new ValidationError('An annotation needs at least one selector.');
    if (!selectors.some((selector) => TEXT_INDEPENDENT.has(selector.type))) {
      throw new ValidationError(
        'At least one selector must resolve without the extracted text — a page fragment, rectangles or ink (AN4).',
      );
    }
  }

  private derived(selectors: readonly AnnotationSelector[], pageIndex: number | null | undefined) {
    const quote = selectors.find((selector) => selector.type === 'TextQuoteSelector') as
      | Extract<AnnotationSelector, { type: 'TextQuoteSelector' }>
      | undefined;
    const page = pageIndex ?? selectorPage(selectors);
    return {
      quotedText: quote?.exact ?? null,
      prefixText: quote?.prefix ?? null,
      suffixText: quote?.suffix ?? null,
      pageIndex: page,
      positionSortKey: positionSortKey(selectors, page),
    };
  }

  /** AT4: every live attachment of the document carries the live count. */
  private recount(documentId: string): void {
    const live = this.db
      .select({ n: count() })
      .from(annotations)
      .where(and(eq(annotations.documentId, documentId), isNull(annotations.trashedAt)))
      .get()!.n;
    this.db
      .update(attachments)
      .set({ annotationCount: live, hasAnnotations: live > 0 })
      .where(eq(attachments.documentId, documentId))
      .run();
  }

  create(input: CreateAnnotationInput, actor: Actor): AnnotationRow {
    this.assertSelectors(input.selector);
    if (input.annotationType === 'note' && (input.bodyText ?? '').trim() === '') {
      throw new ValidationError('A note annotation needs a body.');
    }
    return this.db.transaction((tx) => {
      const document = tx.select({ id: documents.id }).from(documents).where(eq(documents.id, input.documentId)).get();
      if (document === undefined) throw new NotFoundError('document', input.documentId);
      let attachmentId = input.attachmentId ?? null;
      if (input.itemId != null) {
        // AN2: reading through an item needs the item to carry the document.
        const link = tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(and(eq(attachments.itemId, input.itemId), eq(attachments.documentId, input.documentId), isNull(attachments.trashedAt)))
          .get();
        if (link === undefined) {
          throw new ConflictError(`Item '${input.itemId}' has no live attachment of document '${input.documentId}' (AN2).`, {
            itemId: input.itemId,
            documentId: input.documentId,
          });
        }
        attachmentId ??= link.id;
      }
      const now = nowTimestamp();
      const row: AnnotationRow = {
        id: newId(),
        publicId: newPublicId(),
        documentId: input.documentId,
        itemId: input.itemId ?? null,
        attachmentId,
        annotationType: input.annotationType,
        motivation: input.motivation,
        selector: JSON.stringify(input.selector),
        ...this.derived(input.selector, input.pageIndex),
        bodyText: input.bodyText ?? null,
        bodyFormat: input.bodyFormat ?? 'markdown',
        colour: input.colour ?? null,
        pageLabel: input.pageLabel ?? null,
        authorUserId: input.isExternal === true ? null : (actor.userId ?? this.ownerUserId),
        authorName: input.authorName ?? null,
        isExternal: input.isExternal ?? false,
        externalRef: input.externalRef ?? null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      tx.insert(annotations).values(row).run();
      this.recount(input.documentId);
      this.audit.record(
        { actor, action: 'annotation.created', entityType: 'annotation', entityId: row.id, after: { documentId: row.documentId, type: row.annotationType } },
        tx,
      );
      return row;
    });
  }

  get(id: string, options: { includeTrashed?: boolean } = {}): AnnotationRow {
    const row = this.db.select().from(annotations).where(eq(annotations.id, id)).get();
    if (row === undefined || (row.trashedAt !== null && options.includeTrashed !== true)) throw new NotFoundError('annotation', id);
    return row;
  }

  list(options: ListAnnotationsOptions = {}): AnnotationRow[] {
    const conditions = [];
    if (options.includeTrashed !== true) conditions.push(isNull(annotations.trashedAt));
    if (options.documentId !== undefined) conditions.push(eq(annotations.documentId, options.documentId));
    if (options.itemId !== undefined) {
      // AN3: what an item shows is every annotation on every document it carries.
      const documentIds = this.db
        .select({ id: attachments.documentId })
        .from(attachments)
        .where(and(eq(attachments.itemId, options.itemId), isNull(attachments.trashedAt)))
        .all()
        .map((row) => row.id)
        .filter((id): id is string => id !== null);
      if (documentIds.length === 0) return [];
      return documentIds
        .flatMap((documentId) => this.list({ ...options, itemId: undefined, documentId }))
        .sort((left, right) => (left.documentId === right.documentId ? left.positionSortKey.localeCompare(right.positionSortKey) : 0));
    }
    return this.db
      .select()
      .from(annotations)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(annotations.positionSortKey), asc(annotations.createdAt))
      .all();
  }

  update(id: string, patch: UpdateAnnotationInput, actor: Actor, options: { expectedVersion?: number } = {}): AnnotationRow {
    if (patch.selector !== undefined) this.assertSelectors(patch.selector);
    return this.db.transaction((tx) => {
      const current = this.get(id);
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new VersionConflictError('annotation', id, options.expectedVersion, current.version);
      }
      const selectors = patch.selector ?? (JSON.parse(current.selector) as AnnotationSelector[]);
      const next: AnnotationRow = {
        ...current,
        ...(patch.annotationType === undefined ? {} : { annotationType: patch.annotationType }),
        ...(patch.motivation === undefined ? {} : { motivation: patch.motivation }),
        ...(patch.bodyText === undefined ? {} : { bodyText: patch.bodyText }),
        ...(patch.bodyFormat === undefined ? {} : { bodyFormat: patch.bodyFormat }),
        ...(patch.colour === undefined ? {} : { colour: patch.colour }),
        ...(patch.pageLabel === undefined ? {} : { pageLabel: patch.pageLabel }),
        selector: JSON.stringify(selectors),
        ...(patch.selector === undefined ? {} : this.derived(selectors, null)),
        version: current.version + 1,
        updatedAt: nowTimestamp(),
      };
      if (next.annotationType === 'note' && (next.bodyText ?? '').trim() === '') throw new ValidationError('A note annotation needs a body.');
      tx.update(annotations).set(next).where(eq(annotations.id, id)).run();
      this.audit.record({ actor, action: 'annotation.updated', entityType: 'annotation', entityId: id, after: { version: next.version } }, tx);
      return next;
    });
  }

  trash(id: string, actor: Actor): AnnotationRow {
    return this.db.transaction((tx) => {
      const current = this.get(id, { includeTrashed: true });
      if (current.trashedAt !== null) return current;
      const now = nowTimestamp();
      tx.update(annotations).set({ trashedAt: now, updatedAt: now, version: current.version + 1 }).where(eq(annotations.id, id)).run();
      openTrashRecord(tx, {
        entityType: 'annotation',
        entityId: id,
        groupId: newId(),
        trashedAt: now,
        reason: 'user',
        trashedByUserId: actor.userId ?? null,
        restorePayload: { standalone: true },
      });
      this.recount(current.documentId);
      this.audit.record({ actor, action: 'annotation.trashed', entityType: 'annotation', entityId: id }, tx);
      return { ...current, trashedAt: now, version: current.version + 1 };
    });
  }

  restore(id: string, actor: Actor): AnnotationRow {
    return this.db.transaction((tx) => {
      const current = this.get(id, { includeTrashed: true });
      if (current.trashedAt === null) return current;
      const record = findOpenTrashRecord(tx, 'annotation', id);
      if (record === undefined || !String(record.restorePayload).includes('"standalone":true')) {
        throw new ConflictError('This annotation went into the trash with its item; restore the item (I4).', { annotationId: id });
      }
      const now = nowTimestamp();
      tx.update(annotations).set({ trashedAt: null, updatedAt: now, version: current.version + 1 }).where(eq(annotations.id, id)).run();
      closeTrashRecord(tx, record.id, now, actor.userId ?? null);
      this.recount(current.documentId);
      this.audit.record({ actor, action: 'annotation.restored', entityType: 'annotation', entityId: id }, tx);
      return { ...current, trashedAt: null, version: current.version + 1 };
    });
  }
}
