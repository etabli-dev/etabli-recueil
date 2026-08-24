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
 */
import type { IngestRule, RulePattern } from '@recueil/ingest';

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

const asPattern = (pattern: MailPattern): RulePattern =>
  typeof pattern === 'string' ? { pattern, flags: 'i' } : pattern;

const compile = (pattern: MailPattern): RegExp => {
  const { pattern: source, flags } = asPattern(pattern);
  const withUnicode = (flags ?? 'i').includes('u') ? (flags ?? 'i') : `${flags ?? 'i'}u`;
  return new RegExp(source, withUnicode);
};

const ordered = (rules: readonly MailRule[]): MailRule[] =>
  [...rules]
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

/** Does this rule match the envelope? All clauses present must match, as in the pipeline's engine. */
export const mailRuleMatches = (rule: MailRule, envelope: MailEnvelope): boolean => {
  if (rule.match.from !== undefined) {
    if (envelope.from === null || !compile(rule.match.from).test(envelope.from)) return false;
  }
  if (rule.match.subject !== undefined) {
    if (envelope.subject === null || !compile(rule.match.subject).test(envelope.subject)) return false;
  }
  if (rule.match.recipient !== undefined) {
    if (!compile(rule.match.recipient).test(envelope.recipients.join(' '))) return false;
  }
  return true;
};

/** The first `skip` rule that matches, if any. The source consults this before fetching a body. */
export const skippedBy = (rules: readonly MailRule[], envelope: MailEnvelope): MailRule | null => {
  for (const rule of ordered(rules)) {
    if (rule.actions.skip === true && mailRuleMatches(rule, envelope)) return rule;
  }
  return null;
};

/** Every rule that matches, in evaluation order. Reported in the poll log. */
export const matchingMailRules = (
  rules: readonly MailRule[],
  envelope: MailEnvelope,
): MailRule[] => ordered(rules).filter((rule) => mailRuleMatches(rule, envelope));

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
