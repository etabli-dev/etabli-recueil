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
| `src/regex/` | The linear-time regular expression engine: parser, compiler, Pike VM, bounded input reader |
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

A condition that **could not be evaluated** — a regex that ran out of budget, a value longer than a
matcher may read, a title too long to compare — is an error, not a non-match. The rule is traced as
`error`, no action runs, and the run carries a warning saying the subject needs a human. Treating an
undecidable condition as false would silently file documents by a rule that never ran.

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

Globs compile to the same engine. `*` stays within a path segment, `**` crosses them, `**/` matches
any number of leading directories including none, and a trailing `dir/**` matches `dir` itself.

## What is bounded, and what is not

Not backtracking is a statement about complexity, not about cost. Linear still multiplies, and an
allocation made before the first step is not covered by a clock consulted during it. ADR-0022 asks
for the bound to be enforced *by the call* rather than checked after the damage, and this is the
list of what that means here — including the parts that do not hold, which are as much a part of the
contract as the parts that do.

### The haystack

| Limit | Default | What it bounds | Refusal |
|---|---:|---|---|
| `maxInputLength` | 262 144 | Characters read, checked before anything proportional to them | `RegexInputTooLongError` |
| `timeoutMs` | 250 | Wall clock across the **whole call**: reading the input, matching, and building the result | `RegexTimeoutError` |
| `maxSteps` | 5 000 000 | Simulation steps, deterministically — the same input costs the same steps on every machine | `RegexBudgetError` |

`maxInputLength` is checked first and against `String.prototype.length`, which is free. It exists
because the clock cannot bound work that happens before the first step: this engine used to begin
by building a boxed code-point array over the whole input, which cost 848 ms and hundreds of
megabytes at 16 MB of text, all of it outside the 250 ms it was supposedly running under. There is
no copy at all now for a string with no astral character in it — a code-point index is a string
index — and a string that does carry one is indexed into a `Int32Array`, chunk by chunk, against
the same deadline.

The default is chosen against the clock beside it rather than picked round: an unanchored search
costs this engine roughly 350 ms per megabyte for a small pattern on an idle machine, so 256 KiB is
90–180 ms depending on load — inside the 250 ms allowance, with room for a program larger than a
literal. A caller with a legitimate 900 MB scan raises all three knowingly, as ADR-0022 asks.

**Not bounded: nothing is streamed.** The simulation is a one-pass automaton and could in principle
be fed a stream, but `exec` returns the matched text and every capture, which means retaining the
input from the earliest live thread's start — and none of the callers wants a chunked API. So the
answer to "what about a 900 MB file" is a raised limit and a longer clock, not a chunked match, and
a caller that cannot afford either must split its input itself and accept that a match cannot span
the seam.

### The pattern

A pattern is untrusted too. It is typed into an editor and POSTed, and `MatcherSchema` compiles it
inside Zod validation — synchronously, on the request thread, before anything else looks at it.

| Limit | Value | What it bounds |
|---|---:|---|
| `MAX_PATTERN_LENGTH` | 65 536 | Characters in the pattern |
| `MAX_DEPTH` | 300 | Group nesting, so the parser cannot exhaust the call stack |
| `MAX_REPEAT` | 1 000 | A single `{n,m}` count |
| `MAX_PROGRAM` | 20 000 | Instructions emitted |
| `MAX_COMPILE_STEPS` | 200 000 | Compilation *work*, whether or not it emits anything |

The last of those is the one that is easy to miss. `MAX_PROGRAM` counts what was emitted, and a
repetition can cost a great deal while emitting nothing: `(?:(?:(?:){1000}){1000}){1000}` is thirty
characters, compiles to a three-instruction program, and took 15.8 seconds — a fourth level of
nesting is four hours. Every refusal here is a `RegexSyntaxError` carrying a position, because it is
a fact about the pattern that is true before any document is seen.

The parser is linear in the pattern. It used to build a fresh copy of the remainder once per atom,
which made a 40 000-character pattern cost 60.7 seconds before the instruction cap could refuse it.

### Everything else in this package

Bounds are not only for the regex engine, and a bound with a hole in it is where an attacker looks.

- **Every matcher**, not just the two that compile a pattern. `contains` does not backtrack, but it
  folds the whole value to lower case before comparing. `maxInputLength` applies to `equals`,
  `equalsAny`, `contains`, `startsWith`, `endsWith`, `glob` and `matches` alike.
- **A `text` condition truncates rather than being refused**, to the smaller of `maxTextLength` and
  `maxInputLength`, and the trace names which limit bit. Truncating is right here and only here: an
  over-long extracted text is the ordinary case, whereas an over-long filename is a fact worth
  refusing. Taking the smaller of the two is what stops the defaults contradicting each other.
- **The similarity measures** check their limit *before* `normalize('NFKC')`, because NFKC is an
  expansion: U+FDFA is one code point that becomes eighteen, so an 800 000-character title field
  became 14.4 million characters and cost 3.0 seconds and half a gigabyte through `evaluateDedup`.
  Over the limit they return `undefined` — "could not be measured", which is not the same fact as
  a score of 0.
- **Interpolation** is bounded by what it produces (`MAX_INTERPOLATED`, 64 KiB), not by the
  template, since a 1 KB template holding two hundred `${name}`s can substitute the whole matched
  value into each one.
- **A rule-set document** is bounded by `maxLength` (1 MiB) before either parser sees it, and by
  `MAX_DOCUMENT_DEPTH` (64) before the schema does. A condition is recursive, so `{"not":{"not":…}}`
  three thousand deep is a 24 KB document — inside every other limit — that made
  `RuleSetSchema.safeParse` throw a bare `RangeError` out of a function contracted to return its
  issues. The depth check is an iterative walk, so it cannot be the thing that overflows.
- **The evaluator** carries `MAX_CONDITION_DEPTH` of its own, because `evaluateRules` takes a plain
  object another package may have built without going through the parser.

### A refusal is not a non-match

Every limit above produces a refusal that names itself, and a refusal is a third state. A condition
that could not be evaluated is traced as an `error`, no action runs, and the run carries a warning
saying the subject needs a human (P3, ADR-0022 §6). Folding a refusal into "did not match" would
file documents by a rule that never ran, and would report a document as "not a duplicate" because
its title was too long to compare.

### `safeMatch`: the bounded matcher for the rest of the tree

Other packages that would otherwise reach for `new RegExp` over a mail header, an XML body or a
note should use this rather than writing a second bounded matcher:

```ts
import { safeMatch } from '@recueil/rules';

const result = safeMatch(pattern, haystack, { flags: 'i', maxInputLength: 64 * 1024 });
if (!result.ok) {
  // result.limit is 'steps' | 'time' | 'input-length'; result.refusal names it and its value.
  routeToReview(result.refusal);
} else if (result.matched) {
  use(result.match.captures);
}
```

A limit is returned, never thrown. A `RegexSyntaxError` *is* thrown: an unparseable pattern is the
operator's mistake, it is the same on every input, and swallowing it would turn a broken rule into
a rule that silently never fires. `safeTest` is the same call reduced to `true | false | undefined`,
where `undefined` is "ask a human".

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
