/**
 * The mail-rule matcher's budget (H2, ADR-0022 §4), and the Phase 2 reproduction it closes.
 *
 * The review's proof of concept is the first test here, unchanged in substance. A `skip` rule
 * reading `^(\w+\s?)*$` — "the subject is just plain words", which is the sort of rule an operator
 * writes on a Tuesday — was run through the real `skippedBy` against subjects of increasing length.
 * Against the shipped code, which compiled it to a native `RegExp`: 21 characters cost 0.06 s, 29
 * cost 2.45 s, 33 cost 45.09 s, and 45 never returned. `skippedBy` is called inside the poll loop
 * before anything else, so those seconds are seconds in which the mailbox is not being polled and
 * the process is not answering anything, chosen by whoever sent the message.
 *
 * The fix is not a new guard. `@recueil/rules` has had a linear-time engine with a step budget and
 * a clock since Phase 2; it was written for the ingestion rule engine and simply was not on this
 * path. That is the whole lesson of the finding, so the test asserts the reproduction is fast and
 * a separate test asserts that a match which genuinely runs out of budget is *refused by name*
 * rather than answered wrongly or swallowed.
 */
import { describe, expect, it } from 'vitest';

import {
  MAIL_RULE_MAX_STEPS,
  evaluateMailRule,
  evaluateMailRules,
  mailRuleMatches,
  skippedBy,
} from '../src/index.js';
import type { MailEnvelope, MailRule } from '../src/index.js';

/** The pattern from the review. Catastrophic under a backtracking engine, ordinary under a VM. */
const PLAIN_WORDS = '^(\\w+\\s?)*$';

const envelopeWith = (subject: string): MailEnvelope => ({
  from: 'A Stranger <stranger@example.org>',
  subject,
  recipients: ['post@example.org'],
});

describe('mail rules run under a budget (H2)', () => {
  it('answers the review’s catastrophic subject in milliseconds, not in minutes', () => {
    const rules: MailRule[] = [
      { id: 'plain-words', match: { subject: PLAIN_WORDS }, actions: { skip: true } },
    ];

    // 21, 29, 33 and 45 are the reviewer's lengths. The last two are the ones that mattered: 33
    // took 45 seconds against the shipped code and 45 never came back at all.
    for (const length of [21, 29, 33, 45, 64]) {
      const subject = `${'a'.repeat(length)}!`;
      const started = Date.now();
      const skip = skippedBy(rules, envelopeWith(subject));
      const elapsed = Date.now() - started;

      // The subject does not match the rule — it ends in `!` — so nothing is skipped. What is
      // being asserted is that finding that out is cheap.
      expect(skip).toBeNull();
      expect(elapsed).toBeLessThan(500);
    }
  });

  it('answers a subject long past the point where the old engine never returned', () => {
    const rule: MailRule = {
      id: 'plain-words',
      match: { subject: PLAIN_WORDS },
      actions: { skip: true },
    };
    const started = Date.now();
    expect(mailRuleMatches(rule, envelopeWith(`${'a'.repeat(200)}!`))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses a match that runs out of steps, and names the limit', () => {
    // Eighteen thousand characters of subject is not a subject; it is an attack on the matcher.
    // The step budget is deterministic — eleven steps per character for a pattern of this shape —
    // so this refusal happens on every machine at the same input, which a wall clock cannot
    // promise.
    const rule: MailRule = {
      id: 'plain-words',
      match: { subject: PLAIN_WORDS },
      actions: { skip: true },
    };
    const started = Date.now();
    const evaluation = evaluateMailRule(rule, envelopeWith('a'.repeat(40_000)));
    expect(Date.now() - started).toBeLessThan(1_000);

    // Not decided, therefore not matched — and recorded, not swallowed (P3).
    expect(evaluation.matched).toBe(false);
    expect(evaluation.refusals).toHaveLength(1);
    const refusal = evaluation.refusals[0]!;
    expect(refusal.ruleId).toBe('plain-words');
    expect(refusal.clause).toBe('subject');
    expect(refusal.reason).toContain(String(MAIL_RULE_MAX_STEPS));
    expect(refusal.reason).toContain('steps');
  });

  it('does not skip a message whose skip rule could not be decided', () => {
    // The direction matters. A `skip` rule that cannot be evaluated must leave the message to be
    // ingested and looked at, because the alternative is that a stranger who can stall the matcher
    // can also decide which of your mail is silently discarded.
    const rules: MailRule[] = [
      { id: 'plain-words', match: { subject: PLAIN_WORDS }, actions: { skip: true } },
    ];
    const outcome = evaluateMailRules(rules, envelopeWith('a'.repeat(40_000)));
    expect(outcome.skip).toBeNull();
    expect(outcome.matched).toEqual([]);
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0]?.reason).toContain('steps');
  });

  it('reports a pattern this engine cannot compile instead of throwing out of the poll loop', () => {
    // `@recueil/rules` implements a deliberate subset: no lookaround, no backreferences, because
    // neither can be simulated in linear time. A rule using one is an operator's mistake, not a
    // reason for `poll()` to throw, so it becomes a refusal with the reason attached.
    const rule: MailRule = {
      id: 'lookahead',
      match: { subject: '(?=Rechnung)' },
      actions: { skip: true },
    };
    const evaluation = evaluateMailRule(rule, envelopeWith('Rechnung R-77'));
    expect(evaluation.matched).toBe(false);
    expect(evaluation.refusals).toHaveLength(1);
    expect(evaluation.refusals[0]?.clause).toBe('subject');
    expect(evaluation.refusals[0]?.reason.length).toBeGreaterThan(0);
  });

  it('still matches the ordinary rules, which is the thing the budget must not break', () => {
    const envelope: MailEnvelope = {
      from: 'Stadtwerke Ulm <billing@stadtwerke.example>',
      subject: 'Ihre Rechnung R-77',
      recipients: ['post@example.org'],
    };
    const rule: MailRule = {
      id: 'utilities',
      match: { from: 'stadtwerke\\.example', subject: 'Rechnung' },
      actions: { addTags: ['utilities'] },
    };
    expect(mailRuleMatches(rule, envelope)).toBe(true);
    expect(mailRuleMatches(rule, { ...envelope, subject: 'IHRE RECHNUNG' })).toBe(true);
    expect(mailRuleMatches(rule, { ...envelope, subject: 'Mahnung' })).toBe(false);
    expect(evaluateMailRule(rule, envelope).refusals).toEqual([]);
  });
});
