# `@recueil/ingest-sources`

Where documents come from: the watched folder, the WebDAV feed and the IMAP mailbox of
[CONCEPT.md §5.3](../../CONCEPT.md), each implementing the `ingestSource` hook of
[`spec/hooks.md` §6.4](../../spec/hooks.md) and each feeding `@recueil/ingest`.

```
  a folder          a WebDAV share        a mailbox
       │                  │                   │
       └────────┬─────────┴─────────┬─────────┘
                │                   │
           IngestCandidate      IngestRef
                │                   │
                ▼                   ▼
        @recueil/ingest — the ten stages of §5.3
                │
                ▼
        Document · Item · Note · review queue
```

A source **never hashes, never stores and never creates an Item** (P2). It produces candidates and
bytes; everything downstream belongs to the pipeline. That is why a mailed invoice and the same
invoice dropped into a watched folder take exactly the same path through OCR, metadata extraction,
the rule engine and the confidence gate.

## Using it

```ts
import { createRecueil } from '@recueil/core';
import { IngestPipeline } from '@recueil/ingest';
import { FolderSource, SourceRunner } from '@recueil/ingest-sources';

const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });

const source = new FolderSource({
  root: '/srv/consume',
  consume: { mode: 'move', to: 'processed' },
});

// A source may contribute stage-8 rules — an ImapSource compiles its mail rules into them — and the
// pipeline takes its rules at construction, so they are wired up here.
const pipeline = new IngestPipeline({ recueil, rules: source.rules });
const runner = new SourceRunner({ source, pipeline, recueil });

await runner.start();
runner.watch({ intervalMillis: 60_000 });   // filesystem events, plus a sweep in case one is missed

const report = await runner.runOnce();
if (!report.ok) {
  console.error(report.acknowledgements.filter((entry) => entry.action === 'refused'));
}
```

## The rule all three share

**Nothing on the far side is moved, deleted or flagged until the bytes have been re-read out of the
content store, re-hashed, and matched against their `documents` row.**

A `delete` policy destroys the only other copy of a file, so the evidence for it has to be queried
rather than assumed. `verifyOutcome` (see `src/verify.ts`) does two things that a status code cannot:

1. It **queries `documents`** for a row at the digest. A pipeline outcome that says `ingested` is the
   pipeline's own account of itself.
2. It **re-reads the blob and hashes it**. The path a content-addressed store keeps a blob at is a
   claim about its contents; a truncated write, a full disk or a botched restore all leave a file
   whose name asserts a digest its bytes do not have.

Both have to agree. When they do not, the failure is reported with the numbers in it, the original
stays exactly where it is, and the acknowledgement is recorded as `refused`, which is not treated as
"handled" — so the next run tries again.

`consumeOn` decides which outcomes the policy acts on. It defaults to `ingested`, `duplicate`,
`review` and `container`; `stopped` and `failed` are deliberately excluded, because a document the
pipeline refused is precisely the one whose copy on the far side may be the last one.

## Crash safety

The gap between "the pipeline committed" and "the mail has been moved out of the inbox" is a crash
window, and `spec/hooks.md` §6.4 requires that `acknowledge` be safe to deliver twice. The runner
writes a state row into that window before touching the far side:

| Moment of the crash | What survives | What the next run does |
|---|---|---|
| During the poll | Nothing was claimed | Polls again; the cursor was never advanced |
| Mid-pipeline | The run's journal and `open_run_label` | Resumes the *same* run, skipping stages that finished |
| After commit, before `acknowledge` | A state row with `acknowledgement = 'pending'` | Replays exactly that acknowledgement, nothing else |
| During `acknowledge` | The same pending row | Replays it; each source answers `vanished` where the work was in fact done |

Duplication is prevented twice over: the pipeline is idempotent by `(sha256, sourceId, externalId)`
and answers a second arrival of the same bytes at stage 2, and the state table stops a source
offering an arrival it has already finished with.

## `FolderSource`

A directory somebody — or something — drops files into.

**Stability.** A file still being written is not offered. Two stats a short interval apart must agree
on size and mtime, *and* the last write must be at least `quietMillis` ago; the check is made again
at read time, because the gap between deciding a file has settled and opening it is a gap a slow
writer can fill. Ingesting a file mid-copy is the mistake content-addressed identity makes permanent:
the half file hashes differently, so it is filed for ever as a different document from the whole one.

What this cannot do, plainly: a writer that stalls for longer than `quietMillis` mid-file and then
resumes will be read while incomplete. The defences against that are conventions — the
partial-name suffixes the scan refuses (`.part`, `.crdownload`, `.filepart`, `~$…`, and the rest),
and the write-then-rename that well-behaved producers use. Prefer a producer that renames.

**Safety.** Every name is resolved with `realpath` and checked to be inside the watched root before
it is opened; a symlink pointing out of the folder is reported by name rather than followed. The
same check is applied to an `externalId` coming back out of the state table.

**Recovery.** A poll reads the tree rather than a queue of events, so everything that appeared while
the process was down is found by the first poll. The watcher is only a hint that makes the poll
prompt; a missed event costs a delay, never a document.

```ts
new FolderSource({
  root: '/srv/consume',
  recursive: true,
  stability: { quietMillis: 5_000, pollMillis: 500 },
  consume: { mode: 'move', to: 'processed' },   // relative paths are inside the watched root
  watch: { debounceMillis: 300, sweepMillis: 30_000 },
});
```

## `WebDavSource`

The Nextcloud-share path. Polled, not watched.

**What has been seen is `(path, etag, size)`.** The revision is the ETag where the server gives one
and `lastModified:size` where it does not. Either is only a hint that the content changed; identity
remains the SHA-256 the pipeline computes, so a server that recycles ETags costs a re-ingest that
stage 2 recognises as a duplicate, never a wrong document.

**An `href` in a listing is hostile until checked.** A `PROPFIND` answer is a document written by the
far side. Any `href` on another origin, or outside the polled collection, or containing a `..`
segment after decoding, is refused and the poll fails loudly rather than fetching it.

**The bytes may change between the listing and the read.** When the `GET` comes back with an ETag
that is not the one the candidate was offered under, the read is refused and the file is offered
again under its new revision.

Uploads: Nextcloud assembles a chunked upload into its final name in one move, so a file that is
visible is complete, and `stability` is off by default. A plain `mod_dav` target has no such
guarantee — set `stability: { quietMillis: 5_000 }`, and `requireSecondSighting: true` if even the
`Last-Modified` cannot be trusted.

```ts
new WebDavSource({
  url: 'https://cloud.example/remote.php/dav/files/rh/Inbox',
  auth: { kind: 'basic', username: 'rh', password: process.env.DAV_PASSWORD ?? '' },
  consume: { mode: 'move', to: 'filed' },
  stability: { quietMillis: 5_000 },
});
```

There is a WebDAV *storage backend* in `@recueil/storage-backends`. That is a different job — it
writes blobs by digest into a store — and the two share no code on purpose: a bug in the feed must
not be able to reach the store.

## `ImapSource`

CONCEPT §5.3: "IMAP mailbox (attachments as Documents, body as Note, rules by sender/subject)".

The division of labour matters here more than anywhere else:

- **This source produces one candidate per message**, carrying the whole RFC 5322 message and
  `message/rfc822` as its media type.
- **`@recueil/ingest` does the rest.** Stage 3 recognises the message as an archive, walks the MIME
  tree, writes each attachment to scratch and re-enters it at stage 1 as a Document of its own, and
  puts the text body on the proposal as a Note. Multipart, `multipart/related` with inline images,
  nested `message/rfc822` forwards, base64, quoted-printable and RFC 2047 subjects are all handled
  there, in one parser, so a mailed PDF and a dropped PDF are the same document.
- **Stage 8 files it.** `MailRule`s compile into pipeline rules matching on `sender` and `subject`,
  which is why the rule engine's conflict detection and stable ordering apply to mail as well.

What is genuinely this source's own work:

**Headers before bodies.** `poll` fetches `BODY.PEEK[HEADER]` and applies the `skip` rules, so a
newsletter costs a header block rather than forty megabytes. `fetch` pulls the full message only for
the candidates the pipeline actually wants.

**Charsets that are not declared.** A header block is bytes. If it is valid UTF-8 it is decoded as
UTF-8; if it is not, it is decoded as ISO-8859-1, which cannot fail — never as a replacement
character, because a mojibake subject can still be matched and read and `U+FFFD` cannot. Encoded
words are decoded after that. All three spellings of `Rückfrage` a German mailbox produces — the
legal encoded word, raw UTF-8 and raw Latin-1 — come out the same.

**Nothing is touched until the ingest verifies.** `\Seen` is set, and the message moved or expunged,
only after `verifyOutcome` passes; a message marked read by a failed ingest is a message nobody
comes back to. A message a rule skipped is recorded in the state table rather than flagged: refusing
to ingest a newsletter is not a licence to change somebody's mailbox.

**Capabilities are honoured, not assumed.** `UID MOVE` where the server has RFC 6851, otherwise
`UID COPY` + `\Deleted` + `UID EXPUNGE` — and the fallback refuses to run without UIDPLUS, because a
bare `EXPUNGE` would delete every message another client had flagged `\Deleted`. Against such a
server, use `consume: { mode: 'leave' }` and let the flag do the bookkeeping.

```ts
new ImapSource({
  host: 'imap.example.org',
  port: 993,
  secure: true,
  username: 'rh',
  password: process.env.IMAP_PASSWORD ?? '',
  mailbox: 'INBOX/Scans',
  search: 'UNSEEN',
  consume: { mode: 'move', to: 'INBOX/Filed' },
  mailRules: [
    { id: 'newsletters', match: { from: 'newsletter@' }, actions: { skip: true } },
    {
      id: 'utilities',
      match: { from: 'stadtwerke\\.example', subject: 'Rechnung' },
      actions: { itemType: 'invoice', addTags: ['utilities'] },
    },
  ],
});
```

## The scanner path (Brother ADS-4700W)

CONCEPT §5.3 lists the scanner as a source, and then defines it as `ADS-4700W →
folder/SFTP/WebDAV/mail`. That is deliberate: **the scanner path is a configuration of the three
sources above, not a fourth source.** Nothing in this package knows what a Brother is. What the
device gives you is a choice of destination, and each destination lands on one of these:

| Destination on the device | Lands in | Source to configure |
|---|---|---|
| Scan to Network (SMB/CIFS) — a share on the server | a directory | `FolderSource` |
| Scan to FTP / SFTP — an account on the server | a directory | `FolderSource` |
| Scan to SharePoint / a WebDAV endpoint | a remote collection | `WebDavSource` |
| Scan to E-mail Server (SMTP) — a mailbox you own | a mailbox | `ImapSource` |
| Scan to USB, or the desktop "Scan to PC" utility | a directory that a sync client mirrors | `FolderSource` on the synced directory |

Check which of these your firmware actually offers; the menu names vary by model and version.

In every case, set `sourceKind: 'scanner'` so that `documents.source_kind` records where the paper
came from and the stage-8 rules can match on it:

```ts
// Scan to Network, the simplest and the most reliable of the four.
const scanner = new FolderSource({
  id: 'scanner:ads-4700w',
  root: '/srv/scanner/ads4700w',
  sourceKind: 'scanner',
  // The device streams a duplex job as it scans, so give it room to finish over a slow link.
  stability: { quietMillis: 5_000, pollMillis: 500 },
  consume: { mode: 'move', to: 'processed' },
  sourceMetadata: { device: 'Brother ADS-4700W', location: 'study' },
});
```

```ts
// Scan to E-mail Server, when the scanner cannot reach the server directly.
const scanner = new ImapSource({
  host: 'imap.example.org',
  username: 'scans',
  password: process.env.SCAN_MAILBOX_PASSWORD ?? '',
  mailbox: 'INBOX',
  sourceKind: 'scanner',
  consume: { mode: 'move', to: 'INBOX/Filed' },
  mailRules: [
    // The device's own From address; anything else in this mailbox is not a scan.
    { id: 'not-the-scanner', match: { from: '^(?!.*ads4700w@)' }, actions: { skip: true } },
  ],
});
```

Two practical notes, both about the device rather than about this package:

- **Separator sheets.** If you use them, give the pipeline a stage-8 rule with a `stop` action
  matching the text they carry, so the blank page is refused rather than filed. The rule language is
  in `@recueil/ingest`.
- **File naming.** The device's name for the file (`ADS4700W_20260819_091422.pdf`) reaches the
  library as `documents.original_filename` and as `sourceMetadata.path`, so a rule can match on it.
  It is never used as a path and never decides identity.

## What is proven, and what is not

The tests run against a temporary directory, an in-process WebDAV server and an in-process IMAP
server, all on loopback. No container is needed and none is used, and no test touches a real host:
the two Nextcloud servers and the two mail accounts on the author's machine are not test targets.

That buys a great deal — a listing that names a path outside its own collection, an ETag that
changes between the poll and the read, a store that has rotted under a committed document, a crash
between the commit and the acknowledgement — none of which a real server will perform on request.

`test/mail-corpus.test.ts` adds the other half for the mailbox: all eight committed messages in
`fixtures/mail/`, seeded into the fake server and polled by the real `ImapSource`, asserted against
the counts `fixtures/expected-counts.json` fixed before the pipeline existed. It is what checks that
attachments become documents under the names the messages gave them, that bodies become notes, that
a forwarded message is descended into, that a message carrying one traversal filename is refused
*whole* rather than partly extracted, and that a sender rule reaches the item — including the
awkward material the hand-written tests do not carry: an RFC 2231 continued filename, a subject that
is not valid UTF-8, and a multipart whose closing boundary is missing.

It does **not** buy a compatibility claim. A fake written by the same hand as the client cannot prove
interoperability with Nextcloud, ownCloud, `mod_dav`, Dovecot, Cyrus, Exchange or Proton Bridge. The
Phase 1 review's finding applies: *a compatibility claim needs a captured fixture from the real
thing.* What would settle it, for each target, is a captured trace — a real `PROPFIND` response, a
real `FETCH` response with its literals — checked into `fixtures/` and replayed against the client.
Until those exist, the honest statement is: this implements what RFC 4918 and RFC 3501 require of
the methods it uses, and it has been tested against a server that does the same.

Also not attempted, and named so nobody assumes otherwise: IMAP `IDLE` (the poll is the whole
story), `STARTTLS` on port 143 (the choice is implicit TLS on 993 or a plain socket, which is for
loopback and tests), `CONDSTORE`/`QRESYNC`, OAuth 2 (`AUTHENTICATE XOAUTH2`), S/MIME and PGP
verification (encrypted and signed payloads pass through as the attachments they are), WebDAV
locking, and the `PROPPATCH` half of the protocol.

`SourceRunner` is not the job runner of ADR-0010 either. It polls, it counts consecutive failures so
a source can be shown as degraded, and it will not run twice at once — but the leases, the backoff
curve and the scheduling belong to the job runner, and this class is what that will call.

One path is reasoned about rather than tested: `FolderWatcher`'s per-directory fallback, for
platforms without a recursive `fs.watch`. The tests run on Linux under Node 22 or later, where the
recursive watch is available and is what they exercise. The fallback matters less than it looks,
because the watcher only ever asks the runner to poll, and the sweep covers a watcher that sees
nothing at all.

## Layout

```
src/types.ts          the `ingestSource` contract of spec/hooks.md §6.4
src/verify.ts         the two-sided check that gates every consume policy
src/consume.ts        policy + evidence → may the original be touched?
src/state.ts          what a source remembers: seen, pending, cursor, open run
src/runner.ts         poll → run → record → acknowledge, and the crash recovery
src/folder/           scan.ts (safe walk) · stability.ts · watcher.ts · source.ts
src/webdav/           client.ts (six methods, no dependency) · source.ts
src/imap/             client.ts (literal-aware) · headers.ts · rules.ts · source.ts
test/fakes/           an in-process WebDAV feed server and an in-process IMAP server
test/mail-corpus.test.ts   fixtures/mail/, end to end, against fixtures/expected-counts.json
```

Licence: AGPL-3.0-or-later.
