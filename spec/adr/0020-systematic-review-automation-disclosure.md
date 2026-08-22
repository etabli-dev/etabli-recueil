# 0020 — Systematic-review automation disclosure

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0 (governs Phase 7)

## Context

PRISMA 2020 asks a review to report the automation tools used in study selection, data collection and
risk-of-bias assessment, and PRISMA-S asks the same of the search. Recueil offers tool assistance
throughout: deduplication with source tracking (§5.6), resolver-supplied metadata (§5.4), deep-dive
snowballing with budgets (§5.8), writes made through the API and through MCP (§5.12), and — in the
parking lot — LLM-assisted screening. A reviewer using Recueil will therefore have to answer the
question, and answering it from memory at write-up time is exactly how methods sections become
fiction.

The counter-argument to recording it always is that most solo reviews use no automation beyond
deduplication. Materialising an automation column on every decision in every review puts a row of
"none" in front of a reader and invites them to wonder what the tool did that it is not saying.

## Decision

Automation disclosure is a per-review setting, set at review setup (§5.10, step 1), **off by
default**.

**When on**, every screening decision, extraction value, risk-of-bias judgement and PRISMA count
records an automation stanza alongside it:

- `assistance`: one of `none`, `suggestion_shown`, `suggestion_accepted`, `fully_automated`
- `agent`: the plugin id and version, the model identifier where a language model was involved, or
  the API token / MCP client that made the write
- `basis`: the rule, prompt or template identifier the agent acted on
- `confidence`: where the agent supplies one
- `confirmed_by_human`: whether a person reviewed the suggestion before it was recorded

The stanza is included in the review export (CSV, Parquet, the `meta`/`metafor` frames) and rendered
by the Quarto report template as a methods paragraph with counts per `assistance` category, written
to be pasted against PRISMA 2020 items 7 to 9 and the relevant PRISMA-S items.

**When off**, no per-decision automation stanza is materialised. The audit trail (§5.10, step 11)
still records actor, action and timestamp for every write regardless of the setting, including MCP
and API-token attribution, so the information is recoverable after the fact — it is simply not
promoted into review data. The export carries an explicit `automation_disclosure: false` marker
rather than staying silent about it.

**Changing the setting mid-review.** Turning it on applies from that moment forward only; the export
states the date it was enabled, because back-filling stanzas for decisions that were not instrumented
would be fabrication (P4). Turning it off keeps every stanza already recorded (P5, never delete) and
the export marker becomes `partial`, with the date range during which disclosure was active.

## Consequences

The storage cost is a nullable JSON column and a toggle in review setup. The real cost is a contract:
every tool-assisted write path in the SR module must be able to supply the stanza, which makes this a
Phase 7 design constraint on the services rather than something addable later. Retrofitting it would
mean auditing every write site under time pressure.

LLM-assisted screening, in the parking lot, must not ship before this exists. That dependency is
recorded here so it is not rediscovered when the feature is built.

Off by default means a reviewer can reach write-up having used automation without a disclosure
record. Two mitigations: the audit trail retains the actor either way, and review setup prompts for
the setting whenever any automation-capable plugin is enabled in the install, so the choice is made
knowingly rather than by omission.

Self-reported disclosure is not verification. The stanza records what the tool believes it did; a
reviewer who works around the tool is not caught by it. That limit is stated in the exported methods
paragraph rather than implied away.
