/**
 * Rules by sender and subject (CONCEPT §5.3: "IMAP mailbox (attachments as Documents, body as
 * Note, rules by sender/subject)").
 *
 * There are two different decisions hiding in that sentence, and they belong in two different
 * places:
 *
 *   - **Is this message wanted at all?** That is the source's decision, and it is taken at poll
 *     time from the header block alone, before the body is fetched. A mailbox that also receives
 *     newsletters should not cost forty megabytes of download to ignore them.
 *   - **What should the item look like?** That is *not* the source's decision. P2 says the source
 *     produces candidates and the host owns everything downstream, and stage 8 of the pipeline is
 *     already a rule engine that matches on `sender` and `subject` and applies item types,
 *     collections, tags and custom fields with conflict detection and a stable evaluation order.
 *     Reimplementing a second, weaker one here would mean two places to look when a mail is filed
 *     wrongly.
 *
 * So a `MailRule` compiles into an `IngestRule` for everything except `skip`, and `skip` is
 * enforced by the source. The compiled rules are handed to the pipeline by the runner, which is why
 * `IngestSource` has a `rules` member at all.
 *
 * ## Why `SafeRegex` and not `RegExp`
 *
 * These patterns run inside the poll loop against a `Subject:` and a `From:` written by whoever
 * sent the message. The Phase 2 review proved what that costs with a backtracking engine: the rule
 * `^(\w+\s?)*$` — "the subject is just plain words", which no reviewer would blink at — took 45
 * seconds on a 33-character subject and never returned on a 45-character one. The mailbox poll
 * stops for as long as it takes, and a stranger picks the length.
 *
 * `@recueil/rules` already had the answer: a Pike VM whose work is bounded by input length times
 * program length, with a step budget and a wall clock on top. It was written for the ingestion rule
 * engine and simply was not here. ADR-0022 §4 makes it the rule everywhere — "no exceptions for
 * 'internal' rules — a mail rule is written by the operator but runs against a subject line written
 * by a stranger" — so this module reuses that engine rather than adding a second one.
 *
 * The engine's syntax is a deliberate subset, so a pattern it cannot parse and a match that runs
 * out of budget both make the clause **not match**, and both are reported as a
 * `MailRuleRefusal` rather than swallowed. Refusing to decide is not the same as deciding no: a
 * `skip` rule that cannot be evaluated leaves the message to be ingested and looked at (P3), which
 * is the direction that cannot lose a document.
 */
import type { IngestRule, RulePattern } from '@recueil/ingest';
import { isRegexLimitError, safeRegex } from '@recueil/rules';

/** A pattern as data, so a rule survives a round trip through JSON (`@recueil/ingest`'s rule DSL). */
export type MailPattern = string | RulePattern;

export interface MailRule {
  id: string;
  title?: string;
  /** Higher runs first, as in the pipeline's engine. */
  priority?: number;
  enabled?: boolean;
  match: {
    /** Against the decoded `From` header, address and display name alike. */
    from?: MailPattern;
    /** Against the decoded `Subject`. */
    subject?: MailPattern;
    /** Against any address in `To` or `Cc`, joined by spaces. */
    recipient?: MailPattern;
  };
  actions: {
    /** Do not ingest this message at all. Enforced by the source, before the body is fetched. */
    skip?: boolean;
    itemType?: string;
    addTags?: string[];
    addCollectionIds?: string[];
    setFields?: Record<string, string | number | boolean | null>;
    setCustomFields?: Record<string, string | number | boolean | null>;
    /** Send it to a person whatever the confidence says. */
    review?: { reasonCode: string; explanation: string };
  };
}

export interface MailEnvelope {
  from: string | null;
  subject: string | null;
  recipients: string[];
}

/** The clause of a rule that could not be decided, and why. Reported, never silent (P3). */
export interface MailRuleRefusal {
  ruleId: string;
  clause: 'from' | 'subject' | 'recipient';
  pattern: string;
  /** The limit that was hit, or the syntax this engine does not have. Names the number. */
  reason: string;
}

/** The result of evaluating one rule: whether it matched, and anything that could not be decided. */
export interface MailRuleEvaluation {
  matched: boolean;
  refusals: MailRuleRefusal[];
}

const asPattern = (pattern: MailPattern): RulePattern =>
  typeof pattern === 'string' ? { pattern, flags: 'i' } : pattern;

/**
 * The step budget and the clock a mail rule runs under.
 *
 * The step budget is deliberately tighter than `@recueil/rules`' default of five million, which is
 * sized for a megabyte of OCR text. A header is a few hundred characters by RFC 5322's line
 * limits; two hundred thousand steps is roughly eighteen thousand characters against a pattern of
 * this shape, so no legitimate `Subject:` comes near it and a hostile one is refused in tens of
 * milliseconds. The clock is left at the package default, which makes it a backstop rather than
 * the usual cause of a refusal: a budget in steps is deterministic, so a rule set that passes in
 * CI passes in production, and one in milliseconds is not.
 */
export const MAIL_RULE_MAX_STEPS = 200_000;
export const MAIL_RULE_TIMEOUT_MS = 250;

/**
 * `SUPPORTED_FLAGS` for this engine is `ims`. A `MailRule` written against the native engine may
 * carry `u`, `g` or `y`; `u` is implied here (the VM works in code points), and `g`/`y` are the
 * caller's business, so all three are dropped rather than made into a syntax error.
 */
const engineFlags = (flags: string | undefined): string =>
  [...new Set(flags ?? 'i')].filter((flag) => 'ims'.includes(flag)).join('');

/**
 * Test one clause under the budget.
 *
 * Returns `true`/`false` for a decision, or a reason string for a refusal. The three outcomes are
 * distinct on purpose: "did not match" and "could not be evaluated" mean different things to a
 * `skip` rule, and collapsing them is how a denial of service becomes a silent mis-filing.
 */
const testClause = (pattern: MailPattern, value: string): boolean | string => {
  const { pattern: source, flags } = asPattern(pattern);
  let compiled;
  try {
    compiled = safeRegex(source, {
      flags: engineFlags(flags),
      maxSteps: MAIL_RULE_MAX_STEPS,
      timeoutMs: MAIL_RULE_TIMEOUT_MS,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    return compiled.test(value);
  } catch (error) {
    if (isRegexLimitError(error)) return error.message;
    throw error;
  }
};

const ordered = (rules: readonly MailRule[]): MailRule[] =>
  [...rules]
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

const CLAUSES = ['from', 'subject', 'recipient'] as const;

const valueFor = (clause: (typeof CLAUSES)[number], envelope: MailEnvelope): string | null => {
  if (clause === 'from') return envelope.from;
  if (clause === 'subject') return envelope.subject;
  return envelope.recipients.join(' ');
};

/**
 * Does this rule match the envelope, and what could not be decided?
 *
 * All clauses present must match, as in the pipeline's engine. A clause whose pattern this engine
 * cannot parse, or whose match ran out of budget, does not match and is recorded in `refusals`.
 */
export const evaluateMailRule = (rule: MailRule, envelope: MailEnvelope): MailRuleEvaluation => {
  const refusals: MailRuleRefusal[] = [];
  let matched = true;

  for (const clause of CLAUSES) {
    const pattern = rule.match[clause];
    if (pattern === undefined) continue;
    const value = valueFor(clause, envelope);
    if (value === null) {
      matched = false;
      continue;
    }
    const outcome = testClause(pattern, value);
    if (typeof outcome === 'string') {
      refusals.push({
        ruleId: rule.id,
        clause,
        pattern: asPattern(pattern).pattern,
        reason: outcome,
      });
      matched = false;
      continue;
    }
    if (!outcome) matched = false;
  }

  return { matched, refusals };
};

/** Does this rule match the envelope? All clauses present must match, as in the pipeline's engine. */
export const mailRuleMatches = (rule: MailRule, envelope: MailEnvelope): boolean =>
  evaluateMailRule(rule, envelope).matched;

/** Every rule that matched and every clause that could not be decided, in evaluation order. */
export interface MailRuleOutcome {
  /** The first `skip` rule that matched, or null. */
  skip: MailRule | null;
  /** Every rule that matched, highest priority first, `skip` rules included. */
  matched: MailRule[];
  /** Clauses that ran out of budget or would not compile. Carried onto the candidate (P3). */
  refusals: MailRuleRefusal[];
}

/**
 * Evaluate the whole rule set once.
 *
 * One pass rather than three, because the poll loop calls `skippedBy` and `matchingMailRules` on
 * the same envelope and the refusals have to survive to the candidate either way.
 */
export const evaluateMailRules = (
  rules: readonly MailRule[],
  envelope: MailEnvelope,
): MailRuleOutcome => {
  const matched: MailRule[] = [];
  const refusals: MailRuleRefusal[] = [];
  let skip: MailRule | null = null;

  for (const rule of ordered(rules)) {
    const evaluation = evaluateMailRule(rule, envelope);
    refusals.push(...evaluation.refusals);
    if (!evaluation.matched) continue;
    matched.push(rule);
    if (rule.actions.skip === true) skip ??= rule;
  }

  return { skip, matched, refusals };
};

/** The first `skip` rule that matches, if any. The source consults this before fetching a body. */
export const skippedBy = (rules: readonly MailRule[], envelope: MailEnvelope): MailRule | null =>
  evaluateMailRules(rules, envelope).skip;

/** Every rule that matches, in evaluation order. Reported in the poll log. */
export const matchingMailRules = (rules: readonly MailRule[], envelope: MailEnvelope): MailRule[] =>
  ordered(rules).filter((rule) => mailRuleMatches(rule, envelope));

/**
 * Compile the filing rules into pipeline rules.
 *
 * `sourceId` is added to every match clause so that a rule written for one mailbox cannot fire on a
 * document that came from a watched folder — the pipeline evaluates every rule it is given against
 * every candidate of the run.
 */
export const toIngestRules = (sourceId: string, rules: readonly MailRule[]): IngestRule[] => {
  const compiled: IngestRule[] = [];
  for (const rule of ordered(rules)) {
    if (rule.actions.skip === true) continue; // Enforced at poll time; never reaches the pipeline.

    const actions: IngestRule['actions'] = {};
    if (rule.actions.itemType !== undefined) actions.itemType = rule.actions.itemType;
    if (rule.actions.addTags !== undefined) actions.addTags = rule.actions.addTags;
    if (rule.actions.addCollectionIds !== undefined) {
      actions.addCollectionIds = rule.actions.addCollectionIds;
    }
    if (rule.actions.setFields !== undefined) actions.setFields = { ...rule.actions.setFields };
    if (rule.actions.setCustomFields !== undefined) {
      actions.setCustomFields = { ...rule.actions.setCustomFields };
    }
    if (rule.actions.review !== undefined) {
      actions.review = {
        reasonCode: rule.actions.review.reasonCode,
        explanation: rule.actions.review.explanation,
        proposedAction: 'set_fields',
      };
    }

    compiled.push({
      id: `mail:${sourceId}:${rule.id}`,
      ...(rule.title === undefined ? {} : { title: rule.title }),
      ...(rule.priority === undefined ? {} : { priority: rule.priority }),
      match: {
        sourceId: [sourceId],
        ...(rule.match.from === undefined ? {} : { sender: asPattern(rule.match.from) }),
        ...(rule.match.subject === undefined ? {} : { subject: asPattern(rule.match.subject) }),
      },
      actions,
    });
  }
  return compiled;
};
