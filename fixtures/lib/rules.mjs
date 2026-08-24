/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `fixtures/rules/` — the corpus for CONCEPT §5.3 stage 8, the rule engine: "match on source,
 * sender, path, text regex, resolver result → item type, collection, tags, custom fields".
 *
 * **The schema is a proposal, and the cases are the contract.** `spec/data-model.md` open decision
 * O2 has not been settled — rules may end up a table with YAML import/export, or files. So the
 * schema written here is a reading of CONCEPT §5.3 and of `rule_ref` in §4.9, not a specification;
 * if the Phase 2 ingestion spec settles on something different, these files move. What does *not*
 * move is `cases.json`: an input document, the rules that fire on it, in what order, and what comes
 * out. That table is the assertion, and it is written in terms of rule ids rather than of the file
 * format, so it survives a change of syntax.
 *
 * **The evaluation contract these files assume**, stated once here and repeated in `cases.json`:
 *
 *   1. Rules are evaluated by `priority` descending, then by `id` ascending. Document order is not
 *      significant; a file is a set, not a script.
 *   2. `enabled: false` rules are not evaluated at all, whatever their priority.
 *   3. A rule whose `match` succeeds *fires*, and its actions are collected.
 *   4. A fired rule with `stop: true` ends evaluation; nothing of lower priority is even examined.
 *   5. Two fired rules that set the *same field* to *different values* produce neither value: the
 *      document goes to the review queue with `reason_code = "rule_conflict"`
 *      (`spec/data-model.md` §5.2). "Last one wins" is not the rule, because there is no last one —
 *      see (1).
 *
 * **The three files, and what each is for.**
 *
 *   - `precedence.yaml` — six rules whose matches overlap. A `stop` at the top, a disabled rule at
 *     the very top (a loader that ignores `enabled` inverts the whole file), two rules at equal
 *     priority that disagree, and a catch-all at the bottom that must only be reached when nothing
 *     above it fired. `precedence.json` is the same rule set in JSON: loading both must produce the
 *     identical structure, which is the round-trip half of "editable as YAML/JSON" (CONCEPT §5.6).
 *   - `negation.yaml` — five rules built on `none`. Including the two that are always got wrong: an
 *     **empty** `none`, which is vacuously *true* and not vacuously false, and a `none` nested
 *     inside a `none`, which is a double negative and not a flattened one.
 *   - `hostile-regex.yaml` — seven patterns that must not be trusted. Three that backtrack
 *     catastrophically, one that is not a valid regex at all, one with a backreference, one with a
 *     PCRE inline flag that JavaScript throws on, and one with a Unicode property escape that means
 *     something entirely different without the `u` flag. `hostile-regex.input.txt` is the input that
 *     detonates them. The engine may reject these patterns at load or bound their execution; the
 *     corpus does not say which. It says that evaluating the whole file against that input must
 *     finish, and states a wall-clock budget so a test can hold it to that.
 *   - `malformed.yaml` — valid YAML that is not a valid rule set, in six distinct ways. As with
 *     `bibtex/malformed.bib`, the question is not "does it load" but "does it name precisely what
 *     it could not accept".
 *
 * Capture groups are interpolated as `{{ name }}` rather than `${name}`, so that a rule file can be
 * pasted into a shell, a template literal or a YAML anchor without changing meaning.
 */

const PRECEDENCE_YAML = `# Recueil ingestion rules — precedence.
#
# Evaluated by priority descending, then id ascending. A disabled rule is not evaluated at all; a
# fired rule with stop: true ends evaluation. Two fired rules that set the same field to different
# values produce a rule_conflict review entry and neither value.
#
# The JSON twin of this file is precedence.json. Loading both must produce the same structure.

version: 1
name: precedence

rules:
  # Highest priority in the file, and disabled. A loader that sorts before it filters, or that
  # treats a missing "enabled" as false, turns every document in the corpus into "other".
  - id: disabled-catch-all
    priority: 999
    enabled: false
    stop: true
    match:
      all:
        - mime: { prefix: application/ }
    actions:
      - set_item_type: other
      - add_tag: Unsortiert

  # The specific rule. It stops, so nothing below it runs for a Stadtwerke invoice — not even the
  # generic invoice rule that would also have matched.
  - id: invoice-stadtwerke
    priority: 100
    stop: true
    match:
      all:
        - source: mail
        - sender: { equals: rechnung@stadtwerke-ulm.example }
        - text: { regex: 'Rechnungsnummer:?\\s+(?<reference>\\d{4}-\\d{6})' }
      none:
        - tag: Storno
    actions:
      - set_item_type: invoice
      - add_tag: Rechnung
      - set_office:
          correspondent: Stadtwerke Ulm
          office_document_type: invoice
          reference_number: '{{ reference }}'
      - add_to_collection: Rechnungen/2023

  # Two rules, equal priority, disagreeing about item_type. Neither value is applied.
  - id: tie-vertrag-a
    priority: 60
    match:
      all:
        - text: { regex: 'Mietvertrag', flags: i }
    actions:
      - set_item_type: contract
      - add_tag: Vertrag

  - id: tie-vertrag-b
    priority: 60
    match:
      all:
        - text: { regex: 'Lagerraum' }
    actions:
      - set_item_type: letter
      - add_tag: Vertrag

  # The generic invoice rule. Reached only when the specific one did not fire.
  - id: invoice-generic
    priority: 50
    match:
      any:
        - text: { regex: '\\bRechnung(snummer)?\\b' }
        - subject: { contains: Rechnung }
    actions:
      - set_item_type: invoice
      - add_tag: Rechnung

  # The floor. Fires for any PDF that reached it, which is the point: it must not be reached when
  # something above it stopped.
  - id: catch-all-pdf
    priority: 10
    match:
      all:
        - mime: { equals: application/pdf }
    actions:
      - add_tag: Posteingang
`;

const NEGATION_YAML = `# Recueil ingestion rules — negation.
#
# "none" is a list of conditions, none of which may hold. Two of these five rules are the cases a
# negation implementation gets wrong.

version: 1
name: negation

rules:
  # Ordinary correspondence: from a person, not from a list. A message with a List-Id header is a
  # newsletter and is not correspondence, however much the rest of it looks like one.
  - id: correspondence-not-list
    priority: 80
    match:
      all:
        - source: mail
      none:
        - header: { name: List-Id, present: true }
        - header: { name: Precedence, equals: bulk }
    actions:
      - set_item_type: letter
      - add_tag: Korrespondenz

  # A double negative. "none of [ none of [ tag Storno ] ]" is "the document IS tagged Storno".
  # An implementation that flattens nested negations into one gets the exact opposite answer, and
  # gets it silently.
  - id: double-negative-storno
    priority: 70
    match:
      none:
        - none:
            - tag: Storno
    actions:
      - add_tag: Geprüft
      - set_custom_field: { key: geprueft, value: true }

  # An EMPTY none. There is nothing to exclude, so the condition holds. A fold with the wrong
  # identity — Array.prototype.some() over an empty list is false, and "not false" is true, but
  # every() is true and "not true" is false — turns this rule off for every document in the library.
  - id: vacuous-none-scanner
    priority: 60
    match:
      all:
        - source: scanner
      none: []
    actions:
      - add_tag: Gescannt

  # Missing, not empty. A correspondent that was never extracted is not a correspondent whose name
  # is the empty string, and only one of the two belongs in the review queue.
  - id: no-correspondent-to-review
    priority: 40
    match:
      all:
        - correspondent: { missing: true }
      none:
        - source: import
    actions:
      - route_to_review: low_confidence_metadata

  # any + none together: one of the two tags, and not the third.
  - id: steuer-nicht-storniert
    priority: 30
    match:
      any:
        - tag: Steuer
        - tag: Behörde
      none:
        - tag: Storno
    actions:
      - add_to_collection: Steuer
`;

const HOSTILE_REGEX_YAML = `# Recueil ingestion rules — hostile regular expressions.
#
# Seven patterns that a rule engine must not simply hand to its regex implementation and hope.
# hostile-regex.input.txt is the input that detonates them. Evaluating this whole file against that
# input must finish inside the budget stated in cases.json; the engine may get there by refusing
# these patterns at load or by bounding their execution, and the corpus does not care which.
#
# Nothing in this file describes a document anyone would want to file. The actions are placeholders.

version: 1
name: hostile-regex

rules:
  # (a+)+ against a long run of "a" that fails at the end: the classic exponential backtrack.
  - id: catastrophic-nested-quantifier
    priority: 10
    match:
      all:
        - text: { regex: '^(a+)+$' }
    actions:
      - add_tag: Niemals

  # The same shape wearing a suit. This one turns up in real "validate a line" rules.
  - id: catastrophic-word-loop
    priority: 10
    match:
      all:
        - text: { regex: '^(\\w+\\s?)*$' }
    actions:
      - add_tag: Niemals

  # Overlapping alternatives inside a quantifier.
  - id: catastrophic-overlap
    priority: 10
    match:
      all:
        - text: { regex: '(x+x+)+y' }
    actions:
      - add_tag: Niemals

  # Not a regular expression at all. This must be refused when the file is loaded, naming the rule
  # and the position — never at match time, on the twelve-thousandth document.
  - id: invalid-syntax
    priority: 10
    match:
      all:
        - text: { regex: '^(unclosed' }
    actions:
      - add_tag: Niemals

  # A backreference. Valid in JavaScript, absent from RE2. An engine backed by RE2 must say it
  # cannot compile this, rather than compile something that never matches.
  - id: backreference
    priority: 10
    match:
      all:
        - text: { regex: '(\\w+)\\s+\\1' }
    actions:
      - add_tag: Doppelwort

  # A PCRE/Python inline flag. \`new RegExp('(?i)rechnung')\` throws in JavaScript. Treating the
  # failure as "no match" makes the rule quietly dead.
  - id: pcre-inline-flag
    priority: 10
    match:
      all:
        - text: { regex: '(?i)rechnung' }
    actions:
      - add_tag: Rechnung

  # A Unicode property escape. Without the u flag JavaScript reads \\p as a literal "p", so this
  # matches the text "p{Script=Greek}" and nothing else — a wrong answer, not an error.
  - id: unicode-property-escape
    priority: 10
    match:
      all:
        - text: { regex: '\\p{Script=Greek}{4,}', flags: u }
    actions:
      - add_tag: Griechisch
`;

/* 44 "a"s and then a "b": every prefix matches (a+)+ and the whole never matches ^(a+)+$, which is
   the shape that forces the exponential walk. Short enough to read, long enough to hang a naive
   engine for longer than anyone will wait. */
const HOSTILE_INPUT = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxz',
  'Rechnung Rechnung fuer die Messstelle Sigmaringen ohne abschliessendes Satzzeichen',
  'Μελέτη υδρολογίας Αττικής',
  '',
].join('\n');

const MALFORMED_YAML = `# Recueil ingestion rules — deliberately not a valid rule set.
#
# This file is valid YAML and an invalid rule set. Six faults, in order of appearance:
#
#   1. no top-level "version"
#   2. a rule with no "id"
#   3. two rules sharing the id "duplicate"
#   4. "priority" is a string, not an integer
#   5. an action nobody defined ("send_email")
#   6. a condition key nobody defined ("weather")
#
# and one thing that is not a fault but is worth being deliberate about: the YAML merge key on the
# last rule. Some loaders honour "<<" and some do not, so whether "shared-defaults" reaches the rule
# is a property of the loader, not of the file. Whichever a loader does, it must do it on purpose.
#
# As with bibtex/malformed.bib, the question is not whether this loads. It is whether the loader
# names all six faults, or stops at the first.

name: malformed

shared-defaults: &shared-defaults
  priority: 20
  enabled: true

rules:
  - priority: 90
    match:
      all:
        - source: mail
    actions:
      - add_tag: OhneKennung

  - id: duplicate
    priority: 80
    match:
      all:
        - tag: Rechnung
    actions:
      - set_item_type: invoice

  - id: duplicate
    priority: 70
    match:
      all:
        - tag: Vertrag
    actions:
      - set_item_type: contract

  - id: priority-is-a-string
    priority: hoch
    match:
      all:
        - source: scanner
    actions:
      - add_tag: Gescannt

  - id: unknown-action
    priority: 60
    match:
      all:
        - mime: { equals: application/pdf }
    actions:
      - send_email: archiv@recueil.invalid

  - id: unknown-condition
    <<: *shared-defaults
    match:
      all:
        - weather: { equals: regnerisch }
    actions:
      - add_tag: Wetter
`;

/**
 * The same rule set as `precedence.yaml`, in JSON.
 *
 * Written out rather than converted, so that the two files are two independent statements of the
 * same thing. A test that loads both and compares has proved the loader agrees with itself across
 * syntaxes; a test that loaded one and serialised it to the other would have proved nothing.
 */
const PRECEDENCE_JSON = {
  version: 1,
  name: 'precedence',
  rules: [
    {
      id: 'disabled-catch-all',
      priority: 999,
      enabled: false,
      stop: true,
      match: { all: [{ mime: { prefix: 'application/' } }] },
      actions: [{ set_item_type: 'other' }, { add_tag: 'Unsortiert' }],
    },
    {
      id: 'invoice-stadtwerke',
      priority: 100,
      stop: true,
      match: {
        all: [
          { source: 'mail' },
          { sender: { equals: 'rechnung@stadtwerke-ulm.example' } },
          { text: { regex: 'Rechnungsnummer:?\\s+(?<reference>\\d{4}-\\d{6})' } },
        ],
        none: [{ tag: 'Storno' }],
      },
      actions: [
        { set_item_type: 'invoice' },
        { add_tag: 'Rechnung' },
        {
          set_office: {
            correspondent: 'Stadtwerke Ulm',
            office_document_type: 'invoice',
            reference_number: '{{ reference }}',
          },
        },
        { add_to_collection: 'Rechnungen/2023' },
      ],
    },
    {
      id: 'tie-vertrag-a',
      priority: 60,
      match: { all: [{ text: { regex: 'Mietvertrag', flags: 'i' } }] },
      actions: [{ set_item_type: 'contract' }, { add_tag: 'Vertrag' }],
    },
    {
      id: 'tie-vertrag-b',
      priority: 60,
      match: { all: [{ text: { regex: 'Lagerraum' } }] },
      actions: [{ set_item_type: 'letter' }, { add_tag: 'Vertrag' }],
    },
    {
      id: 'invoice-generic',
      priority: 50,
      match: {
        any: [
          { text: { regex: '\\bRechnung(snummer)?\\b' } },
          { subject: { contains: 'Rechnung' } },
        ],
      },
      actions: [{ set_item_type: 'invoice' }, { add_tag: 'Rechnung' }],
    },
    {
      id: 'catch-all-pdf',
      priority: 10,
      match: { all: [{ mime: { equals: 'application/pdf' } }] },
      actions: [{ add_tag: 'Posteingang' }],
    },
  ],
};

/**
 * The cases. This is the part that survives a change of rule syntax, so it is written in terms of
 * rule ids and of what comes out, never in terms of the file format.
 *
 * `evaluated` lists the rules the engine looked at, in the order it looked at them — that is what
 * distinguishes "the catch-all did not match" from "the catch-all was never reached because
 * something above it stopped", and only the second is correct for case 1.
 */
const CASES = {
  $schema: 'https://recueil.invalid/fixtures/rule-cases',
  description:
    'Inputs, the rules that fire on them, and what comes out. Written in terms of rule ids so ' +
    'that it survives a change to the rule file syntax. See fixtures/README.md §6.',
  evaluationContract: [
    'Rules are evaluated by priority descending, then by id ascending. Document order is not significant.',
    'A rule with enabled: false is not evaluated at all, whatever its priority.',
    'A rule whose match succeeds fires, and its actions are collected.',
    'A fired rule with stop: true ends evaluation; lower-priority rules are not examined.',
    'Two fired rules setting the same field to different values apply neither, and the document goes to the review queue with reason_code "rule_conflict".',
  ],
  cases: [
    {
      id: 'stadtwerke-invoice-stops-the-rest',
      ruleFile: 'precedence.yaml',
      why: 'the specific rule stops evaluation, so the generic invoice rule and the catch-all are never reached',
      input: {
        source: 'mail',
        sender: 'rechnung@stadtwerke-ulm.example',
        subject: 'Ihre Rechnung 2023-004417 und das Sitzungsprotokoll',
        mime: 'application/pdf',
        path: null,
        tags: [],
        correspondent: null,
        headers: {},
        text: 'Stadtwerke Ulm GmbH\nRechnungsnummer: 2023-004417\nGesamtbetrag 471,50 EUR',
      },
      expect: {
        evaluated: ['invoice-stadtwerke'],
        fired: ['invoice-stadtwerke'],
        notEvaluated: ['tie-vertrag-a', 'tie-vertrag-b', 'invoice-generic', 'catch-all-pdf'],
        skippedDisabled: ['disabled-catch-all'],
        actions: [
          { set_item_type: 'invoice' },
          { add_tag: 'Rechnung' },
          {
            set_office: {
              correspondent: 'Stadtwerke Ulm',
              office_document_type: 'invoice',
              reference_number: '2023-004417',
            },
          },
          { add_to_collection: 'Rechnungen/2023' },
        ],
        captures: { reference: '2023-004417' },
        reviewReason: null,
      },
    },
    {
      id: 'stadtwerke-invoice-tagged-storno',
      ruleFile: 'precedence.yaml',
      why: 'the same message with a Storno tag: the none clause blocks the specific rule, so the generic one and the catch-all both fire',
      input: {
        source: 'mail',
        sender: 'rechnung@stadtwerke-ulm.example',
        subject: 'Storno zu Rechnung 2023-004417',
        mime: 'application/pdf',
        path: null,
        tags: ['Storno'],
        correspondent: null,
        headers: {},
        text: 'Stadtwerke Ulm GmbH\nRechnungsnummer: 2023-004417\nStornorechnung',
      },
      expect: {
        evaluated: [
          'invoice-stadtwerke',
          'tie-vertrag-a',
          'tie-vertrag-b',
          'invoice-generic',
          'catch-all-pdf',
        ],
        fired: ['invoice-generic', 'catch-all-pdf'],
        notEvaluated: [],
        skippedDisabled: ['disabled-catch-all'],
        actions: [
          { set_item_type: 'invoice' },
          { add_tag: 'Rechnung' },
          { add_tag: 'Posteingang' },
        ],
        captures: {},
        reviewReason: null,
      },
    },
    {
      id: 'equal-priority-conflict',
      ruleFile: 'precedence.yaml',
      why: 'two rules at priority 60 set item_type to different values; neither value is applied',
      input: {
        source: 'watched_folder',
        sender: null,
        subject: null,
        mime: 'application/pdf',
        path: '/eingang/Mietvertrag-Lagerraum-14.pdf',
        tags: [],
        correspondent: 'Hausverwaltung Kessler GmbH',
        headers: {},
        text: 'Mietvertrag über einen Lagerraum\nLagerraum Nr. 14, Souterrain',
      },
      expect: {
        evaluated: [
          'invoice-stadtwerke',
          'tie-vertrag-a',
          'tie-vertrag-b',
          'invoice-generic',
          'catch-all-pdf',
        ],
        fired: ['tie-vertrag-a', 'tie-vertrag-b', 'catch-all-pdf'],
        notEvaluated: [],
        skippedDisabled: ['disabled-catch-all'],
        actions: [{ add_tag: 'Vertrag' }, { add_tag: 'Posteingang' }],
        conflicts: [
          {
            field: 'item_type',
            rules: ['tie-vertrag-a', 'tie-vertrag-b'],
            values: ['contract', 'letter'],
          },
        ],
        captures: {},
        reviewReason: 'rule_conflict',
      },
    },
    {
      id: 'nothing-matches-but-the-floor',
      ruleFile: 'precedence.yaml',
      why: 'a PDF that matches no content rule still reaches the catch-all, which is the only rule allowed to fire on everything',
      input: {
        source: 'scanner',
        sender: null,
        subject: null,
        mime: 'application/pdf',
        path: '/scans/scan_0041.pdf',
        tags: [],
        correspondent: null,
        headers: {},
        text: '',
      },
      expect: {
        evaluated: [
          'invoice-stadtwerke',
          'tie-vertrag-a',
          'tie-vertrag-b',
          'invoice-generic',
          'catch-all-pdf',
        ],
        fired: ['catch-all-pdf'],
        notEvaluated: [],
        skippedDisabled: ['disabled-catch-all'],
        actions: [{ add_tag: 'Posteingang' }],
        captures: {},
        reviewReason: null,
      },
    },
    {
      id: 'json-twin-is-the-same-rule-set',
      ruleFile: 'precedence.json',
      why: 'the JSON file must load to the same rule set as the YAML one and behave identically',
      sameAs: 'stadtwerke-invoice-stops-the-rest',
      input: {
        source: 'mail',
        sender: 'rechnung@stadtwerke-ulm.example',
        subject: 'Ihre Rechnung 2023-004417 und das Sitzungsprotokoll',
        mime: 'application/pdf',
        path: null,
        tags: [],
        correspondent: null,
        headers: {},
        text: 'Stadtwerke Ulm GmbH\nRechnungsnummer: 2023-004417\nGesamtbetrag 471,50 EUR',
      },
      expect: {
        evaluated: ['invoice-stadtwerke'],
        fired: ['invoice-stadtwerke'],
        notEvaluated: ['tie-vertrag-a', 'tie-vertrag-b', 'invoice-generic', 'catch-all-pdf'],
        skippedDisabled: ['disabled-catch-all'],
        captures: { reference: '2023-004417' },
        reviewReason: null,
      },
    },
    {
      id: 'newsletter-is-not-correspondence',
      ruleFile: 'negation.yaml',
      why: 'the List-Id header blocks correspondence-not-list; the message is a newsletter',
      input: {
        source: 'mail',
        sender: 'newsletter@example.net',
        subject: 'Ausgabe 6/2023',
        mime: 'text/html',
        path: null,
        tags: [],
        correspondent: 'Newsletter Wasserwirtschaft',
        headers: { 'List-Id': 'Wasserwirtschaft Newsletter <newsletter.example.net>' },
        text: 'Niedrigwasser und Grundwasserneubildung',
      },
      expect: {
        fired: [],
        actions: [],
        reviewReason: null,
      },
    },
    {
      id: 'double-negative-needs-the-tag',
      ruleFile: 'negation.yaml',
      why: 'none of [ none of [ tag Storno ] ] means the document IS tagged Storno; a flattened negation fires this on the wrong documents',
      input: {
        source: 'scanner',
        sender: null,
        subject: null,
        mime: 'application/pdf',
        path: '/scans/storno.pdf',
        tags: ['Storno'],
        correspondent: 'Stadtwerke Ulm',
        headers: {},
        text: 'Stornorechnung',
      },
      expect: {
        fired: ['double-negative-storno', 'vacuous-none-scanner'],
        actions: [
          { add_tag: 'Geprüft' },
          { set_custom_field: { key: 'geprueft', value: true } },
          { add_tag: 'Gescannt' },
        ],
        reviewReason: null,
      },
    },
    {
      id: 'empty-none-is-vacuously-true',
      ruleFile: 'negation.yaml',
      why: 'vacuous-none-scanner has an empty none and must fire on every scanner document; an engine that folds an empty none to false never fires it at all',
      input: {
        source: 'scanner',
        sender: null,
        subject: null,
        mime: 'application/pdf',
        path: '/scans/scan_0041.pdf',
        tags: [],
        correspondent: 'Finanzamt Ulm',
        headers: {},
        text: 'Bescheid',
      },
      expect: {
        fired: ['vacuous-none-scanner'],
        actions: [{ add_tag: 'Gescannt' }],
        reviewReason: null,
      },
    },
    {
      id: 'missing-correspondent-goes-to-review',
      ruleFile: 'negation.yaml',
      why: 'a correspondent that was never extracted is missing, not empty, and the rule distinguishes it from an import',
      input: {
        source: 'watched_folder',
        sender: null,
        subject: null,
        mime: 'application/pdf',
        path: '/eingang/unbekannt.pdf',
        tags: [],
        correspondent: null,
        headers: {},
        text: 'unleserlich',
      },
      expect: {
        fired: ['no-correspondent-to-review'],
        actions: [{ route_to_review: 'low_confidence_metadata' }],
        reviewReason: 'low_confidence_metadata',
      },
    },
    {
      id: 'hostile-regexes-must-not-hang',
      ruleFile: 'hostile-regex.yaml',
      why: 'the engine may refuse these patterns at load or bound their execution; either way, evaluating the file against hostile-regex.input.txt must finish',
      inputFile: 'hostile-regex.input.txt',
      expect: {
        /* Two of the seven cannot be compiled by a plain JavaScript RegExp at all, and must be
           reported by id when the file is loaded rather than swallowed at match time. */
        rejectedAtLoad: ['invalid-syntax', 'pcre-inline-flag'],
        /* An RE2-backed engine cannot compile this one either; a JavaScript-backed one can. The
           corpus does not require one answer, it requires the engine to say which. */
        engineDependent: ['backreference'],
        /* Wall clock for loading the file and evaluating every rule that did compile against every
           line of the input. Generous by three orders of magnitude for a bounded engine, and
           unreachable for an unbounded one. */
        budgetMilliseconds: 2000,
        mustNotThrow: true,
      },
    },
    {
      id: 'malformed-rule-set-names-every-fault',
      ruleFile: 'malformed.yaml',
      why: 'valid YAML, invalid rule set: the loader must report all six faults, not stop at the first',
      expect: {
        loads: false,
        faults: [
          { code: 'missing_version', where: 'document root' },
          { code: 'missing_id', where: 'rules[0]' },
          { code: 'duplicate_id', where: 'rules[1], rules[2]', id: 'duplicate' },
          { code: 'priority_not_an_integer', where: 'rules[3]', id: 'priority-is-a-string' },
          { code: 'unknown_action', where: 'rules[4]', id: 'unknown-action', action: 'send_email' },
          {
            code: 'unknown_condition',
            where: 'rules[5]',
            id: 'unknown-condition',
            condition: 'weather',
          },
        ],
      },
    },
  ],
};

/**
 * Build the corpus.
 *
 * @returns {Array<{ path: string, bytes: Buffer, note: string }>}
 */
export function buildRules() {
  return [
    {
      path: 'rules/precedence.yaml',
      bytes: Buffer.from(PRECEDENCE_YAML, 'utf8'),
      note: 'six overlapping rules: a stop, a disabled rule at the top, an equal-priority conflict, a floor',
    },
    {
      path: 'rules/precedence.json',
      bytes: Buffer.from(`${JSON.stringify(PRECEDENCE_JSON, null, 2)}\n`, 'utf8'),
      note: 'the same rule set in JSON, written independently rather than serialised from the YAML',
    },
    {
      path: 'rules/negation.yaml',
      bytes: Buffer.from(NEGATION_YAML, 'utf8'),
      note: 'five rules built on none, including an empty one and a nested one',
    },
    {
      path: 'rules/hostile-regex.yaml',
      bytes: Buffer.from(HOSTILE_REGEX_YAML, 'utf8'),
      note: 'seven patterns that must not be handed straight to a regex engine',
    },
    {
      path: 'rules/hostile-regex.input.txt',
      bytes: Buffer.from(HOSTILE_INPUT, 'utf8'),
      note: 'the input that detonates them',
    },
    {
      path: 'rules/malformed.yaml',
      bytes: Buffer.from(MALFORMED_YAML, 'utf8'),
      note: 'valid YAML, invalid rule set, six faults listed at the top of the file',
    },
    {
      path: 'rules/cases.json',
      bytes: Buffer.from(`${JSON.stringify(CASES, null, 2)}\n`, 'utf8'),
      note: 'the assertion table: inputs, the rules that fire, and what comes out',
    },
  ];
}

/** The number of rules each file declares, for the corpus counts. */
export const RULE_COUNTS = {
  'precedence.yaml': 6,
  'precedence.json': PRECEDENCE_JSON.rules.length,
  'negation.yaml': 5,
  'hostile-regex.yaml': 7,
  'malformed.yaml': 6,
};

/** The cases, so the measurer can count them without re-reading the file it just wrote. */
export const CASE_COUNT = CASES.cases.length;
