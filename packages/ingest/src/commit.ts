/**
 * Stage 10: the commit.
 *
 * "Single transaction commit; events emitted." One transaction, and this file is where the
 * single-ness is real: `recueil.db.transaction` opens it, and every service call inside it —
 * `library.createItem`, `documents.attachDocument`, `tags.assignByName`, `collections.addItems`,
 * `customFields.setValue`, `notes.create`, and the `review_queue` insert — nests as a savepoint
 * rather than starting a transaction of its own. A throw anywhere unwinds all of it, and the
 * library never ends up with an item that has no attachment or tags that belong to nothing.
 *
 * Events are emitted *after* the transaction returns, never inside it, because an event is a
 * notification that something already happened (`spec/hooks.md` §1) and one emitted from inside a
 * transaction that then rolls back is a lie.
 *
 * What is deliberately *not* in this transaction: the `documents` row and its
 * `document_provenance` arrival. Those are written at stage 2, because the duplicate check cannot
 * query a table the document is not in yet and because the content store is not transactional. The
 * consequence is stated rather than hidden: a crash between stage 2 and stage 10 leaves a Document
 * with no Item, which `spec/data-model.md` D4 explicitly permits — "an ingested file not yet filed,
 * sitting in the review queue" — and which the resume journal finishes.
 */
import { InvariantError, NotFoundError, ValidationError, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import type { FieldValueContent } from '@recueil/schemas';
import { and, eq, isNull } from 'drizzle-orm';

import { INGEST_REASON_CODES } from './db/schema.js';
import { IngestError } from './errors.js';
import type { ReviewQueueRow } from './db/schema.js';
import type { ReviewQueueService } from './db/review-queue.js';
import type { ItemProposal, JsonValue, ProposedCreator } from './types.js';

export interface CommitInput {
  recueil: Recueil;
  reviewQueue: ReviewQueueService;
  actor: Actor;
  documentId: string;
  sha256: string;
  proposal: ItemProposal;
  /** `primary` for the file itself, `scan` for a scanned original. */
  attachmentRole: 'primary' | 'supplement' | 'snapshot' | 'scan';
  /** Written into `field_provenance.source` for every facet value. */
  provenanceSource: string;
  runId?: string;
  sourceStage: string;
  /**
   * Refuse to file a document that already carries a live attachment.
   *
   * The pipeline sets this; the review-queue accept paths do not, because a person accepting an
   * entry is making the decision this flag exists to protect against making twice by accident.
   *
   * It is the *second* half of the anti-duplication guard, and the half that survives a second
   * process. `IngestPipeline` serialises same-digest candidates on an in-flight set, which holds
   * only inside one process; this check is inside the same transaction as `createItem`, so a
   * second process either reads the first one's committed attachment and refuses here, or — if the
   * first commits after this transaction took its snapshot — is refused by SQLite when it tries to
   * upgrade that stale snapshot to a write (`SQLITE_BUSY_SNAPSHOT`). Neither outcome files twice.
   */
  refuseIfDocumentFiled?: boolean;
}

/**
 * The document already has a live attachment, so filing it again would give one document two items.
 *
 * Raised only when `refuseIfDocumentFiled` is set, and raised *inside* the transaction, so nothing
 * of the second commit survives. The pipeline turns it into a `duplicate` outcome: the bytes are in
 * the library and filed, which is precisely what stage 2 would have said had it run a moment later.
 */
export class DocumentAlreadyFiledError extends IngestError {
  constructor(
    readonly documentId: string,
    readonly itemId: string,
    readonly attachmentId: string,
  ) {
    super(
      `Document '${documentId}' is already filed as item '${itemId}' through attachment ` +
        `'${attachmentId}', so it was not filed a second time.`,
      'document_already_filed',
      { documentId, itemId, attachmentId },
    );
  }
}

export interface CommitResult {
  itemId: string;
  itemType: string;
  attachmentId: string;
  /** Rules or extractors that asked for something the library could not do, reported not swallowed. */
  warnings: string[];
  /** Raised inside the same transaction when a warning is serious enough to need a person. */
  reviewEntry: ReviewQueueRow | null;
}

/** The commit. Runs entirely inside one transaction; the caller emits the events afterwards. */
export const commitProposal = (input: CommitInput): CommitResult => {
  const { recueil, proposal, actor } = input;

  return recueil.db.transaction((): CommitResult => {
    // Inside the transaction, before anything is written: the question stage 2 asked, asked again
    // at the only moment where the answer and the write are atomic. See `refuseIfDocumentFiled`.
    if (input.refuseIfDocumentFiled === true) {
      const filed = recueil.db
        .select({ id: schema.attachments.id, itemId: schema.attachments.itemId })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.documentId, input.documentId),
            isNull(schema.attachments.trashedAt),
          ),
        )
        .get();
      if (filed !== undefined) {
        throw new DocumentAlreadyFiledError(input.documentId, filed.itemId, filed.id);
      }
    }

    const warnings: string[] = [];
    const itemType = proposal.itemType ?? 'document';

    const bibliographic = facetValues(proposal, 'bibliographic');
    const office = facetValues(proposal, 'office');
    const title = readString(proposal.fields['title']?.value) ?? readString(bibliographic['title']);

    const stamp = {
      source: input.provenanceSource,
      confidence: proposal.confidence,
      // An automated write never locks a field: P4-1 reserves the lock for a human's edit, which is
      // the whole reason enrichment can improve a record later without asking.
      lock: false,
    };

    const created = recueil.library.createItem(
      {
        itemType,
        title,
        sourceSystem: 'ingest',
        provenance: stamp,
        ...(Object.keys(bibliographic).length === 0
          ? {}
          : { bibliographic: bibliographic as Record<string, never> }),
        ...(office['correspondent'] === undefined
          ? {}
          : { office: office as { correspondent: string } }),
      },
      actor,
    );
    const itemId = created.item.id;

    // The office facet needs a correspondent, and a proposal that has other office fields but no
    // correspondent would silently lose them. Say so instead.
    if (office['correspondent'] === undefined && Object.keys(office).length > 0) {
      warnings.push(
        'office fields were proposed without a correspondent, which the facet requires; they were ' +
          'not written',
      );
    }

    const attachmentId = recueil.documents.attachDocument(
      { itemId, documentId: input.documentId, role: input.attachmentRole, title },
      actor,
    );

    if (proposal.creators.length > 0) {
      recueil.creators.setItemCreators(itemId, proposal.creators.map(toCreatorEntry(recueil, actor)), actor);
    }

    for (const tag of proposal.tags) {
      recueil.tags.assignByName(itemId, tag, actor, {
        source: 'rule',
        confidence: proposal.confidence,
      });
    }

    for (const collectionId of proposal.collectionIds) {
      try {
        recueil.collections.addItems(collectionId, [itemId], actor, { source: 'rule' });
      } catch (error) {
        if (error instanceof NotFoundError) {
          warnings.push(`a rule filed the item into collection '${collectionId}', which does not exist`);
          continue;
        }
        throw error;
      }
    }

    for (const [fieldKey, value] of Object.entries(proposal.customFields)) {
      const outcome = writeCustomField(recueil, actor, itemId, fieldKey, value);
      if (outcome !== null) warnings.push(outcome);
    }

    for (const note of proposal.notes) {
      if (note.trim().length === 0) continue;
      recueil.notes.create({ itemId, contentMarkdown: note }, actor);
    }

    let reviewEntry: ReviewQueueRow | null = null;
    if (warnings.length > 0) {
      reviewEntry = input.reviewQueue.raise({
        subjectType: 'item',
        subjectId: itemId,
        reasonCode: INGEST_REASON_CODES.ruleConflict,
        explanation:
          'The item was created, but part of the proposal could not be applied: ' +
          warnings.join('; ') +
          '.',
        proposedAction: 'set_fields',
        proposedPayload: { itemId, warnings } as JsonValue,
        confidence: proposal.confidence,
        severity: 'info',
        sourceStage: input.sourceStage,
        jobId: input.runId ?? null,
        actor,
      });
    }

    return { itemId, itemType, attachmentId, warnings, reviewEntry };
  });
};

/* ------------------------------------------------------------------------------------------ */
/* Mapping a proposal onto the model                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Pull `bibliographic.*` or `office.*` out of a proposal's dotted field paths. */
export const facetValues = (
  proposal: ItemProposal,
  facet: 'bibliographic' | 'office',
): Record<string, unknown> => {
  const prefix = `${facet}.`;
  const out: Record<string, unknown> = {};
  for (const [path, field] of Object.entries(proposal.fields)) {
    if (!path.startsWith(prefix)) continue;
    out[path.slice(prefix.length)] = field.value;
  }
  return out;
};

const toCreatorEntry =
  (recueil: Recueil, actor: Actor) =>
  (proposed: ProposedCreator): { creatorId: string; role: never; rawName: string | null } => {
    const creator = recueil.creators.create(
      {
        kind: proposed.literal !== undefined && proposed.family === undefined ? 'organisation' : 'person',
        ...(proposed.family === undefined ? {} : { familyName: proposed.family }),
        ...(proposed.given === undefined ? {} : { givenName: proposed.given }),
        ...(proposed.literal === undefined ? {} : { literalName: proposed.literal }),
        ...(proposed.orcid === undefined ? {} : { orcid: proposed.orcid }),
      },
      actor,
    );
    const rawName =
      proposed.literal ??
      [proposed.given, proposed.family].filter((part) => part !== undefined).join(' ') ??
      null;
    return {
      creatorId: creator.id,
      role: (proposed.role as never) ?? ('author' as never),
      rawName: rawName.length === 0 ? null : rawName,
    };
  };

/**
 * Write one custom-field value, coercing it to the field's declared type.
 *
 * Returns null on success, or the sentence that goes into the warnings — an undefined field key or
 * a value that cannot be coerced is an operator's mistake in a rule, and the right response is to
 * file the item and tell them, not to fail the ingest of a document that is otherwise fine.
 */
const writeCustomField = (
  recueil: Recueil,
  actor: Actor,
  itemId: string,
  fieldKey: string,
  value: JsonValue,
): string | null => {
  let dataType: string;
  try {
    dataType = recueil.customFields.getFieldByKey(fieldKey).dataType;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return `a rule set custom field '${fieldKey}', which is not defined in this library`;
    }
    throw error;
  }

  const content = coerceFieldValue(dataType, value);
  if (content === null) {
    return `a rule set custom field '${fieldKey}' to a value that is not a valid ${dataType}`;
  }

  try {
    recueil.customFields.setValue({ fieldKey, itemId, content }, actor);
    return null;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof InvariantError) {
      return `custom field '${fieldKey}' was refused: ${error.message}`;
    }
    throw error;
  }
};

/** Coerce a JSON value from a rule into the discriminated content shape the field expects. */
export const coerceFieldValue = (dataType: string, value: JsonValue): FieldValueContent | null => {
  switch (dataType) {
    case 'text':
    case 'long_text':
    case 'choice':
    case 'url': {
      const text = readString(value);
      return text === null ? null : ({ type: dataType, value: text } as FieldValueContent);
    }
    case 'number':
    case 'monetary': {
      const numeric = readNumber(value);
      return numeric === null ? null : ({ type: dataType, value: numeric } as FieldValueContent);
    }
    case 'integer': {
      const numeric = readNumber(value);
      return numeric === null || !Number.isInteger(numeric)
        ? null
        : { type: 'integer', value: numeric };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { type: 'boolean', value } : null;
    case 'date': {
      const text = readString(value);
      return text !== null && /^\d{4}-\d{2}-\d{2}$/u.test(text) ? { type: 'date', value: text } : null;
    }
    case 'datetime': {
      const text = readString(value);
      if (text === null) return null;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime())
        ? null
        : { type: 'datetime', value: parsed.toISOString() };
    }
    case 'multi_choice':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? { type: 'multi_choice', value: value as string[] }
        : null;
    case 'item_reference': {
      const text = readString(value);
      return text === null ? null : { type: 'item_reference', value: text };
    }
    case 'json':
      return { type: 'json', value };
    default:
      return null;
  }
};

const readString = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim().length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
