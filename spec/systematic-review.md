# Systematic review — Phase 7 specification

Status: accepted for Phase 7. Builds on CONCEPT §5.10, `spec/data-model.md` §8 (the schema
commitments) and ADR-020 (automation disclosure). Where this document and the data model disagree,
the data model's invariants hold and this document is wrong.

The goal of the phase, from CONCEPT §7: *a real review run start to finish; PRISMA flow exported
from live counts; extraction data loads in R without manual reshaping.*

## 1. Scope of v1

Solo-first. One screener per review; the second-screener columns (`screener_count = 2`,
`blind_mode`, `conflict_policy`, `is_conflict_resolution`) exist and are validated but no workflow
drives them yet.

| Step (CONCEPT build order) | v1 | Where |
|---|---|---|
| Review setup: protocol, PICO, registration, exclusion reasons, automation disclosure | yes | `ReviewService` |
| Search runs with PRISMA-S fields; import of RIS, MEDLINE/NBIB (PubMed), BibTeX, CSL-JSON, WoS plain text | yes | `@recueil/sr` import |
| Dedup with source tracking | yes | import (identifier) + `dedupReview` (fuzzy) |
| Title/abstract screening: keyboard, reasons, undo, progress | yes | service, API, web, CLI |
| Full-text retrieval status and full-text screening with mandatory reasons | yes | service, API, web, CLI |
| PRISMA counts live, snapshots, PRISMA2020 export | yes | `prismaCounts`, `freezePrisma`, CSV |
| Extraction forms over custom fields, repeatable groups, versions and locking | yes | `ExtractionService` |
| RoB instruments as JSON (RoB 2, ROBINS-I, NOS, QUADAS-2), robvis export | yes | `@recueil/sr` instruments |
| `meta`/`metafor`-ready extraction table | yes | long and wide CSV |
| Snowballing via deep dive | partial | `addSnowballed` records an item found from an included study; the automated deep dive waits for the job queue |
| Quarto report template | yes | `clients/r/inst/templates/sr-report.qmd` |
| Parquet export | no | waits for the analytics Parquet writer (Phase 5 deferral) |
| Unpaywall retrieval | no | retrieval status is recorded; the fetch itself is the enrichment resolvers' job and needs the job queue |

## 2. Units and the import path

**The unit PRISMA counts is a `review_records` row** — one record considered in one review. Every
record becomes an `items` row, so it gets enrichment, checks and attachments for free.

Import of one search export (`importSearch`):

1. The caller creates a `search_runs` row (database, interface, verbatim query, date, the number the
   database reported). `records_returned` is never recomputed (SR1).
2. The file is kept as a `documents` row and linked as `source_file_document_id`, so the search is
   reproducible from the library alone (P10). The CLI and the API store it; a caller that has no
   bytes (a direct OpenAlex query) leaves it null.
3. Each parsed record is matched to an existing item **by identifier** — DOI, then PMID — because
   two live items may not share a DOI (B1). A match reuses the item; no match creates one.
4. If the item already has a `review_records` row in this review (another database found it), a
   `review_record_sources` row is added to the existing record: that is deduplication with source
   tracking, and the record now counts in both databases' "identified" numbers. Otherwise a new
   `review_records` row is created with this run as its primary source.
5. `records_imported` is set to the number of records parsed; `duplicates_removed` is recomputed
   from the attributions after every import and dedup pass.

`dedupReview` then finds the duplicates identifiers cannot: same normalised title (similarity ≥
0.93), same year (±1) and compatible first author. The later record is marked `duplicate` with
`duplicate_of_id` pointing at the earlier one, which becomes `merged_master`. Duplicates are kept,
not deleted (RR3), and `undoDuplicate` reverses a wrong call. The library items are **not**
merged — a review must not rewrite the library; the owner can merge items separately.

## 3. Screening

- Decisions are append-only (SD1). A new decision on the same record, stage and screener
  supersedes the current one (`is_current = 0`, `superseded_by_id`); undo is a new row restoring
  the previous decision, or, when there was none, a supersession with no successor.
- Exclusion at full text requires a reason from the review's `exclusion_reasons` (the database
  enforces it too). Title/abstract exclusion takes an optional reason.
- `screening_status`, `exclusion_reason_code` and `stage` on `review_records` are caches of the
  current decisions (RR2), rewritten in the same transaction; a consistency check
  (`verifyCaches`) recomputes them and reports any difference.
- Full text is only offered for records that passed title/abstract (`include` or `maybe` — the
  inclusive rule) and whose retrieval status is `retrieved`. A record marked `not_retrieved` is
  counted in the PRISMA "not retrieved" box and leaves the flow.
- `tool_assisted` is set by the server from the actor (SD2): decisions written by an MCP token or
  a plugin are tool-assisted; decisions written by the user or a CLI token are not. When the review
  has `automation_disclosure` on, the audit export includes `tool_assisted` and `tool_detail`.
- Duplicates are not screened. A screening call on a duplicate is refused.

Record stages: `identified` → `deduplicated` (unique after dedup) → `title_abstract` (a current TA
decision exists) → `full_text` (a current FT decision exists) → `included` / `excluded`. A record
excluded at title/abstract has stage `excluded`.

## 4. PRISMA 2020 counts

Every number is a `COUNT` over `review_records` and `review_record_sources` (RR1). Let *U* be the
non-duplicate, non-snowballed records.

| `stage_key` | Definition |
|---|---|
| `records_identified_databases` | source rows whose run's `source_database` is a bibliographic database (everything except `registry`, `grey_literature`, `citation_search`, `manual`, `other`), on non-snowballed records; per-run rows carry `source_label` |
| `records_identified_registers` | the same for `registry` |
| `records_identified_other` | snowballed records, plus source rows from `grey_literature`, `citation_search`, `manual`, `other` |
| `records_removed_duplicates` | identified (databases + registers) − \|*U*\| |
| `records_removed_automation` | 0 in v1 (no automated exclusion before screening) |
| `records_removed_other` | 0 in v1 |
| `records_screened` | \|*U*\| |
| `records_excluded` | *U* with a current TA decision `exclude` |
| `reports_sought` | *U* whose current TA decision is `include` or `maybe` |
| `reports_not_retrieved` | of those, `retrieval_status = 'not_retrieved'` |
| `reports_assessed` | of those, a current FT decision exists |
| `reports_excluded` | current FT decision `exclude`; one row per reason with `exclusion_reason_code` |
| `studies_included` | distinct `COALESCE(study_group_key, id)` over FT `include` |
| `reports_of_included_studies` | FT `include` |

Snowballed records follow the same screening and are reported in the "other methods" column of the
diagram (`other_*` keys in the PRISMA2020 export).

`freezePrisma(label)` writes the current numbers to `prisma_counts` with `computed_by = 'frozen'`;
a snapshot is never recomputed (PC1), and a snapshot taken now equals the live numbers (PC2,
tested).

**Export.** `prismaCsv` writes the `data` and `n` columns the PRISMA2020 R package's
`PRISMA_data()` reads (the package's template CSV), so `PRISMA2020::PRISMA_flowdiagram()` draws
the diagram without edits. A plain SVG flow diagram is drawn by `prismaSvg` for quick looks.

## 5. Extraction

- A form (`extraction_forms`) is an ordered list of sections, each an ordered list of
  `custom_fields.field_key` references with per-form label, help text and requiredness (EF1). The
  fields themselves are ordinary custom fields with `scope = 'review'`; templates (`rct`,
  `observational`, `diagnostic`) create the fields they need when they do not exist.
- Repeatable groups (`arm`, `outcome`, `timepoint`) give `field_values.group_key` its prefix:
  `arm:intervention`, `outcome:mortality_30d`.
- Values are `field_values` rows with `review_id` and `extraction_form_id` set; the slot key
  includes the review, so the same item extracted in two reviews keeps two values.
- A form is `draft` until its first extraction is marked complete, then `locked` (EF2). Changing a
  locked form means `newVersion`; old values keep pointing at the version they were entered under.
- `extractionTable(reviewId, 'long')` is one row per value: `study`, `record_id`, `item_id`,
  `group`, `field`, `value`, `blank`. `'wide'` is one row per study × group with one typed column per
  field — the shape `metafor::escalc()` takes (`ai`, `bi`, `n1i`, … are just field keys).

## 6. Risk of bias

Instruments are JSON definitions shipped in `@recueil/sr` (`instruments/*.ts`): domains, signalling
questions with their answer options, and the judgement levels. The definition is copied into each
assessment (`instrument`), so a later revision cannot rewrite old judgements.

- The domain judgement is the assessor's; the instrument's algorithm proposes one from the
  signalling answers where the instrument publishes an algorithm in a form simple enough to encode
  (v1 encodes the RoB 2 rule "any domain high → overall high; any some concerns → overall some
  concerns" and the equivalent ROBINS-I worst-domain rule). Proposals are labelled as such.
- A new assessment of the same record, tool, outcome and assessor supersedes the current one.
- `robvisCsv(reviewId, tool)` writes `Study, D1 … Dn, Overall, Weight` with the judgement labels
  robvis expects (`Low`, `Some concerns`, `High`, `Critical`, `No information`, …), so
  `robvis::rob_summary(data, tool = "ROB2")` and `rob_traffic_light()` read it unmodified (RB1).

## 7. Surfaces

- **API** `/api/v1/reviews` (scopes `sr:read`, `sr:write`): reviews CRUD, search runs with
  import (multipart-free: the export text in a JSON body), records worklist, decisions and undo,
  retrieval status, dedup, PRISMA live/snapshots/export, extraction forms and values, RoB
  assessments, robvis export, extraction tables.
- **CLI** `recueil sr`: `create`, `list`, `show`, `search` (import a file as a run), `dedup`,
  `screen` (interactive keyboard loop or `--decide`), `retrieve`, `prisma`, `export`, `form`,
  `extract`, `rob`.
- **Web**: a review page with the PRISMA counts and a keyboard-driven screening view (`i` include,
  `e` exclude, `m` maybe, `1`–`9` reason, `u` undo, `j`/`k` move).
- **R**: `rc_sr_prisma()`, `rc_sr_extraction()`, `rc_sr_rob()`, and the Quarto template that turns
  them into a methods/results skeleton.

## 8. Not in v1

Second screener workflows and blinding, automated (ML) screening prioritisation, Unpaywall fetch
from the server, Parquet, the deep dive job, GRADE. Each is a separate decision when it lands.
