# 0021 — A verification check queries both sides

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** Phase 0 (governs every phase)

## Context

Recueil makes claims that a person is expected to act on. The Zotero import report decides whether
the author's library may be retired. The Paperless report decides whether a container may be
deleted. The ingestion pipeline's `verify()` decides whether a run filed what it said it filed.

Three separate agents, working from three separate briefs, independently wrote the same defect into
these three reports: the check compared the source against **the importer's own record of what it
did**, rather than against the target database. Concretely:

- `attachment_records_carried` counted entries in `job_logs`, not rows in `attachments`.
- `item_count_parity_per_type` bucketed both sides through the importer's own mapping output, so
  rewriting every target row's `item_type` to `article` left the check passing.
- `item_count_parity` compared `plans.length` — what the importer chose to read — against the
  target, and every reader filtered `libraryID = 1`, so a Zotero group library was absent from both
  sides and the delta was structurally zero.
- `tag_assignments_carried` and `custom_field_values_carried` in the Paperless report added
  `skipped` counts, derived from the importer's own narration, to the target side of the comparison.
- `IngestPipeline.verify()` used `>=`, `>=`, `<=` — every inequality open in the direction that
  permits duplication — and derived `documentsWithoutAttachment` by subtraction, so it went negative
  when one document acquired two items, and no check could fail.

Each of these passed its own test suite. Each read, in a report a person would rely on, as evidence.

That it happened three times independently is the point. This is not a mistake somebody made; it is
the shape a self-check naturally collapses into when the thing being checked and the thing doing the
checking share a source of truth.

## Decision

A verification check MUST derive each side of its comparison from an independent source, and MUST be
able to fail.

Concretely, for any check that a report presents as evidence:

1. **Query, do not narrate.** The target side of a count comes from a query against the target
   database. Never from a log, a job record, a plan, an in-memory tally, or any structure the
   producing code also wrote.
2. **The source side comes from the source.** Not from what the reader chose to read. If a filter
   restricts what is read — a library id, a date range, a type allow-list — the check must count the
   unfiltered source and report the exclusion explicitly as a finding, never silently.
3. **Two-sided comparisons.** Equality checks assert equality. Where an inequality is genuinely
   correct, the ADR-bearing comment must state which direction is the failure and why the other
   direction is impossible. A count that can go negative is a bug, not a diagnostic.
4. **Every blocking check ships with a falsification test.** For each one, a test mutates the
   target — or the source — in the way the check exists to detect, and asserts the check FAILS.
   A blocking check with no failing test is not a check.
5. **A check that cannot fail must be deleted or downgraded.** If no mutation can make it fail, it
   is decoration, and decoration that reads as evidence is worse than nothing.

## Consequences

Reports become more expensive: a second set of queries, and a falsification test per blocking check.
That cost is the deliverable — CONCEPT.md §7 makes an import report the M1 and M2 exit criteria, and
a report that cannot fail cannot satisfy an exit criterion.

Existing reports are audited against this ADR in the hardening round (spec/hardening-2026-08.md,
workstream H5). New checks are reviewed against it. The adversarial review stage in each phase is
instructed to attack the checks themselves, not only the code they cover.
