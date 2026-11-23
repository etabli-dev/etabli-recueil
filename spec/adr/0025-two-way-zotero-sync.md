# 0025 — Two-way sync with a zotero.org library

- **Status:** Accepted
- **Date:** 2026-11-21
- **Phase:** Step Z of the transition plan (before Phase 3)
- **Amends:** ADR-0001 and principle P1, for this one bridge only

## Context

The Zotero path so far is one-way and local: `recueil import zotero` reads a copy of `zotero.sqlite`,
never writes to it and never talks to zotero.org (CONCEPT §6). That is enough to *leave* Zotero, and
it is the M1 criterion. It is not enough to live with Zotero during a long transition: co-authors
share group libraries on zotero.org, the Zotero iOS app and the Word plugin read from there, and
anything filed in Recueil is invisible to all of them.

The owner has asked for two-way sync with their Zotero account. P1 says the server is the source of
truth and there is no sync engine. Both remain true *inside* Recueil; what this ADR adds is a bridge
between Recueil and one other system that is also a source of truth.

## Decision

`@recueil/sync-zotero` synchronises one Recueil library with one or more zotero.org libraries (the
user library and any group libraries the key can write to) through the Zotero Web API v3.

1. **What is synchronised.** Regular items (bibliographic fields, creators, tags, collection
   membership, `Extra`), collections and their hierarchy, child notes, attachments with their files,
   and the trash state. Saved searches, annotations inside Zotero's PDF reader and relations are
   pulled when present and not pushed in this step.
2. **Identity.** A link table, `zotero_sync_links`, maps `(library, object type, Zotero key)` to a
   Recueil row. Items that came from `recueil import zotero` are adopted on the first run by their
   `source_id`, because a library synced to zotero.org has the same keys locally and online.
3. **Change detection on both sides.** Zotero: library versions (`?since=`,
   `Last-Modified-Version`, `/deleted`). Recueil: every link keeps the Zotero JSON last agreed on
   (the *base*). A side has changed a field when its current value, projected into a common shape,
   differs from the base projected the same way. The projection is what makes normalisation
   harmless: a DOI that Recueil lower-cases is not a change.
4. **Three-way merge, per field.** For each field: only Zotero changed → Zotero's value; only
   Recueil changed → Recueil's value; both changed to the same value → that value; both changed to
   different values → a **conflict**. Tags and collection memberships merge as sets (additions and
   removals from both sides apply). Fields Recueil has no column for stay exactly as the base holds
   them, so a push never drops data Recueil does not model.
5. **Conflicts.** The policy is configurable: `review` (default) leaves both values unchanged on both
   sides and puts a conflict record in the sync report and review queue; `zotero` or `recueil` picks
   a side for every conflict. A field the user has locked in Recueil (P4) is never overwritten by a
   pull; a remote change to it is a conflict.
6. **Writes to Zotero are conditional.** Every object is written with its last known version, so
   Zotero refuses (412) a write that would overwrite an edit made since. A refusal triggers a pull of
   that object and a re-merge, never a blind retry. Batches are at most 50 objects, `Backoff` and
   `Retry-After` are obeyed, and every batch carries a `Zotero-Write-Token` so a repeated request
   cannot create duplicates.
7. **Deletion is conservative.** Zotero's trash and Recueil's trash map onto each other. An object
   permanently deleted on zotero.org goes to Recueil's trash, never further. A permanent deletion in
   Recueil is pushed only with `--propagate-purge`.
8. **Files.** Downloads are checked against the MD5 Zotero states before they become documents.
   Uploads use Zotero's authorisation-upload-register procedure. Files over a configurable size limit
   are skipped and reported.
9. **The API key** is read from an environment variable or a file. It is never stored in the
   database, never logged, and never sent anywhere but `api.zotero.org`.
10. **Dry run first.** `--dry-run` computes the full plan of both directions and writes the report
    without writing to either side.

## Consequences

- Recueil's own clients still do not sync with each other; P1 holds for them.
- The first run against a real account is a dry run by the owner, then a pull-only run, then a full
  run. That order is part of the CLI's help text.
- The sync depends on Zotero's API staying stable. The client is written against the documented v3
  behaviour and pinned with `Zotero-API-Version: 3`; the fake server in the test suite is the
  contract it is tested against.
