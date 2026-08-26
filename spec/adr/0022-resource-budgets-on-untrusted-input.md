# 0022 — Resource budgets on untrusted input

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** Phase 0 (governs every phase)

## Context

Recueil's ingestion inputs are hostile by construction. CONCEPT.md §5.3 accepts files from a watched
folder, a WebDAV share, a scanner and — decisively — an IMAP mailbox. Mail arrives from strangers.
A reference manager that verifies other people's bibliographies also accepts other people's PDFs.

The Phase 2 adversarial review turned three of these into working denial of service against the
shipped code:

- `readZipEntry` computed every limit from `entry.uncompressedSize`, a 32-bit field the attacker
  writes into the central directory, then called `inflateRawSync` with no `maxOutputLength` and
  compared the length only after the buffer was fully materialised. An 815 KB archive was accepted.
- `extractPdfText` inflated every `stream`…`endstream` pair with no per-stream budget, no
  accumulated budget and no archive limits (a PDF is not an archive, so nothing applied). A 299 KB
  PDF added 914 MB of resident memory; a 1.94 MB PDF passed 2 GB. Synchronous, so the event loop
  stopped with it.
- Mail rules compiled to native `RegExp` and ran `.test()` on the decoded `Subject:` and `From:`
  headers inside the poll loop. A 33-character subject line cost 45 seconds; the growth was
  exponential in the header length.

The rule engine already had a regex timeout, added in Phase 2 because the brief demanded it. The
mail path did not, because it was written by a different agent from a brief that did not mention it.
The protection existed and was simply not everywhere it needed to be.

## Decision

Every code path that decompresses, parses, expands or matches attacker-influenced input runs under
an explicit resource budget, enforced by the call itself rather than checked afterwards.

1. **Declared sizes are input, not fact.** Any length, count or offset read out of a file being
   parsed is attacker-controlled. It may inform a fast rejection; it may never be the only bound.
2. **Bound the operation, not the result.** Decompression passes `maxOutputLength` (or the streaming
   equivalent with a running total that aborts). Checking the size after materialising the buffer is
   not a bound — the damage is already done.
3. **Budgets compose and accumulate.** A per-member budget without a per-container budget permits a
   thousand small members. Nesting depth, total output, total members and wall-clock all carry
   limits, and a nested container inherits the remaining budget rather than a fresh one.
4. **Pattern matching over untrusted text is bounded.** Either a non-backtracking engine or an
   enforced timeout, on every path, with no exceptions for "internal" rules — a mail rule is written
   by the operator but runs against a subject line written by a stranger.
5. **Nothing unbounded runs synchronously on the request or poll loop.** Where a budget cannot be
   enforced in-process, the work moves to a worker with a wall-clock kill.
6. **Exceeding a budget is a review-queue outcome, not a crash and not a silent skip.** P3 applies:
   the file is flagged with the reason, and the run continues.

Budgets are configuration with conservative defaults, surfaced in one place rather than scattered as
literals, so an operator with a 900 MB legitimate scan can raise them knowingly.

## Consequences

Every parser and decompressor gains a budget parameter and a test that drives it past the limit and
asserts a clean refusal. Legitimate large files can be refused by a default that is too tight, which
is why the defaults are configuration and why the refusal names the limit it hit.

This ADR is cross-cutting and applies to work not yet written: the GROBID and OCR adapters, the
Phase 3 resolvers parsing third-party API responses, the Phase 5 graph expansion with its per-source
quotas, and any Phase 7 systematic-review import of a database export.
