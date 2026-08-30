/**
 * The mailbox (CONCEPT §5.3): "IMAP mailbox (attachments as Documents, body as Note, rules by
 * sender/subject)".
 *
 * The division of labour is the thing to understand here, because it is what keeps the mail path
 * from becoming a second, worse ingestion pipeline:
 *
 *   - **This source produces one candidate per message**, carrying the whole RFC 5322 message as
 *     its bytes and `message/rfc822` as its media type.
 *   - **`@recueil/ingest` does the rest.** Stage 3 recognises the message as an archive, parses the
 *     MIME tree, writes each attachment to scratch and re-enters it at stage 1 as a Document of its
 *     own, and puts the text body on the proposal as a Note. Multipart, nested `message/rfc822`
 *     forwards, inline images, base64, quoted-printable and RFC 2047 subjects are all handled
 *     there, in one parser, tested there. Duplicating any of it here would mean a mailed invoice
 *     and the same invoice dropped in a watched folder taking different code paths, which is
 *     exactly what CONCEPT §5.3 says must not happen: every source feeds the same pipeline.
 *   - **Stage 8 files it.** `MailRule`s compile into pipeline rules matching on `sender` and
 *     `subject` (see `rules.ts`), so the rule engine's conflict detection and stable ordering apply
 *     to mail as to everything else.
 *
 * What is genuinely this source's own work: fetching the header block *before* the body so a
 * newsletter costs nothing to ignore; decoding that header block from a charset the message may not
 * have declared; and doing nothing to the mailbox — not a flag, not a move — until the bytes have
 * been re-read out of the content store and re-hashed.
 */
import type {
  DocumentSourceKind,
  HealthReport,
  IngestCandidate,
  IngestOutcome,
  IngestRef,
  IngestRule,
  JsonObject,
} from '@recueil/ingest';

import { ReviewQueueService, ensureIngestSchema } from '@recueil/ingest';

import { evidenceForConsume } from '../consume.js';
import { SourceError, SourceProtocolError } from '../errors.js';
import { sourceState } from '../state.js';
import type { SourceStateStore } from '../state.js';
import { DEFAULT_MAX_SOURCE_BYTES } from '../types.js';
import { subjectDocumentId } from '../verify.js';
import type {
  Acknowledgement,
  CommonSourceOptions,
  ConsumePolicy,
  IngestSource,
  SkippedEntry,
  SourceContext,
  SourcePage,
} from '../types.js';
import { ImapClient } from './client.js';
import type { ImapClientOptions, ImapMailboxStatus } from './client.js';
import { addressList, addressOf, headerValue, parseHeaderBlock } from './headers.js';
import { evaluateMailRules, toIngestRules } from './rules.js';
import type { MailEnvelope, MailRule, MailRuleOutcome } from './rules.js';

export interface ImapSourceOptions extends CommonSourceOptions, ImapClientOptions {
  /** Default `INBOX`. */
  mailbox?: string;
  /**
   * The `UID SEARCH` criteria. Default `UNSEEN`, which is the concept sentence's "unseen messages".
   *
   * `ALL` is legitimate for a dedicated ingestion mailbox where the state table, rather than the
   * flag, is the record of what has been done.
   */
  search?: string;
  mailRules?: readonly MailRule[];
  /**
   * Set `\Seen` once the ingest is verified. Default true.
   *
   * It happens after the verification for the same reason a delete does: a message marked read by
   * a failed ingest is a message nobody will come back to.
   */
  markSeen?: boolean;
  /** How many messages to take in one poll. Default 25. */
  batchSize?: number;
  /**
   * Most bytes of header block this source will decode for one message. Default 1 MiB.
   *
   * The header block is fetched before the body precisely so that a newsletter costs nothing to
   * ignore, and `parseHeaderBlock` decodes the whole of it into a string to do that. RFC 5322 caps
   * a header *line*, not the block, so a message with a hundred thousand `Received:` lines is
   * legal and a hostile one is unbounded; a megabyte is far above anything a mail server produces
   * and far below anything worth stalling a poll for (ADR-0022 §2).
   */
  maxHeaderBytes?: number;
}

const DEFAULT_BATCH = 25;
const DEFAULT_MAX_HEADER_BYTES = 1024 * 1024;

/**
 * Failures of `uidOf` that replaying will never fix.
 *
 * A UIDVALIDITY change or an unreadable reference means the message this row names does not exist
 * and cannot be made to; retrying for ever is not resilience, it is a stuck source.
 */
const PERMANENT_REFERENCE_FAILURES = new Set(['source_changed', 'source_bad_reference']);

/**
 * The reason code a refused acknowledgement raises (P3, `spec/data-model.md` §6.1).
 *
 * The same string the other two sources use, because it is the same failure — the far side is not
 * what it was when the candidate was offered — and an operator filtering the queue should not have
 * to know which source raised it.
 */
export const SOURCE_CHANGED_BEFORE_CONSUME = 'source_changed_before_consume';

export class ImapSource implements IngestSource {
  readonly kind = 'poll' as const;
  readonly id: string;
  readonly sourceKind: DocumentSourceKind;
  readonly rules: readonly IngestRule[];
  readonly mailbox: string;

  private readonly options: ImapSourceOptions;
  private readonly policy: ConsumePolicy;
  private readonly mailRules: readonly MailRule[];
  /** ADR-0022: every source reads under a bound, and the bound has a default (see `types.ts`). */
  private readonly maxBytes: number;
  private client: ImapClient | null = null;
  private status: ImapMailboxStatus | null = null;
  private state: SourceStateStore | null = null;

  constructor(options: ImapSourceOptions) {
    this.options = options;
    this.mailbox = options.mailbox ?? 'INBOX';
    this.id = options.id ?? `imap://${options.username}@${options.host}/${this.mailbox}`;
    this.sourceKind = options.sourceKind ?? 'imap';
    this.policy = options.consume ?? { mode: 'leave' };
    this.mailRules = options.mailRules ?? [];
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.rules = [...toIngestRules(this.id, this.mailRules), ...(options.rules ?? [])];
  }

  /** No network here: §6.4 says `start` must not block on it, so the connection is made on demand. */
  async start(ctx: SourceContext): Promise<void> {
    this.state = sourceState(ctx.recueil);
    ctx.log({
      level: 'info',
      message:
        `mailbox '${this.mailbox}' on ${this.options.host} will be polled with ` +
        `'${this.options.search ?? 'UNSEEN'}' and the '${this.policy.mode}' consume policy`,
    });
  }

  async poll(request: { cursor?: string; limit: number }, ctx: SourceContext): Promise<SourcePage> {
    const client = await this.ensure(ctx);
    const state = this.stateFor(ctx);
    const skipped: SkippedEntry[] = [];

    const uids = await client.uidSearch(this.options.search ?? 'UNSEEN');
    const batch = uids.slice(0, Math.min(request.limit, this.options.batchSize ?? DEFAULT_BATCH));
    const heads = await client.fetchHeads(batch);

    const candidates: IngestCandidate[] = [];
    for (const head of heads) {
      const externalId = this.externalId(head.uid);
      const revision = `size:${String(head.byteSize ?? 0)}`;

      if (state.isHandled(this.id, externalId, revision)) {
        skipped.push({ externalId, reason: 'already ingested, per the source state table' });
        continue;
      }
      // `RFC822.SIZE` is the server's declaration, so it is a fast rejection and never the bound;
      // `ImapClient`'s own running total is what actually stops an oversized FETCH (ADR-0022 §1).
      if ((head.byteSize ?? 0) > this.maxBytes) {
        skipped.push({
          externalId,
          reason: `the message is ${String(head.byteSize)} bytes, over the ${String(this.maxBytes)}-byte limit`,
        });
        continue;
      }
      const maxHeaderBytes = this.options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
      if (head.headers.byteLength > maxHeaderBytes) {
        skipped.push({
          externalId,
          reason:
            `its header block is ${String(head.headers.byteLength)} bytes, over the ` +
            `${String(maxHeaderBytes)}-byte limit this source decodes under`,
        });
        continue;
      }

      const headers = parseHeaderBlock(head.headers);
      const envelope: MailEnvelope = {
        from: headerValue(headers, 'from'),
        subject: headerValue(headers, 'subject'),
        recipients: [...addressList(headerValue(headers, 'to')), ...addressList(headerValue(headers, 'cc'))],
      };

      // One evaluation, under the bounded matcher (ADR-0022 §4). `refusals` is the clause that
      // could not be decided inside its budget: it is carried onto the candidate rather than
      // dropped, so a subject built to stall the poll ends up in front of a person (P3) instead of
      // being quietly treated as "no rule matched".
      const evaluation = evaluateMailRules(this.mailRules, envelope);
      const skip = evaluation.skip;
      if (evaluation.refusals.length > 0) {
        skipped.push({
          externalId,
          reason: refusalSummary(evaluation.refusals),
        });
      }
      if (skip !== null) {
        // Recorded rather than flagged: refusing to ingest a newsletter is not a licence to touch
        // the user's mailbox. The row is what stops it being considered again.
        state.recordOutcome({
          sourceId: this.id,
          ref: { sourceId: this.id, externalId, revision },
          outcome: { status: 'stopped', reasonCode: 'mail_rule_skip', explanation: `rule '${skip.id}'` },
        });
        state.recordAcknowledgement({
          sourceId: this.id,
          externalId,
          action: 'left',
          detail: `mail rule '${skip.id}' skips messages like this one`,
          verified: false,
        });
        skipped.push({ externalId, reason: `mail rule '${skip.id}' skips it` });
        continue;
      }

      candidates.push(this.candidate(head.uid, head, envelope, headers, ctx, evaluation));
    }

    if (uids.length > batch.length) {
      skipped.push({
        externalId: `(${String(uids.length - batch.length)} message(s))`,
        reason: 'the batch was full; they will be offered on the next poll',
      });
    }

    return { candidates, more: uids.length > batch.length, skipped };
  }

  async fetch(ref: IngestRef, ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }> {
    const client = await this.ensure(ctx);
    const uid = this.uidOf(ref.externalId);
    const bytes = await client.fetchMessage(uid);
    if (bytes === null) {
      throw new SourceError(
        'source_vanished',
        `Message ${String(uid)} is no longer in '${this.mailbox}'.`,
        { uid },
      );
    }
    return { bytes, mediaType: 'message/rfc822' };
  }

  async acknowledge(
    ref: IngestRef,
    outcome: IngestOutcome,
    ctx: SourceContext,
  ): Promise<Acknowledgement> {
    const evidence = await evidenceForConsume({
      recueil: ctx.recueil,
      outcome,
      ...(this.options.consumeOn === undefined ? {} : { consumeOn: this.options.consumeOn }),
    });
    if (!evidence.allowed) {
      return { action: evidence.action, detail: evidence.detail, verified: false };
    }

    const client = await this.ensure(ctx);

    // A UID is only a name inside the UIDVALIDITY it was issued under (RFC 3501 §2.3.1.1), and a
    // mailbox that has been recreated has renumbered everything. `uidOf` refuses that, and it used
    // to refuse it by throwing out of `acknowledge` — which the runner records as an errno and
    // leaves the state row `pending` for ever, so every later run replays it, throws again and
    // reports `ok: false`, with nothing in the review queue and no way out. It is a permanent
    // condition, not a transient one, so it is a refusal (P3): the mailbox is untouched, the row
    // closes, and a person is told which message can no longer be identified. A network failure
    // from `ensure` above still throws, because that one *is* worth retrying.
    let uid: number;
    try {
      uid = this.uidOf(ref.externalId);
    } catch (error) {
      if (error instanceof SourceError && PERMANENT_REFERENCE_FAILURES.has(error.code)) {
        this.flagForReview(ctx, ref, outcome, error.message);
        return { action: 'refused', detail: `the mailbox was left alone: ${error.message}`, verified: false };
      }
      throw error;
    }

    // The flag first: a message that is moved and then fails to be flagged is at least in the right
    // place, whereas a message flagged and then not moved is merely read. Both orders are safe to
    // repeat, which is what §6.4 asks of an acknowledgement.
    let marked = false;
    if (this.options.markSeen !== false) marked = await client.addFlags(uid, ['\\Seen']);

    if (this.policy.mode === 'leave') {
      return marked
        ? {
            action: 'marked',
            detail: `flagged \\Seen after verification: ${evidence.detail}`,
            verified: true,
          }
        : { action: 'left', detail: evidence.detail, verified: true };
    }

    if (this.policy.mode === 'move') {
      await client.createMailbox(this.policy.to);
      const result = await client.moveMessage(uid, this.policy.to);
      return result === 'absent'
        ? {
            action: 'vanished',
            detail: `message ${String(uid)} was already out of '${this.mailbox}'`,
            verified: true,
          }
        : {
            action: 'moved',
            detail: `moved to '${this.policy.to}' after verification: ${evidence.detail}`,
            verified: true,
          };
    }

    if (!client.has('UIDPLUS')) {
      // Also permanent, and also previously a throw that left the row pending for ever. The
      // deployment has to change the policy; replaying the same call every minute will not help.
      const reason =
        'the server has no UIDPLUS, so a single message cannot be expunged without expunging ' +
        'every other message flagged \\Deleted in the mailbox; use consume `move` instead';
      this.flagForReview(ctx, ref, outcome, reason);
      return { action: 'refused', detail: `the mailbox was left alone: ${reason}`, verified: false };
    }
    await client.addFlags(uid, ['\\Deleted']);
    const expunged = await client.command(`UID EXPUNGE ${String(uid)}`);
    if (!expunged.ok) {
      throw new SourceProtocolError(`UID EXPUNGE ${String(uid)} failed: ${expunged.text}`);
    }
    return {
      action: 'deleted',
      detail: `expunged after verification: ${evidence.detail}`,
      verified: true,
    };
  }

  async stop(_ctx: SourceContext): Promise<void> {
    const client = this.client;
    this.client = null;
    this.status = null;
    if (client !== null) await client.logout();
  }

  async health(ctx: SourceContext): Promise<HealthReport> {
    const checkedAt = ctx.now();
    try {
      const client = await this.ensure(ctx);
      const ok = await client.noop();
      return {
        status: ok ? 'ok' : 'degraded',
        message: ok ? `connected to ${this.options.host}, '${this.mailbox}' selected` : 'NOOP was refused',
        checkedAt,
        detail: {
          mailbox: this.mailbox,
          exists: this.status?.exists ?? null,
          uidValidity: this.status?.uidValidity ?? null,
          move: client.has('MOVE'),
          uidplus: client.has('UIDPLUS'),
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  /* ---------------------------------------------------------------------------------------- */

  private candidate(
    uid: number,
    head: { byteSize: number | null; internalDate: string | null },
    envelope: MailEnvelope,
    headers: Record<string, string[]>,
    ctx: SourceContext,
    /** The single rule evaluation this message got. Never re-run: it is bounded work, not free. */
    evaluation: MailRuleOutcome,
  ): IngestCandidate {
    const externalId = this.externalId(uid);
    const ref: IngestRef = {
      sourceId: this.id,
      externalId,
      revision: `size:${String(head.byteSize ?? 0)}`,
    };

    const metadata: JsonObject = {
      ...(this.options.sourceMetadata ?? {}),
      mailbox: this.mailbox,
      uid,
      uidValidity: this.status?.uidValidity ?? null,
      // Both spellings, because `RuleMatch.sender` reads `sourceMetadata.from` or `.sender`.
      from: envelope.from,
      sender: addressOf(envelope.from),
      subject: envelope.subject,
      to: envelope.recipients,
      date: headerValue(headers, 'date'),
      messageId: headerValue(headers, 'message-id'),
      matchedMailRules: evaluation.matched.map((rule) => rule.id),
      // A clause the bounded matcher would not decide travels with the candidate, so the rule
      // that could not be evaluated is visible on the document rather than only in the poll log.
      mailRuleRefusals: evaluation.refusals.map(
        (refusal) => `${refusal.ruleId}.${refusal.clause}: ${refusal.reason}`,
      ),
    };

    return {
      ref,
      sourceKind: this.sourceKind,
      suggestedFilename: filenameFor(envelope.subject, uid),
      mediaType: 'message/rfc822',
      observedAt: internalDateToIso(head.internalDate) ?? ctx.now(),
      sourceMetadata: metadata,
      read: async () => (await this.fetch(ref, ctx)).bytes,
    };
  }

  /**
   * Route a refusal to the review queue (P3).
   *
   * The same shape as the other two sources: the subject is the document that *was* filed, because
   * that is the library record an operator can act from, and a failure to raise is logged and
   * swallowed so that a data-safe refusal never becomes a throw.
   */
  private flagForReview(
    ctx: SourceContext,
    ref: IngestRef,
    outcome: IngestOutcome,
    reason: string,
  ): void {
    const documentId = subjectDocumentId(outcome);
    if (documentId === null) return;
    try {
      ensureIngestSchema(ctx.recueil.connection);
      new ReviewQueueService(ctx.recueil.db, ctx.recueil.audit).raise({
        subjectType: 'document',
        subjectId: documentId,
        reasonCode: SOURCE_CHANGED_BEFORE_CONSUME,
        explanation:
          `The '${this.policy.mode}' consume policy was refused for '${ref.externalId}' in ` +
          `'${this.mailbox}' on ${this.options.host} because ${reason}. Nothing was flagged, ` +
          'moved or expunged. This entry is here because a source that had to refuse is worth a ' +
          'person knowing about.',
        proposedAction: 'none',
        severity: 'warning',
        sourceStage: 'source.acknowledge',
        actor: ctx.recueil.actor,
      });
    } catch (error) {
      ctx.log({
        level: 'warn',
        message: `the refusal could not be queued for review: ${error instanceof Error ? error.message : String(error)}`,
        externalId: ref.externalId,
      });
    }
  }

  private async ensure(ctx: SourceContext): Promise<ImapClient> {
    if (this.client !== null && this.client.connected) return this.client;

    // A client whose socket has gone still holds one; drop it before opening another, so a server
    // that closes idle connections does not leave a handle behind on every poll.
    this.client?.close();
    this.client = null;

    const client = new ImapClient({
      ...this.options,
      // One number rather than two that can disagree: the client's ceiling is this source's, plus
      // the margin `ImapClient` documents for the response text around a message.
      maxResponseBytes: this.options.maxResponseBytes ?? this.maxBytes + 32 * 1024 * 1024,
    });
    await client.connect();
    await client.login();
    const status = await client.select(this.mailbox);

    // A UIDVALIDITY change means every UID in the state table now names a different message, or
    // nothing at all (RFC 3501 §2.3.1.1). Saying so is the only safe answer: silently reusing the
    // old ids would acknowledge the wrong mail.
    const previous = this.status;
    if (previous !== null && previous.uidValidity !== status.uidValidity) {
      ctx.log({
        level: 'warn',
        message:
          `UIDVALIDITY of '${this.mailbox}' changed from ${String(previous.uidValidity)} to ` +
          `${String(status.uidValidity)}; every UID now means something else`,
      });
    }

    this.client = client;
    this.status = status;
    return client;
  }

  /** `<uidvalidity>/<uid>`: a UID means nothing without the validity it was issued under. */
  private externalId(uid: number): string {
    return `${this.status?.uidValidity ?? '0'}/${String(uid)}`;
  }

  private uidOf(externalId: string): number {
    const parts = externalId.split('/');
    const validity = parts.length > 1 ? parts[0] : null;
    const raw = parts[parts.length - 1] ?? '';
    const uid = Number.parseInt(raw, 10);
    if (Number.isNaN(uid) || uid <= 0) {
      throw new SourceError('source_bad_reference', `'${externalId}' is not a mailbox UID.`);
    }
    if (
      validity !== null &&
      this.status?.uidValidity !== undefined &&
      this.status.uidValidity !== null &&
      validity !== this.status.uidValidity
    ) {
      throw new SourceError(
        'source_changed',
        `UID ${String(uid)} was issued under UIDVALIDITY ${validity} and the mailbox is now at ` +
          `${this.status.uidValidity}; the message it named no longer exists.`,
        { externalId, uidValidity: this.status.uidValidity },
      );
    }
    return uid;
  }

  private stateFor(ctx: SourceContext): SourceStateStore {
    this.state ??= sourceState(ctx.recueil);
    return this.state;
  }
}

/** Informational only — `@recueil/ingest` never uses a suggested filename as a path. */
/**
 * One line for the poll log naming every clause that ran out of budget, and the limit it hit.
 *
 * ADR-0022 §6: exceeding a budget is a reported outcome, never a silent skip. This is the reporting
 * half; the candidate carries the same list into the pipeline.
 */
const refusalSummary = (refusals: MailRuleOutcome['refusals']): string =>
  `${refusals.length} mail-rule clause(s) could not be decided within their budget and were ` +
  `treated as not matching: ${refusals
    .map((refusal) => `'${refusal.ruleId}'.${refusal.clause} (${refusal.reason})`)
    .join('; ')}`;

const filenameFor = (subject: string | null, uid: number): string => {
  const stem = (subject ?? '')
    .replace(/[ -/\\:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return `${stem === '' ? `message-${String(uid)}` : stem}.eml`;
};

/** `INTERNALDATE` is `"01-Feb-2026 09:14:22 +0100"`, which `Date.parse` does not read. */
const internalDateToIso = (value: string | null): string | null => {
  if (value === null) return null;
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/u.exec(value);
  if (match === null) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const [, day, month, year, hour, minute, second, zone] = match;
  const offset = zone === undefined ? '+0000' : zone;
  const iso = Date.parse(
    `${String(day).padStart(2, '0')} ${String(month)} ${String(year)} ${String(hour)}:${String(minute)}:${String(second)} ${offset}`,
  );
  return Number.isNaN(iso) ? null : new Date(iso).toISOString();
};
