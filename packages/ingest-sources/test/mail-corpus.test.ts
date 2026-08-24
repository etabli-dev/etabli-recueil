/**
 * The mail path against the repository's own corpus — `fixtures/mail/`, all eight messages.
 *
 * `imap.test.ts` builds its messages in the test, which is the right shape for asserting one
 * behaviour at a time but leaves the eight committed `.eml` files unread by anything. A corpus
 * nothing consumes is a corpus that proves nothing, so this file is the other half: the fixtures go
 * into a real IMAP server on a loopback port, the real `ImapSource` polls it, and the concept
 * sentence — "attachments as Documents, body as Note, rules by sender/subject" — is asserted
 * against the counts `fixtures/expected-counts.json` stated *before* the pipeline existed.
 *
 * Both sides of every count are queried. The Paperless side of this rule is `expected-counts.json`,
 * which was written by the fixture generator from a hand-written manifest and verified by an
 * independent parser (Python's `email`); the Recueil side is the target's own tables. Neither side
 * is the run report.
 *
 * The real accounts on this machine are never reached: every connection is to 127.0.0.1 on a port
 * the kernel chose.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImapSource, SourceRunner } from '../src/index.js';
import type { MailRule } from '../src/index.js';
import { countNotes, makeLibrary, makePipeline, noteBodies, type TestLibrary } from './helpers.js';
import { startFakeImap } from './fakes/imap-server.js';
import type { FakeImapServer } from './fakes/imap-server.js';

const FIXTURES = resolve(fileURLToPath(new URL('../../../fixtures', import.meta.url)));

interface MailExpectation {
  bytes: number;
  sha256: string;
  attachments: string[];
  inlineWithContentId: number;
  nestedMessages: number;
  subject: string;
  from: string;
}

const EXPECTED = JSON.parse(readFileSync(resolve(FIXTURES, 'expected-counts.json'), 'utf8')) as {
  ingest: { mail: { files: number; byFile: Record<string, MailExpectation> } };
};

const MAIL = EXPECTED.ingest.mail;
const FILES = Object.keys(MAIL.byFile).sort();

/**
 * The one message that must not be expanded.
 *
 * Its first attachment names `../../../../etc/cron.d/recueil-pwn.pdf`, and the rule the Phase 1
 * review paid for is that a container with one hostile member is refused *whole*: extracting the
 * four safe members and skipping the fifth would mean a person seeing four documents arrive and
 * concluding the message was handled.
 */
const HOSTILE = 'attachment-name-traversal.eml';

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

const seedInbox = (): Map<string, number> => {
  const uids = new Map<string, number>();
  for (const file of FILES) {
    uids.set(file, server.append('INBOX', readFileSync(resolve(FIXTURES, 'mail', file))));
  }
  return uids;
};

const sourceFor = (mailRules: readonly MailRule[] = []): ImapSource =>
  new ImapSource({
    host: server.host,
    port: server.port,
    secure: false,
    username: 'rh',
    password: 'secret',
    search: 'ALL',
    timeoutMillis: 10_000,
    ...(mailRules.length === 0 ? {} : { mailRules }),
  });

const runOnce = async (mailRules: readonly MailRule[] = []) => {
  const source = sourceFor(mailRules);
  // The pipeline takes its rules at construction and the source compiles its mail rules into them,
  // so the caller wires the two together — exactly as `recueil ingest watch` does through
  // `SourceRunner.rulesFor`. Forgetting this is how a mail rule becomes a silent no-op.
  const pipeline = makePipeline(library, { rules: SourceRunner.rulesFor(source) });
  const runner = new SourceRunner({ source, pipeline, recueil: library });
  await runner.start();
  const report = await runner.runOnce();
  await runner.stop?.();
  return report;
};

interface DocumentRow {
  id: string;
  sha256: string;
  mimeType: string;
  filename: string | null;
  parent: string | null;
}

const documents = (): DocumentRow[] =>
  library.connection
    .prepare(
      `select id, sha256, mime_type as mimeType, original_filename as filename, parent_document_id as parent
         from documents where trashed_at is null order by rowid`,
    )
    .all() as DocumentRow[];

describe('fixtures/mail, through a real IMAP server', () => {
  it('offers every message the corpus holds', async () => {
    const uids = seedInbox();
    expect(uids.size).toBe(MAIL.files);

    const report = await runOnce();
    expect(report.offered).toBe(MAIL.files);
    expect(report.ok).toBe(true);

    // Every message's own bytes are in the store under the digest the fixture manifest states.
    const stored = new Set(documents().map((row) => row.sha256));
    for (const file of FILES) {
      expect(stored, `${file} did not reach the store under its own digest`).toContain(
        MAIL.byFile[file]!.sha256,
      );
    }
  });

  it('turns every attachment into a document of its own, under the name the message gave it', async () => {
    seedInbox();
    await runOnce();

    const rows = documents();
    const attachmentNames = new Set(
      rows.filter((row) => row.parent !== null).map((row) => row.filename ?? ''),
    );

    const expectedNames: string[] = [];
    for (const [file, expectation] of Object.entries(MAIL.byFile)) {
      if (file === HOSTILE) continue;
      expectedNames.push(...expectation.attachments);
    }
    // The corpus's own claim, not a number this test chose.
    expect(expectedNames.length).toBeGreaterThan(0);

    for (const name of expectedNames) {
      expect(
        attachmentNames,
        `no document arrived for the attachment '${name}'; got ${[...attachmentNames].join(', ')}`,
      ).toContain(name);
    }

    // `two-attachments.eml` writes its second filename as RFC 2231 continuations
    // (`filename*0*=utf-8''…`). Losing that is not cosmetic: the document is then called
    // `part-2.bin` and nobody finds it again.
    expect(attachmentNames).toContain('Protokoll Sitzung 13. März 2023.pdf');

    // `inline-image.eml` carries one attachment and one inline part with a Content-ID; both are
    // bytes the library must hold, so both are documents.
    const inlineExpectation = MAIL.byFile['inline-image.eml']!;
    expect(inlineExpectation.inlineWithContentId).toBe(1);
    expect(attachmentNames).toContain('Beleg-2023-0912.png');
    expect(attachmentNames).toContain('logo.png');
  });

  it('descends into a forwarded message and files the attachment inside it', async () => {
    seedInbox();
    await runOnce();

    const expectation = MAIL.byFile['forwarded-nested.eml']!;
    expect(expectation.nestedMessages).toBe(1);

    const rows = documents();
    const message = rows.find((row) => row.sha256 === expectation.sha256);
    expect(message, 'the forwarded message itself is not in the library').toBeDefined();

    const nested = rows.find((row) => row.filename === 'Mietvertrag Lagerraum Nr. 14.eml');
    expect(nested, 'the forwarded message inside it never became a document').toBeDefined();
    expect(nested!.parent, 'the nested message is not filed under the message that carried it').toBe(
      message!.id,
    );

    const inner = rows.find((row) => row.filename === 'Mietvertrag-Lagerraum-14.pdf');
    expect(inner, 'the PDF inside the forwarded message never became a document').toBeDefined();
    expect(inner!.mimeType).toBe('application/pdf');
    // Two levels down: the archive recursion of stage 3 really recursed.
    expect(inner!.parent).toBe(nested!.id);
  });

  it('turns each message body into a note', async () => {
    seedInbox();
    await runOnce();

    // Seven messages are expanded; the eighth is refused whole and therefore has no body to keep.
    // The forwarded message contributes a second body, the one inside it.
    const bodies = noteBodies(library);
    expect(countNotes(library)).toBe(bodies.length);
    expect(bodies.length).toBe(FILES.length - 1 + MAIL.byFile['forwarded-nested.eml']!.nestedMessages);

    const joined = bodies.join('\n---\n');
    expect(joined, 'the plain-text message body is not in any note').toMatch(
      /die Überschreitung im Juli 2022/u,
    );
    expect(joined, 'the HTML-only message kept no body').toMatch(/Niedrigwasser/u);
  });

  it('refuses the traversal message whole, and plants nothing', async () => {
    seedInbox();
    await runOnce();

    const expectation = MAIL.byFile[HOSTILE]!;
    const rows = documents();

    // The message itself is kept — losing the only copy of something not understood is the worst
    // trade available — but not one of its members was extracted.
    expect(rows.some((row) => row.sha256 === expectation.sha256)).toBe(true);
    for (const name of expectation.attachments) {
      expect(
        rows.some((row) => row.filename === name),
        `'${name}' was extracted from a message that must be refused whole`,
      ).toBe(false);
    }

    const review = library.connection
      .prepare('select reason_code as code, explanation from review_queue')
      .all() as Array<{ code: string; explanation: string }>;
    const entry = review.find((row) => row.code === 'unsafe_archive_path');
    expect(entry, `no review entry names the refusal; got ${JSON.stringify(review)}`).toBeDefined();
    expect(entry!.explanation).toMatch(/recueil-pwn/u);
  });
});

describe('rules by sender and subject', () => {
  it('applies a sender rule to the item the message becomes', async () => {
    seedInbox();
    await runOnce([
      {
        id: 'stadtwerke',
        priority: 100,
        match: { from: 'stadtwerke-ulm\\.example' },
        actions: { itemType: 'invoice', addTags: ['Stadtwerke'] },
      },
    ]);

    // The two messages from that sender, by the corpus's own `from` field.
    const fromStadtwerke = FILES.filter((file) => /stadtwerke-ulm\.example/u.test(MAIL.byFile[file]!.from));
    expect(fromStadtwerke.length).toBe(2);

    const tagged = library.connection
      .prepare(
        `select i.item_type as itemType, t.name as tag, it.rule_ref as ruleRef, it.source as source
           from item_tags it
           join tags t on t.id = it.tag_id
           join items i on i.id = it.item_id
          where t.name = 'Stadtwerke'`,
      )
      .all() as Array<{ itemType: string; tag: string; ruleRef: string | null; source: string }>;

    expect(tagged.length, 'no item carries the tag the sender rule adds').toBeGreaterThanOrEqual(
      fromStadtwerke.length,
    );
    for (const row of tagged) {
      expect(row.itemType).toBe('invoice');
      // The assignment records that a rule put the tag there rather than a person.
      //
      // It does *not* yet record **which** rule: `item_tags.rule_ref` is documented in
      // `packages/core/src/db/schema.ts` as "the ingestion rule that applied it", and stage 10
      // leaves it null because `RuleEvaluation.addTags` is a list of strings that has already
      // forgotten the rule each tag came from. That is a P4 shortfall, and it is asserted here as
      // what the code does rather than papered over.
      expect(row.source).toBe('rule');
      expect(row.ruleRef).toBeNull();
    }
  });

  it('skips a message before its body is fetched when a rule says to', async () => {
    seedInbox();
    const newsletter = MAIL.byFile['html-multipart.eml']!;
    expect(newsletter.from).toMatch(/newsletter@example\.net/u);

    const report = await runOnce([
      {
        id: 'no-newsletters',
        priority: 200,
        match: { from: 'newsletter@example\\.net' },
        actions: { skip: true },
      },
    ]);

    expect(report.offered).toBe(MAIL.files - 1);

    const stored = documents().map((row) => row.sha256);
    expect(
      stored,
      'the skipped newsletter reached the store, so the rule was applied too late to save the fetch',
    ).not.toContain(newsletter.sha256);

    // And the fetch really was avoided: no command asked for that message's body.
    const uid = server.mailboxes.get('INBOX')!.find((message) =>
      message.raw.equals(readFileSync(resolve(FIXTURES, 'mail', 'html-multipart.eml'))),
    )!.uid;
    const bodyFetches = server.commands.filter(
      (command) => /UID FETCH/u.test(command) && command.includes(`${String(uid)} `) && /BODY(?!\.PEEK\[HEADER)/u.test(command),
    );
    expect(bodyFetches.every((command) => !/BODY\[\]/u.test(command))).toBe(true);
  });
});
