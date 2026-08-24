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

import { evidenceForConsume } from '../consume.js';
import { SourceError, SourceProtocolError } from '../errors.js';
import { sourceState } from '../state.js';
import type { SourceStateStore } from '../state.js';
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
import { matchingMailRules, skippedBy, toIngestRules } from './rules.js';
import type { MailEnvelope, MailRule } from './rules.js';

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
}

const DEFAULT_BATCH = 25;

export class ImapSource implements IngestSource {
  readonly kind = 'poll' as const;
  readonly id: string;
  readonly sourceKind: DocumentSourceKind;
  readonly rules: readonly IngestRule[];
  readonly mailbox: string;

  private readonly options: ImapSourceOptions;
  private readonly policy: ConsumePolicy;
  private readonly mailRules: readonly MailRule[];
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
      if (this.options.maxBytes !== undefined && (head.byteSize ?? 0) > this.options.maxBytes) {
        skipped.push({
          externalId,
          reason: `the message is ${String(head.byteSize)} bytes, over the ${String(this.options.maxBytes)}-byte limit`,
        });
        continue;
      }

      const headers = parseHeaderBlock(head.headers);
      const envelope: MailEnvelope = {
        from: headerValue(headers, 'from'),
        subject: headerValue(headers, 'subject'),
        recipients: [...addressList(headerValue(headers, 'to')), ...addressList(headerValue(headers, 'cc'))],
      };

      const skip = skippedBy(this.mailRules, envelope);
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

      candidates.push(this.candidate(head.uid, head, envelope, headers, ctx));
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
    const uid = this.uidOf(ref.externalId);

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
      throw new SourceError(
        'source_unsupported',
        'The server has no UIDPLUS, so a single message cannot be expunged without expunging ' +
          "every other message flagged \\Deleted in the mailbox. Use consume `move` instead.",
      );
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
      matchedMailRules: matchingMailRules(this.mailRules, envelope).map((rule) => rule.id),
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

  private async ensure(ctx: SourceContext): Promise<ImapClient> {
    if (this.client !== null && this.client.connected) return this.client;

    // A client whose socket has gone still holds one; drop it before opening another, so a server
    // that closes idle connections does not leave a handle behind on every poll.
    this.client?.close();
    this.client = null;

    const client = new ImapClient(this.options);
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
