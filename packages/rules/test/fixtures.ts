/**
 * Rule sets and subjects the tests share.
 *
 * The YAML is written the way a user would write it — no `enabled: true` where the default already
 * says so, priorities only where they matter — so that the tests exercise the defaults rather than
 * a normalised form no editor produces.
 */
import type { DedupPair } from '../src/dedup/subject.js';
import type { IngestionSubject } from '../src/ingestion/subject.js';

/** Three rules whose written order and priority order disagree, which is the point. */
export const PRECEDENCE_YAML = `
version: 1
kind: ingestion
name: precedence
mode: all-match
rules:
  - id: catch-all
    description: The fallback, written first and run last.
    priority: -10
    when:
      type: always
    then:
      - type: set-item-type
        itemType: attachment_only
      - type: add-tags
        tags: [unfiled]

  - id: any-pdf
    when:
      type: mime
      match: { equals: application/pdf }
    then:
      - type: set-item-type
        itemType: report
      - type: add-tags
        tags: [pdf]

  - id: acme-invoice
    priority: 100
    when:
      all:
        - type: sender
          match: { endsWith: "@acme.example" }
        - type: mime
          match: { equals: application/pdf }
    then:
      - type: set-item-type
        itemType: invoice
      - type: set-correspondent
        correspondent: ACME GmbH
      - type: add-to-collection
        collection: Office/Invoices
      - type: add-tags
        tags: [acme, invoice]
`;

/** The same three rules, in first-match mode. */
export const FIRST_MATCH_YAML = PRECEDENCE_YAML.replace('mode: all-match', 'mode: first-match').replace(
  'name: precedence',
  'name: precedence (first match)',
);

export const NEGATION_YAML = `
version: 1
kind: ingestion
name: negation
rules:
  - id: unfiled-scans
    description: A scan that is not already filed and does not come from the payroll folder.
    when:
      all:
        - type: source
          match: { equals: scanner }
        - not:
            type: tag
            match: { equals: filed }
        - not:
            type: path
            match: { glob: "Scans/Payroll/**" }
    then:
      - type: add-tags
        tags: [needs-filing]
`;

export const CAPTURE_YAML = `
version: 1
kind: ingestion
name: captures
rules:
  - id: scanner-convention
    when:
      type: filename
      match:
        matches: "^(?<year>\\\\d{4})-(?<month>\\\\d{2})-\\\\d{2}_(?<who>[A-Z]+)_RE-(?<ref>\\\\d+)\\\\.pdf$"
    then:
      - type: set-item-type
        itemType: invoice
      - type: add-to-collection
        collection: "Office/Invoices/\${year}"
      - type: set-custom-field
        field: reference_number
        value: "\${ref}"
      - type: set-correspondent
        correspondent: "\${who}"
      - type: add-tags
        tags: ["\${year}-\${month}", "\${missing}"]
`;

export const REVIEW_YAML = `
version: 1
kind: ingestion
name: review
rules:
  - id: unresolved
    priority: 10
    when:
      all:
        - type: mime
          match: { equals: application/pdf }
        - type: resolver
          resolver: crossref
          outcome: [miss, ambiguous]
    then:
      - type: set-confidence
        confidence: 0.2
      - type: route-to-review
        reasonCode: no_identifier_match
        explanation: Crossref returned no decisive match for this PDF.
        severity: warning
        proposedAction: set_fields
      - type: stop

  - id: never-reached
    when:
      type: always
    then:
      - type: add-tags
        tags: [should-not-appear]
`;

export const DEDUP_YAML = `
version: 1
kind: dedup
name: dedup defaults
mode: first-match
rules:
  - id: identical-file
    priority: 100
    when:
      type: file-hash-match
    then:
      - type: link
      - type: set-confidence
        confidence: 1

  - id: same-doi
    priority: 90
    when:
      all:
        - type: identifier-match
          identifier: doi
        - not:
            type: identifier-conflict
    then:
      - type: merge
        winner: most-complete
      - type: set-confidence
        confidence: 0.99

  - id: fuzzy-candidate
    priority: 50
    when:
      all:
        - type: title-similarity
          atLeast: 0.7
        - type: year-within
          years: 1
        - type: creator-similarity
          atLeast: 0.5
          firstOnly: true
    then:
      - type: flag
        reasonCode: record_merge_candidate
        explanation: Titles, years and first authors agree, but no identifier does.
`;

export const CORPUS: readonly IngestionSubject[] = Object.freeze([
  Object.freeze({
    id: 'doc-acme',
    source: 'imap',
    sender: 'billing@acme.example',
    recipients: Object.freeze(['raban@example.org']),
    subject: 'Your invoice 40231',
    filename: '2026-08-14_ACME_RE-40231.pdf',
    mime: 'application/pdf',
    text: 'Rechnung Nr. 40231 über 1.234,56 EUR',
  }),
  Object.freeze({
    id: 'doc-scan',
    source: 'scanner',
    path: 'Scans/2026/08/scan-0007.pdf',
    mime: 'application/pdf',
    tags: Object.freeze(['scanned']),
  }),
  Object.freeze({
    id: 'doc-payroll',
    source: 'scanner',
    path: 'Scans/Payroll/august.pdf',
    mime: 'application/pdf',
  }),
  Object.freeze({
    id: 'doc-photo',
    source: 'mobile',
    filename: 'IMG_0042.jpg',
    mime: 'image/jpeg',
  }),
  Object.freeze({
    id: 'doc-paper',
    source: 'connector',
    filename: 'smith-2024.pdf',
    mime: 'application/pdf',
    resolvers: Object.freeze([Object.freeze({ resolver: 'crossref', outcome: 'hit' as const, identifier: '10.1136/bmj.n71', confidence: 0.99 })]),
  }),
]);

export const PAIRS: readonly DedupPair[] = Object.freeze([
  Object.freeze({
    id: 'pair-hash',
    left: Object.freeze({ id: 'a1', hashes: Object.freeze(['f'.repeat(64)]), title: 'One' }),
    right: Object.freeze({ id: 'b1', hashes: Object.freeze(['f'.repeat(64)]), title: 'One' }),
  }),
  Object.freeze({
    id: 'pair-doi',
    left: Object.freeze({ id: 'a2', identifiers: Object.freeze({ doi: '10.1136/bmj.n71' }), title: 'PRISMA 2020', fieldCount: 8 }),
    right: Object.freeze({ id: 'b2', identifiers: Object.freeze({ doi: '10.1136/bmj.n71' }), title: 'The PRISMA 2020 statement', fieldCount: 14 }),
  }),
  Object.freeze({
    id: 'pair-fuzzy',
    left: Object.freeze({
      id: 'a3',
      title: 'Preferred reporting items for systematic reviews',
      year: 2020,
      creators: Object.freeze(['Page']),
    }),
    right: Object.freeze({
      id: 'b3',
      title: 'Preferred reporting items for systematic reviews and meta-analyses',
      year: 2021,
      creators: Object.freeze(['Page', 'McKenzie']),
    }),
  }),
  Object.freeze({
    id: 'pair-different',
    left: Object.freeze({ id: 'a4', title: 'Quantum error correction', year: 2019, creators: Object.freeze(['Shor']) }),
    right: Object.freeze({ id: 'b4', title: 'A grammar of graphics', year: 2005, creators: Object.freeze(['Wilkinson']) }),
  }),
]);
