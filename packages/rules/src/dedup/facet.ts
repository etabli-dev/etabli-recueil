/**
 * The dedup facet: leaf conditions over a candidate pair, actions into a proposed decision.
 *
 * CONCEPT.md §5.6 wants merge rules editable as YAML with a dry run before execution, and this is
 * the half of that which can be built and tested without the dedup engine existing: given two
 * records, which rule fires and what does it propose. Nothing here merges anything. The outcome is
 * a decision with the rule and the winner rule attached, and the Phase 3 engine is what turns it
 * into a merge, a trash record and a reversible merge log.
 *
 * Identifiers are compared with `=`. Invariant B1 (`spec/data-model.md` §3.5) says they are stored
 * normalised, so a second normalisation here would be either redundant or a way of quietly matching
 * two values the database considers different. If a caller passes unnormalised identifiers, the
 * comparison is wrong, and that is the caller's bug to fix at the source rather than this module's
 * to paper over.
 */
import { applyMatcher, describeMatcher } from '../match.js';
import { nameOverlap, normaliseForComparison, similarity } from './similarity.js';
import type { ActionContext, EvaluationContext, RuleFacet } from '../engine.js';
import type { ActionTrace, ConditionTrace } from '../trace.js';
import type { DedupAction, DedupCondition } from '../schema/dedup.js';
import { DedupDraft } from './outcome.js';
import type { DedupOutcome } from './outcome.js';
import type { DedupField, DedupPair, DedupSide } from './subject.js';

const readField = (side: DedupSide, field: DedupField): string | undefined => {
  switch (field) {
    case 'source':
      return side.source;
    case 'item-type':
      return side.itemType;
    case 'title':
      return side.title;
    case 'venue':
      return side.venue;
    case 'correspondent':
      return side.correspondent;
    case 'container':
      return side.container;
  }
};

/**
 * A similarity leaf, with `undefined` kept apart from a low score.
 *
 * `similarity` and `nameOverlap` return `undefined` when a side is longer than the measure is
 * allowed to read, which is a refusal and not a verdict: a title a hostile PDF made a megabyte long
 * must send the pair to a human, not score 0 and be filed as "not a duplicate". That is the same
 * rule the matchers follow for an undecidable regex, and the engine turns it into a rule outcome
 * of `error`.
 */
const scored = (type: string, score: number | undefined, atLeast: number, what: string, limit: number): ConditionTrace => {
  if (score === undefined) {
    const detail = `${what} could not be measured: a value exceeds the limit of ${limit} characters (maxInputLength)`;
    return { type, matched: false, detail, error: detail };
  }
  return {
    type,
    matched: score >= atLeast,
    detail: `${what} similarity ${score.toFixed(3)} ${score >= atLeast ? '≥' : '<'} ${atLeast}`,
  };
};

const sharedIdentifiers = (pair: DedupPair, identifier: string | undefined): readonly [string, string][] => {
  const left = pair.left.identifiers ?? {};
  const right = pair.right.identifiers ?? {};
  const keys = identifier === undefined ? Object.keys(left) : [identifier];
  return keys
    .filter((key) => left[key] !== undefined && right[key] !== undefined && left[key] === right[key])
    .map((key) => [key, left[key]!] as [string, string]);
};

const conflictingIdentifiers = (pair: DedupPair, identifier: string | undefined): readonly [string, string, string][] => {
  const left = pair.left.identifiers ?? {};
  const right = pair.right.identifiers ?? {};
  const keys = identifier === undefined ? Object.keys(left) : [identifier];
  return keys
    .filter((key) => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key])
    .map((key) => [key, left[key]!, right[key]!] as [string, string, string]);
};

const evaluateLeaf = (condition: DedupCondition, pair: DedupPair, context: EvaluationContext): ConditionTrace => {
  if (!('type' in condition)) {
    return { type: 'unknown', matched: false, detail: 'composite condition reached the facet', error: 'composite condition reached the facet' };
  }
  const limits = {
    maxSteps: context.limits.maxSteps,
    timeoutMs: context.limits.timeoutMs,
    maxInputLength: context.limits.maxInputLength,
  };

  switch (condition.type) {
    case 'always':
      return { type: 'always', matched: true, detail: 'matches every pair' };

    case 'identifier-match': {
      const shared = sharedIdentifiers(pair, condition.identifier);
      const named = condition.identifier ?? 'any identifier';
      return shared.length === 0
        ? { type: 'identifier-match', matched: false, detail: `the two sides share no value for ${named}` }
        : {
            type: 'identifier-match',
            matched: true,
            detail: `both sides carry ${shared.map(([key]) => key).join(', ')}`,
            evidence: shared.map(([key, value]) => `${key}=${value}`).join(' '),
          };
    }

    case 'identifier-conflict': {
      const conflicts = conflictingIdentifiers(pair, condition.identifier);
      const named = condition.identifier ?? 'any identifier';
      return conflicts.length === 0
        ? { type: 'identifier-conflict', matched: false, detail: `no disagreement on ${named}` }
        : {
            type: 'identifier-conflict',
            matched: true,
            detail: `the two sides disagree on ${conflicts.map(([key]) => key).join(', ')}`,
            evidence: conflicts.map(([key, left, right]) => `${key}: ${left} vs ${right}`).join('; '),
          };
    }

    case 'file-hash-match': {
      const right = new Set(pair.right.hashes ?? []);
      const shared = (pair.left.hashes ?? []).find((hash) => right.has(hash));
      return shared === undefined
        ? { type: 'file-hash-match', matched: false, detail: 'the two sides share no document hash' }
        : { type: 'file-hash-match', matched: true, detail: 'the two sides share a document hash', evidence: shared };
    }

    case 'title-similarity':
      return scored('title-similarity', similarity(pair.left.title, pair.right.title, limits), condition.atLeast, 'title', limits.maxInputLength);

    case 'venue-similarity':
      return scored('venue-similarity', similarity(pair.left.venue, pair.right.venue, limits), condition.atLeast, 'venue', limits.maxInputLength);

    case 'creator-similarity': {
      const left = condition.firstOnly === true ? (pair.left.creators ?? []).slice(0, 1) : pair.left.creators;
      const right = condition.firstOnly === true ? (pair.right.creators ?? []).slice(0, 1) : pair.right.creators;
      const score = nameOverlap(left, right, limits);
      return scored(
        'creator-similarity',
        score,
        condition.atLeast,
        condition.firstOnly === true ? 'first creator' : 'creator',
        limits.maxInputLength,
      );
    }

    case 'year-within': {
      const left = pair.left.year;
      const right = pair.right.year;
      if (left === undefined || right === undefined) {
        return { type: 'year-within', matched: false, detail: 'one of the two sides has no year' };
      }
      const distance = Math.abs(left - right);
      return {
        type: 'year-within',
        matched: distance <= condition.years,
        detail: `${left} and ${right} are ${distance} apart; the rule allows ${condition.years}`,
      };
    }

    case 'same-field': {
      const left = normaliseForComparison(readField(pair.left, condition.field) ?? '');
      const right = normaliseForComparison(readField(pair.right, condition.field) ?? '');
      if (left.length === 0 || right.length === 0) {
        return { type: 'same-field', matched: false, detail: `one of the two sides has no ${condition.field}` };
      }
      return {
        type: 'same-field',
        matched: left === right,
        detail: left === right ? `both sides have ${condition.field} ${JSON.stringify(left)}` : `${JSON.stringify(left)} is not ${JSON.stringify(right)}`,
      };
    }

    case 'field': {
      const side = condition.side ?? 'either';
      const leftValue = readField(pair.left, condition.field);
      const rightValue = readField(pair.right, condition.field);
      const wanted = describeMatcher(condition.match);
      const left = applyMatcher(condition.match, leftValue, limits);
      const right = applyMatcher(condition.match, rightValue, limits);
      const error = left.error ?? right.error;
      const matched =
        side === 'left' ? left.matched : side === 'right' ? right.matched : side === 'both' ? left.matched && right.matched : left.matched || right.matched;
      return {
        type: 'field',
        matched: error === undefined && matched,
        detail: `${condition.field} on ${side} — left: ${left.detail}; right: ${right.detail}; the rule wanted ${wanted}`,
        ...(error === undefined ? {} : { error }),
      };
    }

    default: {
      const unexpected = condition as { type: string };
      return { type: unexpected.type, matched: false, detail: 'unknown condition type', error: `unknown condition type ${unexpected.type}` };
    }
  }
};

const applyAction = (action: DedupAction, _pair: DedupPair, draft: DedupDraft, context: ActionContext): ActionTrace => {
  draft.matched = true;
  const applied = (detail: string): ActionTrace => ({ type: action.type, outcome: 'applied', detail });

  switch (action.type) {
    case 'merge': {
      const next = { value: 'merge' as const, ruleId: context.ruleId };
      draft.noteConflict('decision', draft.decision, next);
      draft.decision = next;
      draft.winner = { value: action.winner, ruleId: context.ruleId };
      return applied(`merge, winner by ${action.winner}`);
    }
    case 'link': {
      const next = { value: 'link' as const, ruleId: context.ruleId };
      draft.noteConflict('decision', draft.decision, next);
      draft.decision = next;
      return applied('link the candidate to the existing item');
    }
    case 'ignore': {
      const next = { value: 'ignore' as const, ruleId: context.ruleId };
      draft.noteConflict('decision', draft.decision, next);
      draft.decision = next;
      return applied('not a duplicate');
    }
    case 'flag': {
      const next = { value: 'flag' as const, ruleId: context.ruleId };
      draft.noteConflict('decision', draft.decision, next);
      draft.decision = next;
      draft.review.push({
        reasonCode: action.reasonCode ?? 'record_merge_candidate',
        explanation: action.explanation,
        severity: action.severity ?? 'warning',
        ruleId: context.ruleId,
      });
      return applied(`review queue: ${action.explanation}`);
    }
    case 'set-confidence': {
      const next = { value: action.confidence, ruleId: context.ruleId };
      draft.noteConflict('confidence', draft.confidence, next);
      draft.confidence = next;
      return applied(`confidence ${action.confidence}`);
    }
    case 'stop': {
      draft.stopped = true;
      return applied('evaluation stops here');
    }
  }
};

export const dedupFacet: RuleFacet<DedupPair, DedupCondition, DedupAction, DedupDraft, DedupOutcome> = {
  kind: 'dedup',
  evaluateLeaf,
  createDraft: () => new DedupDraft(),
  applyAction,
  isStopped: (draft) => draft.stopped,
  finish: (draft) => draft.finish(),
};
