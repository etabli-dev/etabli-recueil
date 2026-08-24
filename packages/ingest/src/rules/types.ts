/**
 * The rule language of stage 8.
 *
 * CONCEPT §5.3 stage 8: "Rule engine: match on source, sender, path, text regex, resolver result →
 * item type, collection, tags, custom fields." §5.6 adds that rules are "editable as YAML/JSON in
 * the UI", which fixes the shape: a rule is data, not code, and it has to survive a round trip
 * through JSON without losing anything. That is why a regular expression is a `{ pattern, flags }`
 * pair rather than a `RegExp` — a `RegExp` does not survive `JSON.stringify`, and it does not
 * survive `structuredClone` across the plugin boundary either (`spec/hooks.md` §2).
 *
 * A rule that cannot be represented as data is a rule the UI cannot edit, and a plugin that wants
 * to do something this language cannot express should be an `ingestStage` hook, which is what that
 * hook is for.
 */
import type { DetectedType, DocumentSourceKind, IdentifierScheme, JsonValue } from '../types.js';

/** A regular expression as data. `flags` always gets `u`; `i` is the usual addition. */
export interface RulePattern {
  pattern: string;
  flags?: string;
}

/**
 * What a rule matches on. Every clause present must match — the conjunction is the whole logic, and
 * disjunction is expressed by writing two rules, which is far easier to read in a UI than a nested
 * boolean tree.
 */
export interface RuleMatch {
  sourceKind?: DocumentSourceKind[];
  sourceId?: string[];
  /** Against `IngestRef.externalId`: the watched-folder path, the WebDAV path, the mailbox UID. */
  path?: RulePattern;
  /** Against the suggested filename, which is informational and therefore only ever a *match*. */
  filename?: RulePattern;
  /** Against `sourceMetadata.from` / `.sender`. */
  sender?: RulePattern;
  /** Against `sourceMetadata.subject`. */
  subject?: RulePattern;
  /** Against the extracted text. The expensive clause, so it is evaluated last. */
  text?: RulePattern;
  mediaType?: string[];
  detectedType?: DetectedType[];
  /** True when the document carries at least one identifier in any of these schemes. */
  hasIdentifier?: IdentifierScheme[];
  /** True when a resolver from one of these sources answered at stage 7. */
  resolvedBy?: string[];
  /** Only when the running confidence is already at least this. */
  minConfidence?: number;
  /** Only when the running confidence is below this — the "rescue the doubtful" rule. */
  maxConfidence?: number;
}

/** What a matching rule does. Everything here is additive except `itemType`. */
export interface RuleActions {
  itemType?: string;
  addTags?: string[];
  addCollectionIds?: string[];
  /** Facet-qualified paths, as everywhere else: `office.correspondent`, `bibliographic.title`. */
  setFields?: Record<string, JsonValue>;
  setCustomFields?: Record<string, JsonValue>;
  /** Added to the running confidence the stage-9 gate reads. Range -1..1. */
  confidenceDelta?: number;
  /** Send the document to a person whatever the score says. */
  review?: {
    reasonCode: string;
    explanation: string;
    proposedAction?: 'merge' | 'link' | 'create_item' | 'set_fields' | 'discard' | 'retry' | 'none';
  };
  /** Refuse the document outright: a rule for the scanner's blank separator pages. */
  stop?: {
    reasonCode: string;
    explanation: string;
  };
}

export interface IngestRule {
  id: string;
  title?: string;
  enabled?: boolean;
  /** Higher runs first. Ties break on `id`, so the order is total and stable across restarts. */
  priority?: number;
  /** Stop evaluating further rules once this one matches. */
  stopOnMatch?: boolean;
  match: RuleMatch;
  actions: RuleActions;
}
