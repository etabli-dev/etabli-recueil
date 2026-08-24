# `@recueil/rules`

The ingestion and deduplication rule engine: one declarative, versioned rule format in YAML or
JSON, a deterministic evaluator, an explicable trace, and a dry run that changes nothing.

CONCEPT.md §5.3 stage 8 asks for a rule engine that matches on source, sender, path, text and
resolver result and sets item type, collection, tags and custom fields. §5.6 asks for dedup rules
"editable as YAML/JSON in the UI" with "a dry-run report before execution". Those are one thing
pointed at two subjects, so this package is one format, one engine, one trace and one report, with
a *facet* on each end.

No dependency on `@recueil/core`. A rule is a function of the contract, not of the database, and an
engine that could reach a database could not be dry-run.

## Layout

| Path | What lives there |
|---|---|
| `src/schema/` | The rule format: Zod schemas for the envelope, the matchers, and each facet's conditions and actions |
| `schema/rule-set.schema.json` | The generated JSON Schema, checked in, for the UI and the API |
| `src/parse.ts` | YAML/JSON → validated rule set, with error messages a rule author can act on |
| `src/engine.ts` | Precedence, boolean composition, action application, trace — facet-independent |
| `src/ingestion/` | The §5.3 facet: subject, conditions, actions, outcome |
| `src/dedup/` | The §5.6 facet: candidate pair, conditions, decisions, similarity |
| `src/dry-run.ts`, `src/report.ts` | Corpus evaluation and its Markdown report |
| `src/trace.ts` | The trace types and `renderTrace` |
| `src/regex/` | The linear-time regular expression engine: parser, compiler, Pike VM |
| `src/glob.ts`, `src/path.ts` | Globs compiled to the same engine; lexical path normalisation |
| `src/interpolate.ts` | `${name}` from a regex capture into an action value |

## A rule set

```yaml
version: 1
kind: ingestion
name: Office filing
mode: all-match

rules:
  - id: acme-invoices
    description: Invoices mailed by Acme's billing address.
    priority: 100
    when:
      all:
        - type: sender
          match: { endsWith: "@acme.example" }
        - type: mime
          match: { equals: application/pdf }
        - not:
            type: tag
            match: { equals: filed }
    then:
      - type: set-item-type
        itemType: invoice
      - type: set-correspondent
        correspondent: ACME GmbH
      - type: add-to-collection
        collection: Office/Invoices
      - type: add-tags
        tags: [acme, invoice]

  - id: scanner-convention
    priority: 50
    when:
      type: filename
      match:
        matches: "^(?<year>\\d{4})-\\d{2}-\\d{2}_(?<who>[A-Z]+)_RE-(?<ref>\\d+)\\.pdf$"
    then:
      - type: add-to-collection
        collection: "Office/Invoices/${year}"
      - type: set-custom-field
        field: reference_number
        value: "${ref}"

  - id: unresolved-pdfs
    priority: -10
    when:
      all:
        - type: mime
          match: { equals: application/pdf }
        - type: resolver
          outcome: [miss, ambiguous]
    then:
      - type: set-confidence
        confidence: 0.2
      - type: route-to-review
        reasonCode: no_identifier_match
        explanation: No resolver produced a decisive match for this PDF.
      - type: stop
```

```ts
import { evaluateIngestion, parseRuleSetOrThrow, renderTrace } from '@recueil/rules';

const ruleSet = parseRuleSetOrThrow(yaml);
const { outcome, trace } = evaluateIngestion(ruleSet, subject);

outcome.tags;        // [{ value: 'acme', ruleId: 'acme-invoices' }, …]
outcome.itemType;    // { value: 'invoice', ruleId: 'acme-invoices' }
console.log(renderTrace(trace));
```

## The format

**Envelope.** `version` (1), `kind` (`ingestion` or `dedup`), optional `name`, `description`,
`mode` and `limits`, and `rules`. Each rule has an `id`, an optional `description`, `enabled`
(default true), `priority` (default 0), a `when` condition and a non-empty `then` list.

**Conditions.** A leaf carries a `type` naming what to read; a composite is the bare key `all`,
`any` or `not`.

| Facet | Leaf types |
|---|---|
| `ingestion` | `source`, `sender`, `recipient`, `subject`, `path`, `filename`, `mime`, `text`, `item-type`, `tag`, `resolver`, `always` |
| `dedup` | `identifier-match`, `identifier-conflict`, `file-hash-match`, `title-similarity`, `venue-similarity`, `creator-similarity`, `year-within`, `field`, `same-field`, `always` |

**Matchers.** One shape everywhere, exactly one operator per matcher: `equals`, `equalsAny`,
`contains`, `startsWith`, `endsWith`, `matches` (regex), `glob`. Comparison ignores case unless
`caseSensitive: true`.

**Actions.**

| Facet | Actions |
|---|---|
| `ingestion` | `set-item-type`, `add-to-collection`, `add-tags`, `set-custom-field`, `set-correspondent`, `set-confidence`, `route-to-review`, `stop` |
| `dedup` | `merge`, `link`, `flag`, `ignore`, `set-confidence`, `stop` |

`collection`, `tags`, `correspondent`, a string custom-field `value` and a review `explanation`
interpolate `${name}` from a named capture of a regex condition **in the same rule**. A name with no
capture behind it skips that action and says so in the trace, rather than writing a blank; `$${` is
a literal `${`.

## Evaluation order, and what a mode does

Rules run in **priority descending, then the order they are written**. The tiebreak is explicit so
that a rule set with no priorities at all is still deterministic, and adding a rule in the middle of
a file cannot reorder the others. `sortRules` is exported: the order is a function, not a habit.

- **`all-match`** (default) — every rule whose condition holds contributes. Tags and collections
  accumulate as a set; a scalar set twice keeps the later rule's value, and the overwrite is
  recorded in `outcome.conflicts` with both rules named, so the pipeline can raise a `rule_conflict`
  review entry rather than let the disagreement pass unseen.
- **`first-match`** — the first rule whose condition holds ends the run. Later rules are traced as
  `not-reached`.

A `stop` action ends the run in either mode.

Nothing in the evaluation reads a clock, a random source or the filesystem, so the same rule set
over the same subject gives byte-identical output every time.

## The trace

Every evaluation returns an `EvaluationTrace` alongside the outcome: each rule with its order,
priority and verdict; the condition tree as evaluated, with a sentence per node saying what was
compared and what came back, and the matched span as evidence; and each action with what it did or
why it declined. Rules that were disabled, not reached, or that could not be decided are in the
trace too — "why did my rule not fire" is the more common question.

```
ingestion rule set "Office filing" (all-match) on doc-acme
  [0] acme-invoices (priority 100): matched
    - ✓ all: all 3 members matched
      - ✓ sender: "billing@acme.example" ends with "@acme.example"
      - ✓ mime: "application/pdf" equals "application/pdf"
      - ✓ not: the member did not match
        - ✗ tag: no tags on this subject; the rule wanted one that equals "filed"
    - → set-item-type: item type invoice
    - → set-correspondent: correspondent "ACME GmbH"
    - → add-to-collection: collection "Office/Invoices"
    - → add-tags: tags acme, invoice
  [1] scanner-convention (priority 50): matched
    - ✓ filename: "2026-08-14_ACME_RE-40231.pdf" matches /^(?<year>…/ at 0..28 — "2026-08-14_ACME_RE-40231.pdf"
    - → add-to-collection: collection "Office/Invoices/2026"
    - → set-custom-field: reference_number = "40231"
  [2] unresolved-pdfs (priority -10): not-matched
    - ✗ all: a member did not match (2 of 2 evaluated, stopped at resolver)
      - ✓ mime: "application/pdf" equals "application/pdf"
      - ✗ resolver: no result from any resolver; the rule wanted miss or ambiguous
```

A condition that **could not be evaluated** — a regex that ran out of budget — is an error, not a
non-match. The rule is traced as `error`, no action runs, and the run carries a warning saying the
subject needs a human. Treating an undecidable condition as false would silently file documents by a
rule that never ran.

## The dry run

```ts
import { dryRunIngestion, renderIngestionReport, summariseIngestion } from '@recueil/rules';

const report = dryRunIngestion(ruleSet, corpus);
console.log(renderIngestionReport(report, summariseIngestion(report)));
```

The report carries every subject's outcome and trace, a row per rule counting matched / not matched
/ not reached / disabled / errors, the subjects no rule matched, the subjects a rule could not
decide, and the warnings.

Its honesty is structural rather than a flag. `evaluateRules` is a pure function from a rule set and
a plain subject value to a plain outcome value; it is handed no database, no storage backend and no
HTTP client, so there is no "apply" path a dry run has to remember to switch off. Every number in
the report is derived from those returned outcomes and traces — there is no counter incremented at
the point of decision and then reported back as evidence that the decision was made.

## Regular expressions: linear by construction

A rule set is configuration. It is edited in a text box and then run against filenames, mail
subjects and OCR output that arrived from outside. One careless nested quantifier in a backtracking
engine is a document that hangs the ingest worker, and no amount of review catches every such
pattern — so this package never calls `RegExp` on a rule's pattern.

Patterns are parsed into a Thompson program and simulated by a Pike VM. Work is bounded by
`input length × program size`, whatever the pattern; `^(a+)+$` against a hundred `a`s and a `b`
costs the same as any other pattern of its size, and the test suite proves the difference by
spawning a child process that runs the same pattern through the platform's own `RegExp` and
asserting it had to be killed.

**Supported:** literals and the usual escapes, `.`, character classes with ranges, negation and the
class escapes, `^`, `$`, `\b`, `\B`, capturing, non-capturing and named groups, alternation, and
`*` `+` `?` `{n,m}` in greedy and lazy form. Flags `i`, `m`, `s`.

**Not supported, and refused at validation time with a position in the pattern:** backreferences,
lookahead, lookbehind, Unicode property escapes, and any repetition count above 1000. These are not
omissions to fill in later — they are the constructs a linear simulation cannot run, and the reason
the guarantee holds.

Two limits sit on top of the linear bound, because linear still multiplies: `maxSteps` (default
5 000 000, deterministic, so a rule set that passes in CI passes in production) and `timeoutMs`
(default 250). A rule set may tighten either through `limits`, and a caller may override both.

Globs compile to the same engine. `*` stays within a path segment, `**` crosses them, `**/` matches
any number of leading directories including none, and a trailing `dir/**` matches `dir` itself.

## Paths are normalised before they are matched

A path from a watched folder, an archive entry, a WebDAV listing or a mail attachment is hostile
until it has been normalised. `normalisePath` resolves `.` and `..` lexically, treats a backslash as
a separator, and reports whether the path climbed above its own start. The rule sees the normalised
form, so `photos/**` does not match `photos/../../etc/shadow`, and both the trace and the run's
warnings record the traversal.

This package does not decide whether a path is *inside a root* — it has no root. That belongs to the
storage layer, which does.

## The JSON Schema

`schema/rule-set.schema.json` is generated from the Zod schemas by
`pnpm --filter @recueil/rules run json-schema` and checked in, so the web app can import it without
a build step. `test/json-schema.test.ts` fails if the two drift apart. Every object in it is closed,
so a typo in the editor is a validation error rather than a silent no-op.

## Applying an outcome

This package decides; it never writes. An `IngestionOutcome` carries the rule id beside every value
it produced, which is what populates `item_tags.rule_ref` (`spec/data-model.md` §3.13) and the field
provenance of the office facet (§3.7). A `DedupOutcome` carries a decision and a winner rule, and
the Phase 3 dedup engine is what turns those into a merge, a trash record and a reversible merge
log. That separation is what makes the dry run a prediction rather than a promise.
