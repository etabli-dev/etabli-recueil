# `@recueil/ingest`

The ingestion pipeline of [CONCEPT.md §5.3](../../CONCEPT.md): the ten stages every file passes
through on its way into the library, whichever of the eight sources it came from.

```
 1 hash, size, MIME                → SHA-256, byte count and a sniffed media type, from the bytes
 2 exact duplicate check           → link to the existing document, log, stop
 3 archive extraction (zip, eml)   → members to scratch; each re-enters at stage 1
 4 type detection                  → scholarly PDF · scan · office document · image
 5 OCR when there is no text layer → behind `OcrEngine`
 6 metadata extraction             → behind `MetadataExtractor`: GROBID, or the office heuristics
 7 identifier resolution           → identifiers found and, where a resolver exists, checked
 8 rule engine                     → item type, collection, tags, custom fields
 9 confidence gate                 → auto-accept, or a review entry with the reason (P3)
10 single-transaction commit       → item, attachment, facets, index; then events
```

Every anchor is a hook point, `before` and `after`, per
[`spec/hooks.md` §6.5](../../spec/hooks.md) — a plugin can insert a stage without this package
knowing it exists.

## Using it

```ts
import { createRecueil } from '@recueil/core';
import { IngestPipeline, folderCandidates } from '@recueil/ingest';

const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
const pipeline = new IngestPipeline({ recueil });

const { candidates, skipped } = await folderCandidates('/srv/consume');
const report = await pipeline.run(candidates, { runLabel: '2026-08-22-nightly' });

console.log(report.counts);            // { ingested, duplicates, review, containers, stopped, failed }
if (!report.verification.pass) console.error(report.verification.checks);
for (const entry of skipped) console.warn(entry.path, entry.reason);
```

A single file — an API upload, a connector capture — is `pipeline.ingestOne(candidate)`.

Candidates come from `bufferCandidate`, `fileCandidate` and `folderCandidates`, or from anything
that satisfies `IngestCandidate`: the WebDAV feed, the mailbox and the scanner path are all sources
that produce candidates and let the pipeline own everything downstream (P2).

## The four properties CONCEPT §5.3 demands

**Idempotent by `(hash, source, path)`.** A second ingest of the same bytes finds the document at
stage 2, records the new *arrival* in `document_provenance` — a second arrival is a new fact
(P4) — and stops without a second document and without a second item. Re-running a whole run is
safe; re-running it under the same `runLabel` resumes it, and a new label re-scans.

**Resumable.** Stages 1 to 8 write a checkpoint to `ingest_checkpoints`, and stage 10 writes the
terminal one. An interrupted run picks up at the first stage that never finished, so a run
interrupted after a twenty-minute OCR pass does not pay for it twice. Stages 1 to 7 are replayed
from their stored output; stage 8 is always re-evaluated, because the rules may have been edited
between the two attempts and a resumed run should obey the current ones.

Three things are deliberately *not* checkpointed as complete, because each would make a resumed run
skip work it still owes: a candidate that failed, an archive expansion with a failed member, and a
container whose members did not all finish.

**Configurable concurrency, conservative default.** Two, from `DEFAULT_INGEST_CONFIG`. A watched
folder pointed at a decade of scans will otherwise saturate a single-user box's disk and, with a
real OCR worker attached, its CPU; the failure mode of too much concurrency is a server that stops
answering.

**Scratch cleaned after hashing, even on failure.** Extraction happens in a directory the run owns
and deletes in a `finally`. `report.scratchClean` states whether the root ended up empty rather than
assuming it. A `finally` does not run after `SIGKILL`, so the start of every run also sweeps
abandoned roots left by processes that are no longer running — by owner, never by age, so a
concurrent run's scratch is never mistaken for a crashed one's (`sweepAbandonedScratch`).

## Flag, never guess (P3)

Stage 9 compares the running confidence against `confidenceThreshold` (0.75 by default). Above it,
the item is created. Below it — or when two rules disagree, or when a rule could not be evaluated at
all because its pattern ran out of budget, or when a plugin stage asks — a
`review_queue` row is written carrying the machine-readable reason, a sentence a person can read,
and `proposed_payload`: exactly the request body that accepting the entry will execute
([`spec/data-model.md` §6.1](../../spec/data-model.md), RQ1).

The confidence is a ledger, not a number, so the explanation says *what* the pipeline was unsure
about:

> The pipeline was not confident enough to file this document on its own: the score is 0.36: it
> looks like a scholarly pdf (+0.10), fake-metadata read 1 field(s) (+0.06), it looks like a paper
> but carries no identifier (-0.15). The threshold is 0.75.

`review_queue` is specified in `spec/data-model.md` §6.1 and assigned there to core's
`0002_ingestion` migration, which core has not written yet. Until it does, this package installs the
table itself, idempotently, with §6.1's column list verbatim (`src/db/install.ts`). The day core
adopts it, the install becomes a no-op and the module can be deleted.

## The sidecars

CONCEPT §5.1 makes OCRmyPDF and GROBID optional sidecars, and **no test in this package requires
either**. A test suite that needs a container is a test suite nobody runs. Both live behind an
interface with a real adapter and an in-process fake:

| Stage | Interface | Real adapter | In-process fake |
|---|---|---|---|
| 5 · OCR | `OcrEngine` | `OcrMyPdfEngine` | `FakeOcrEngine` |
| 6 · metadata | `MetadataExtractor` | `GrobidExtractor` | `FakeMetadataExtractor` |
| 6 · metadata | `MetadataExtractor` | `OfficeHeuristicExtractor` — real, no sidecar, tested | — |
| 7 · resolution | `IdentifierResolver` | *(Phase 3)* | `FixtureResolver` |

### Turning the real ones on

```ts
import { GrobidExtractor, IngestPipeline, OcrMyPdfEngine, OfficeHeuristicExtractor } from '@recueil/ingest';

const pipeline = new IngestPipeline({
  recueil,
  ocr: new OcrMyPdfEngine({ binary: 'ocrmypdf', languages: ['eng', 'deu'] }),
  extractors: [
    new GrobidExtractor({ baseUrl: 'http://localhost:8070', mode: 'fulltext' }),
    new OfficeHeuristicExtractor(),
  ],
});
```

Both adapters report their sidecar's state through `health()`, so an operator can check the wiring
before pointing a watched folder at it:

```ts
console.log(await new OcrMyPdfEngine().health());
console.log(await new GrobidExtractor({ baseUrl: 'http://localhost:8070' }).health());
```

`OcrMyPdfEngine.binary` may be a wrapper script around `docker run --rm -i jbarlow83/ocrmypdf "$@"`;
the adapter only needs something that takes the documented arguments on `argv`.
`deploy/docker-compose.yml` carries the sidecar profiles.

### What is and is not proven

Being precise about this, because an untested adapter that looks tested is worse than one that
admits it:

- **`OcrMyPdfEngine` is untested against a real OCRmyPDF in this repository.** It is written from
  the documented command-line interface of OCRmyPDF 16 and has not been run against one here.
- **`GrobidExtractor`'s transport is untested against a real GROBID in this repository.** It is
  written against GROBID 0.8's documented REST API.
- **`parseTeiHeader` — GROBID's TEI, turned into a proposal — *is* tested**, against a TEI document
  written by hand to the documented shape. That proves the parser reads what it claims to read; it
  does not prove GROBID emits that shape. Making the compatibility claim real means capturing a TEI
  response from a live GROBID into `fixtures/grobid/` and testing the parser against that fixture,
  which is a change to the test and not to the parser.
- Everything else — the ten stages, the archive readers, the path checks, the rule engine, the
  confidence gate, the review queue, the resume journal and the office heuristics — is covered by
  the suite, against a real SQLite library and a real content store.

## Archive containers

A `.eml` is content: the message is the thing, its body becomes a Note and its envelope fills the
Office facet, so the message is kept as a Document and its attachments become Documents of their
own with `parent_document_id` pointing at it. Nesting is followed: a forwarded message inside a
message is expanded, and the PDF inside *that* becomes a Document two levels down.

The message parser is hand-written (`src/archive/eml.ts`) and reads RFC 2047 encoded words in
headers and RFC 2231 extended and continued parameters — `filename*=utf-8''…`, and the numbered
`filename*0*` / `filename*1*` form Thunderbird and Outlook emit for a long non-ASCII filename.
That last one is not a nicety: without it the part arrives as `part-2.bin` and nobody finds it
again. `fixtures/mail/two-attachments.eml` carries exactly that case and
`packages/ingest-sources/test/mail-corpus.test.ts` asserts the name survives. Still deliberately
absent: S/MIME and PGP verification (signed and encrypted payloads pass through as the attachments
they are, unverified and marked so) and `message/partial` reassembly.

A `.zip` is a lorry. Keeping it means keeping every member's bytes twice, so by default it is *not*
kept, and each member instead records `sourceDetail.archive` — the archive's digest, the member's
name, the archive's filename — so the provenance survives without the storage. Change it with:

```ts
new IngestPipeline({ recueil, storeArchiveContainers: { zip: true } });
```

An archive the reader **could not** open is always kept, whatever this setting says, together with a
review entry naming the problem. Losing the only copy of a file because the reader did not
understand it would be the worst available trade.

## Untrusted input

A name inside an archive, a filename on a mail part and a path inside a watched folder are all
strings a stranger chose. Every one of them is **resolved and then checked to be inside its root**
before any I/O — never sanitised, because sanitising has to anticipate the next encoding trick and
resolving does not. An archive containing a traversal entry is refused whole rather than partially
extracted, and a symlink in a watched folder that points outside it is reported rather than read.

The archive limits in `IngestConfig` — member count, per-member size, total size, expansion ratio —
are checked against the *declared* sizes before a single member is inflated, and again against the
actual sizes as they come out.

## Extending it

A stage:

```ts
import { IngestStageRegistry } from '@recueil/ingest';

const stages = new IngestStageRegistry([
  {
    id: 'barcode-reader',
    anchor: 'metadata_extraction',
    position: 'before',
    priority: 10,
    async run(input) {
      const isbn = readBarcode(await input.bytes());
      return isbn === null
        ? { action: 'continue' }
        : {
            action: 'continue',
            patch: { fields: { 'bibliographic.isbn': { value: isbn, provenance: { source: 'barcode', fetchedAt: new Date().toISOString(), confidence: 0.9 } } } },
            confidenceDelta: 0.2,
          };
    },
  },
]);
```

A rule, as the data an operator edits:

```json
{
  "id": "swu-invoices",
  "priority": 10,
  "match": { "sourceKind": ["imap"], "sender": "@swu\\.example$", "text": "Gesamtbetrag" },
  "actions": { "itemType": "invoice", "addTags": ["utilities"], "confidenceDelta": 0.3 }
}
```

`parseRules` validates a rule set — including whether its regular expressions compile — and reports
every problem rather than throwing on the first, because a rule set that reports one error per save
is a rule set nobody finishes editing. Two rules that want different values for the same
single-valued field are a **conflict**: it is reported and routed to review, never resolved by sort
order.

`@recueil/rules` is being built alongside this package as the fuller, versioned, traced rule engine
of CONCEPT §5.6, with a linear-time regular-expression engine and a dry run. Stage 8 is behind a
one-method seam so adopting it is a constructor argument rather than a rewrite:

```ts
new IngestPipeline({ recueil, ruleEngine: myEvaluator }); // anything with evaluate(RuleSubject)
```

Until that swap happens the two rule formats are separate, and a rule set written for one is not
automatically valid for the other.

## Deviations from the spec, stated

`spec/hooks.md` §6.5 says a stage "runs inside the pipeline's transaction (stage 10 is the commit)".
Stages 1 and 2 cannot: hashing and storing the bytes are asynchronous, the content store is not
transactional, and `documents` has to exist before the duplicate check can query it. So:

- the `documents` row and its `document_provenance` arrival are committed at stage 2;
- everything written to the *library* — item, attachment, facets, creators, tags, collections,
  custom fields, notes, and the review entry when the gate fails — is one transaction at stage 10,
  with each service call nesting as a savepoint;
- a crash between the two leaves a Document with no Item, which `spec/data-model.md` D4 explicitly
  permits ("an ingested file not yet filed, sitting in the review queue") and which the resume
  journal finishes.

`extractPdfText` reads text-showing operators out of uncompressed and `FlateDecode` content streams.
For a PDF whose fonts use a standard single-byte encoding — LaTeX, Word, Quarto, any browser's print
to PDF — that is the text. For a CID font or a subset font with a custom encoding it returns less
than the page shows. It is used for the *OCR gate*, where "did anything come out at all" is the
question, not as an authoritative extraction; PDF.js arrives with the reader in Phase 4 and a
`MetadataExtractor` behind it will outrank this.

## Licence

AGPL-3.0-or-later.
