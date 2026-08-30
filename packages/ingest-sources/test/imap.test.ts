/**
 * The mailbox, against an in-process IMAP server on a loopback port.
 *
 * The real accounts on this machine are not test targets and are never reached: every connection
 * here is to 127.0.0.1 on a port the kernel chose, and the messages are built in the test.
 *
 * The concept sentence being tested is "attachments as Documents, body as Note, rules by
 * sender/subject", and the three awkward cases named in the Phase 2 brief — multipart with an
 * inline image, a forwarded message with a nested attachment, and a subject that is not UTF-8 —
 * each get a test of their own.
 */
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImapClient, ImapSource, SourceRunner, sourceState } from '../src/index.js';
import type { IngestOutcome, MailRule } from '../src/index.js';
import {
  countDocuments,
  countItems,
  countNotes,
  documentDigests,
  invoiceLines,
  makeContext,
  makeEmail,
  makeLibrary,
  makePdf,
  makePipeline,
  noteBodies,
  onePixelPng,
} from './helpers.js';
import type { TestLibrary } from './helpers.js';
import { startFakeImap } from './fakes/imap-server.js';
import type { FakeImapServer } from './fakes/imap-server.js';

let library: TestLibrary;
let server: FakeImapServer;

beforeEach(async () => {
  library = makeLibrary();
  server = await startFakeImap();
});

afterEach(async () => {
  await server.close();
  library.dispose();
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const sourceFor = (options: Partial<ConstructorParameters<typeof ImapSource>[0]> = {}): ImapSource =>
  new ImapSource({
    host: server.host,
    port: server.port,
    secure: false,
    username: 'rh',
    password: 'secret',
    timeoutMillis: 10_000,
    ...options,
  });

describe('ImapSource', () => {
  it('turns two attachments and an inline image into documents, and the body into one note', async () => {
    const invoice = makePdf({ lines: invoiceLines({ correspondent: 'Stadtwerke Ulm', reference: 'R-77' }) });
    const terms = makePdf({ lines: ['Terms and conditions', 'Clause 1. Everything is fine.'] });
    const logo = onePixelPng();

    server.append(
      'INBOX',
      makeEmail({
        from: 'Stadtwerke Ulm <billing@stadtwerke.example>',
        subject: 'Ihre Rechnung R-77',
        body: 'Guten Tag,\r\n\r\nanbei die Rechnung und die AGB.\r\n\r\nMit freundlichen Gruessen',
        attachments: [
          { filename: 'logo.png', mediaType: 'image/png', bytes: logo, inline: true, contentId: 'logo@sw' },
          { filename: 'rechnung.pdf', mediaType: 'application/pdf', bytes: invoice },
          { filename: 'agb.pdf', mediaType: 'application/pdf', bytes: terms },
        ],
      }),
    );

    const source = sourceFor();
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.offered).toBe(1);

    const digests = documentDigests(library);
    expect(digests).toContain(sha256(invoice));
    expect(digests).toContain(sha256(terms));
    expect(digests).toContain(sha256(logo));
    // The three parts plus the message itself, which is kept because an `.eml` is content.
    expect(countDocuments(library)).toBe(4);

    expect(countNotes(library)).toBe(1);
    expect(noteBodies(library)[0]).toContain('anbei die Rechnung');
  });

  it('keeps a subject that is not UTF-8 readable, in both the legal and the illegal form', async () => {
    // The legal form: an RFC 2047 encoded word in ISO-8859-1.
    server.append(
      'INBOX',
      makeEmail({
        from: 'Kanzlei <post@kanzlei.example>',
        subject: '=?ISO-8859-1?Q?R=FCckfrage_zur_Rechnung?=',
        body: 'Kurze Rueckfrage.',
      }),
    );
    // The illegal but extremely common form: raw 8-bit bytes, here Latin-1, with no declaration.
    server.append(
      'INBOX',
      makeEmail({
        from: 'Amt <amt@example.org>',
        subject: 'Grundsteuerbescheid für Ulm',
        body: 'Anbei.',
        headerCharset: 'latin1',
      }),
    );

    const source = sourceFor();
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    await source.stop(context);

    const subjects = page.candidates.map((candidate) => candidate.sourceMetadata?.['subject']);
    expect(subjects).toContain('Rückfrage zur Rechnung');
    expect(subjects).toContain('Grundsteuerbescheid für Ulm');
  });

  it('expands a forwarded message with a nested attachment', async () => {
    const scan = makePdf({ lines: ['Scanned letter', 'Aktenzeichen 4711'] });
    const inner = makeEmail({
      from: 'Absender <absender@example.org>',
      subject: 'Original mit Anhang',
      body: 'Der Anhang ist beigefuegt.',
      attachments: [{ filename: 'scan.pdf', mediaType: 'application/pdf', bytes: scan }],
    });
    server.append(
      'INBOX',
      makeEmail({
        from: 'Kollege <kollege@example.org>',
        subject: 'Fwd: Original mit Anhang',
        body: 'Zur Kenntnis.',
        attachments: [
          { filename: 'weitergeleitet.eml', mediaType: 'message/rfc822', bytes: inner },
        ],
      }),
    );

    const source = sourceFor();
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    await runner.runOnce();
    await runner.stop();

    // The PDF inside the forwarded message reached the library with its own digest, which is the
    // whole point: a nested attachment is a Document like any other.
    expect(documentDigests(library)).toContain(sha256(scan));
    // The outer message, the forwarded message and the scan.
    expect(countDocuments(library)).toBe(3);
  });

  it('skips what a mail rule says to skip, without touching the mailbox', async () => {
    const rules: MailRule[] = [
      {
        id: 'newsletters',
        match: { from: 'newsletter@' },
        actions: { skip: true },
      },
    ];
    server.append('INBOX', makeEmail({ from: 'newsletter@shop.example', subject: 'Angebote', body: 'Kaufen!' }));
    const wanted = server.append(
      'INBOX',
      makeEmail({ from: 'billing@stadtwerke.example', subject: 'Rechnung', body: 'Anbei.' }),
    );

    const source = sourceFor({ mailRules: rules });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.offered).toBe(1);
    expect(report.skipped.some((entry) => entry.reason.includes("mail rule 'newsletters'"))).toBe(true);
    // The newsletter is still unread and still in the inbox: refusing to ingest something is not a
    // licence to change the user's mailbox.
    const newsletter = server.mailboxes.get('INBOX')?.[0];
    expect(newsletter?.flags.has('\\Seen')).toBe(false);
    expect(server.message('INBOX', wanted)?.flags.has('\\Seen')).toBe(true);
  });

  it('files by sender through the pipeline rule engine', async () => {
    const rules: MailRule[] = [
      {
        id: 'stadtwerke',
        match: { from: 'stadtwerke\\.example', subject: 'Rechnung' },
        actions: { addTags: ['utilities'], itemType: 'invoice' },
      },
    ];
    server.append(
      'INBOX',
      makeEmail({
        from: 'billing@stadtwerke.example',
        subject: 'Rechnung R-88',
        body: 'Anbei die Rechnung.',
        attachments: [
          {
            filename: 'r-88.pdf',
            mediaType: 'application/pdf',
            bytes: makePdf({ lines: invoiceLines({ correspondent: 'Stadtwerke', reference: 'R-88' }) }),
          },
        ],
      }),
    );

    const source = sourceFor({ mailRules: rules });
    const pipeline = makePipeline(library, { rules: source.rules });
    const runner = new SourceRunner({ source, pipeline, recueil: library });
    await runner.start();
    await runner.runOnce();
    await runner.stop();

    const tagged = library.connection
      .prepare(
        `select t.name as name, count(*) as n from item_tags it
           join tags t on t.id = it.tag_id
          group by t.name`,
      )
      .all() as Array<{ name: string; n: number }>;
    expect(tagged.map((row) => row.name)).toContain('utilities');
  });

  it('marks a message read only once the store has been verified', async () => {
    const uid = server.append(
      'INBOX',
      makeEmail({ from: 'a@example.org', subject: 'Nichts passiert', body: 'Text.' }),
    );

    const source = sourceFor();
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    const ref = page.candidates[0]?.ref;
    expect(ref).toBeDefined();

    const lie: IngestOutcome = {
      status: 'ingested',
      documentId: 'doc_nope',
      itemId: 'itm_nope',
      sha256: sha256(Buffer.from('nothing was ever stored')),
      confidence: 1,
    };
    const acknowledgement = await source.acknowledge(ref!, lie, context);
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(server.message('INBOX', uid)?.flags.has('\\Seen')).toBe(false);
  });

  it('moves a message to another mailbox after a verified ingest, and only then', async () => {
    const uid = server.append(
      'INBOX',
      makeEmail({
        from: 'post@amt.example',
        subject: 'Bescheid',
        body: 'Anbei.',
        attachments: [
          { filename: 'bescheid.pdf', mediaType: 'application/pdf', bytes: makePdf({ lines: ['Bescheid'] }) },
        ],
      }),
    );

    const source = sourceFor({ consume: { mode: 'move', to: 'Filed' } });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.acknowledgements.map((record) => record.action)).toEqual(['moved']);
    expect(server.mailboxes.get('INBOX')).toHaveLength(0);
    expect(server.mailboxes.get('Filed')?.map((message) => message.uid)).toEqual([uid]);
    expect(countItems(library)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to COPY, \\Deleted and UID EXPUNGE against a server without MOVE', async () => {
    const plain = await startFakeImap({ move: false });
    try {
      plain.append('INBOX', makeEmail({ from: 'a@example.org', subject: 'Ohne MOVE', body: 'Text.' }));
      const source = new ImapSource({
        host: plain.host,
        port: plain.port,
        secure: false,
        username: 'rh',
        password: 'secret',
        timeoutMillis: 10_000,
        consume: { mode: 'move', to: 'Filed' },
      });
      const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
      await runner.start();
      const report = await runner.runOnce();
      await runner.stop();

      expect(report.acknowledgements.map((record) => record.action)).toEqual(['moved']);
      expect(plain.mailboxes.get('INBOX')).toHaveLength(0);
      expect(plain.mailboxes.get('Filed')).toHaveLength(1);
      expect(plain.commands.some((line) => /UID COPY/u.test(line))).toBe(true);
      expect(plain.commands.some((line) => /UID EXPUNGE/u.test(line))).toBe(true);
    } finally {
      await plain.close();
    }
  });

  it('replays an interrupted acknowledgement without ingesting the message twice', async () => {
    server.append(
      'INBOX',
      makeEmail({
        from: 'a@example.org',
        subject: 'Genau einmal',
        body: 'Text.',
        attachments: [
          { filename: 'once.pdf', mediaType: 'application/pdf', bytes: makePdf({ lines: ['once'] }) },
        ],
      }),
    );

    const source = sourceFor({ consume: { mode: 'move', to: 'Filed' } });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    const realAcknowledge = source.acknowledge.bind(source);
    source.acknowledge = async () => {
      throw new Error('the process died before the move');
    };
    await runner.runOnce();

    const documentsAfterCrash = countDocuments(library);
    expect(documentsAfterCrash).toBe(2);
    expect(server.mailboxes.get('INBOX')).toHaveLength(1);
    expect(sourceState(library).pending(source.id)).toHaveLength(1);

    source.acknowledge = realAcknowledge;
    const recovered = await runner.runOnce();
    await runner.stop();

    expect(recovered.recovered.map((record) => record.action)).toEqual(['moved']);
    expect(recovered.offered).toBe(0);
    expect(countDocuments(library)).toBe(documentsAfterCrash);
    expect(server.mailboxes.get('Filed')).toHaveLength(1);
  });

  it('reports an unreachable server as unavailable rather than as an empty mailbox', async () => {
    const source = new ImapSource({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      username: 'rh',
      password: 'secret',
      timeoutMillis: 2_000,
    });
    const context = makeContext(library);
    const health = await source.health(context);

    expect(health.status).toBe('unavailable');
  });
});

describe('ImapSource, when the reference can never be resolved again (re-attack)', () => {
  const openReviews = (
    target: TestLibrary,
  ): Array<{ reason_code: string; explanation: string }> =>
    target.connection
      .prepare("select reason_code, explanation from review_queue where status = 'open'")
      .all() as Array<{ reason_code: string; explanation: string }>;

  /**
   * A UID means nothing without the UIDVALIDITY it was issued under (RFC 3501 §2.3.1.1). `uidOf`
   * refuses a stale one, and it refused it by throwing out of `acknowledge` — which the runner
   * records as an errno while the state row stays `pending` for ever, so every later run replays
   * it, throws again, and reports `ok: false` with nothing in the review queue and no way out.
   * It is a permanent condition, so it belongs in front of a person as a refusal (P3), with the
   * row closed.
   */
  it('refuses rather than throwing when the UID was issued under another UIDVALIDITY', async () => {
    const bytes = makePdf({ lines: ['an attachment worth keeping'] });
    server.append(
      'INBOX',
      makeEmail({
        from: 'post@amt.example',
        subject: 'Bescheid',
        body: 'Anbei.',
        attachments: [{ filename: 'b.pdf', mediaType: 'application/pdf', bytes }],
      }),
    );

    const source = sourceFor({ consume: { mode: 'delete' } });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    const candidate = page.candidates[0]!;
    const report = await makePipeline(library).run([candidate], {
      runLabel: 'imap-validity',
      sourceId: source.id,
      total: 1,
    });

    // The same message, named under the validity a recreated mailbox would have issued.
    const stale = {
      ...candidate.ref,
      externalId: `999/${candidate.ref.externalId.split('/').pop() ?? '1'}`,
    };
    const acknowledgement = await source.acknowledge(stale, report.outcomes[0]!.outcome, context);
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(acknowledgement.verified).toBe(false);
    expect(acknowledgement.detail).toContain('UIDVALIDITY');
    // The mailbox was not touched: nothing flagged, nothing expunged.
    expect(server.mailboxes.get('INBOX')).toHaveLength(1);
    expect(openReviews(library).map((row) => row.reason_code)).toContain(
      'source_changed_before_consume',
    );
  }, 30_000);

  it('refuses rather than throwing when the server cannot expunge one message', async () => {
    const plain = await startFakeImap({ uidplus: false, move: false });
    try {
      const bytes = makePdf({ lines: ['an attachment worth keeping'] });
      plain.append(
        'INBOX',
        makeEmail({
          from: 'post@amt.example',
          subject: 'Bescheid',
          body: 'Anbei.',
          attachments: [{ filename: 'b.pdf', mediaType: 'application/pdf', bytes }],
        }),
      );

      const source = new ImapSource({
        host: plain.host,
        port: plain.port,
        secure: false,
        username: 'rh',
        password: 'secret',
        timeoutMillis: 10_000,
        consume: { mode: 'delete' },
      });
      const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
      await runner.start();
      const report = await runner.runOnce();
      await runner.stop();

      expect(report.acknowledgements[0]?.action).toBe('refused');
      expect(report.acknowledgements[0]?.error).toBeUndefined();
      expect(report.acknowledgements[0]?.detail).toContain('UIDPLUS');
      expect(report.ok).toBe(false);
      expect(plain.mailboxes.get('INBOX')).toHaveLength(1);
      // The row closes as `refused` rather than staying `pending` for ever.
      expect(
        sourceState(library)
          .all(source.id)
          .map((row) => row.acknowledgement),
      ).toEqual(['refused']);
    } finally {
      await plain.close();
    }
  }, 30_000);
});

describe('ImapClient budgets (ADR-0022)', () => {
  it('refuses a declared literal over the limit before reading a byte of it', async () => {
    const client = new ImapClient({
      host: server.host,
      port: server.port,
      secure: false,
      username: 'rh',
      password: 'secret',
      timeoutMillis: 10_000,
      maxResponseBytes: 4096,
    });
    await client.connect();
    await client.login();
    await client.select('INBOX');

    server.append(
      'INBOX',
      makeEmail({
        from: 'a@example.org',
        subject: 'A message larger than the budget',
        body: 'x'.repeat(64 * 1024),
      }),
    );

    // The FETCH answer carries the message as a literal, and the literal is over the ceiling.
    await expect(client.fetchMessage(1)).rejects.toThrow(/limit this client reads under/u);
    client.close();
  }, 30_000);
});
