/**
 * The ingestion facet: leaf conditions over an `IngestionSubject`, actions into an `IngestionDraft`.
 *
 * The two things that are easy to get wrong, and are therefore done here rather than left to the
 * caller:
 *
 * - **Paths are normalised before they are matched.** `photos/../../etc/shadow` becomes
 *   `../etc/shadow`, which `photos/**` does not match, and the trace says the path was rewritten
 *   and that it climbed above its own root. A rule engine that globbed the raw string would let a
 *   crafted archive entry file itself wherever it liked.
 * - **Long text is truncated with the truncation on the record.** A `text` condition against a
 *   200 MB OCR dump is bounded by `limits.maxTextLength`; when that bites, the trace says so, so a
 *   "did not match" is never mistaken for "is not in the document".
 */
import { applyMatcher, applyMatcherToAny, describeMatcher } from '../match.js';
import { basename, normalisePath } from '../path.js';
import { interpolate } from '../interpolate.js';
import type { ActionContext, EvaluationContext, RuleFacet } from '../engine.js';
import type { ActionTrace, ConditionTrace } from '../trace.js';
import type { IngestionAction, IngestionCondition } from '../schema/ingestion.js';
import type { Matcher } from '../schema/matchers.js';
import { IngestionDraft } from './outcome.js';
import type { IngestionOutcome } from './outcome.js';
import type { IngestionSubject } from './subject.js';

const limitsFor = (context: EvaluationContext) => ({
  maxSteps: context.limits.maxSteps,
  timeoutMs: context.limits.timeoutMs,
});

/** Turn a `MatchResult` into a trace node, and harvest its captures when we are allowed to. */
const leaf = (
  type: string,
  result: ReturnType<typeof applyMatcher>,
  context: EvaluationContext,
  extra?: string,
): ConditionTrace => {
  if (result.captures !== undefined && context.collecting) {
    for (const [name, value] of Object.entries(result.captures)) context.captures.set(name, value);
  }
  return {
    type,
    matched: result.matched,
    detail: extra === undefined ? result.detail : `${result.detail} (${extra})`,
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

/** The extracted text a `text` condition sees, bounded, with a warning when the bound bit. */
const boundedText = (subject: IngestionSubject, context: EvaluationContext): { text: string | undefined; note?: string } => {
  if (subject.text === undefined) return { text: undefined };
  if (subject.text.length <= context.limits.maxTextLength) return { text: subject.text };
  const note = `text truncated to ${context.limits.maxTextLength} of ${subject.text.length} characters`;
  context.warnings.push(`${subject.id}: ${note}; a text condition saw only the beginning of the document`);
  return { text: subject.text.slice(0, context.limits.maxTextLength), note };
};

const evaluateLeaf = (condition: IngestionCondition, subject: IngestionSubject, context: EvaluationContext): ConditionTrace => {
  if (!('type' in condition)) {
    // The engine handles `all`, `any` and `not`, so one reaching here is a bug in the engine rather
    // than in the rule set. Reported as an error so it cannot be mistaken for a non-match.
    return { type: 'unknown', matched: false, detail: 'composite condition reached the facet', error: 'composite condition reached the facet' };
  }
  const limits = limitsFor(context);
  const match = (value: string | undefined, matcher: Matcher): ReturnType<typeof applyMatcher> =>
    applyMatcher(matcher, value, limits);

  switch (condition.type) {
    case 'always':
      return { type: 'always', matched: true, detail: 'matches everything' };

    case 'source':
      return leaf('source', match(subject.source, condition.match), context);

    case 'sender':
      return leaf('sender', match(subject.sender, condition.match), context);

    case 'subject':
      return leaf('subject', match(subject.subject, condition.match), context);

    case 'mime':
      return leaf('mime', match(subject.mime, condition.match), context);

    case 'item-type':
      return leaf('item-type', match(subject.itemType, condition.match), context);

    case 'recipient':
      return leaf('recipient', applyMatcherToAny(condition.match, subject.recipients, 'recipients', limits), context);

    case 'tag':
      return leaf('tag', applyMatcherToAny(condition.match, subject.tags, 'tags', limits), context);

    case 'path': {
      if (subject.path === undefined) {
        return { type: 'path', matched: false, detail: `no path on this subject; the rule wanted one that ${describeMatcher(condition.match)}` };
      }
      const normalised = normalisePath(subject.path);
      const notes: string[] = [];
      if (normalised.changed) notes.push(`normalised from ${JSON.stringify(subject.path)}`);
      if (normalised.escaped) {
        notes.push('this path climbs above its own root');
        context.warnings.push(`${subject.id}: source path ${JSON.stringify(subject.path)} climbs above its own root`);
      }
      return leaf('path', match(normalised.path, condition.match), context, notes.length > 0 ? notes.join('; ') : undefined);
    }

    case 'filename': {
      const name = subject.filename ?? (subject.path === undefined ? undefined : basename(subject.path));
      return leaf('filename', match(name, condition.match), context);
    }

    case 'text': {
      const { text, note } = boundedText(subject, context);
      return leaf('text', match(text, condition.match), context, note);
    }

    case 'resolver': {
      const wanted = Array.isArray(condition.outcome) ? condition.outcome : [condition.outcome];
      const candidates = (subject.resolvers ?? []).filter(
        (entry) => condition.resolver === undefined || entry.resolver === condition.resolver,
      );
      const named = condition.resolver === undefined ? 'any resolver' : condition.resolver;
      if (candidates.length === 0) {
        return { type: 'resolver', matched: false, detail: `no result from ${named}; the rule wanted ${wanted.join(' or ')}` };
      }
      const hit = candidates.find(
        (entry) =>
          wanted.includes(entry.outcome) &&
          (condition.minConfidence === undefined || (entry.confidence ?? 0) >= condition.minConfidence),
      );
      if (hit === undefined) {
        const seen = candidates.map((entry) => `${entry.resolver}=${entry.outcome}`).join(', ');
        return {
          type: 'resolver',
          matched: false,
          detail: `${named} came back with ${seen}; the rule wanted ${wanted.join(' or ')}${condition.minConfidence === undefined ? '' : ` at confidence ${condition.minConfidence}`}`,
        };
      }
      return {
        type: 'resolver',
        matched: true,
        detail: `${hit.resolver} came back ${hit.outcome}${hit.confidence === undefined ? '' : ` at confidence ${hit.confidence}`}`,
        ...(hit.identifier === undefined ? {} : { evidence: hit.identifier }),
      };
    }

    default: {
      const unexpected = condition as { type: string };
      return { type: unexpected.type, matched: false, detail: 'unknown condition type', error: `unknown condition type ${unexpected.type}` };
    }
  }
};

/** Resolve `${name}` in an action value, or explain which capture was missing. */
const resolveTemplate = (
  template: string,
  context: ActionContext,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly detail: string } => {
  const result = interpolate(template, context.captures);
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    detail: `skipped: ${JSON.stringify(template)} needs ${result.missing.map((name) => `\${${name}}`).join(', ')}, which no condition in this rule captured`,
  };
};

const applyAction = (
  action: IngestionAction,
  _subject: IngestionSubject,
  draft: IngestionDraft,
  context: ActionContext,
): ActionTrace => {
  draft.matched = true;
  const applied = (detail: string): ActionTrace => ({ type: action.type, outcome: 'applied', detail });
  const skipped = (detail: string): ActionTrace => ({ type: action.type, outcome: 'skipped', detail });

  switch (action.type) {
    case 'set-item-type': {
      const next = { value: action.itemType, ruleId: context.ruleId };
      draft.noteConflict('itemType', draft.itemType, next);
      const previous = draft.itemType;
      draft.itemType = next;
      return applied(previous === undefined ? `item type ${action.itemType}` : `item type ${action.itemType}, over ${previous.value} from ${previous.ruleId}`);
    }

    case 'set-correspondent': {
      const resolved = resolveTemplate(action.correspondent, context);
      if (!resolved.ok) return skipped(resolved.detail);
      const next = { value: resolved.value, ruleId: context.ruleId };
      draft.noteConflict('correspondent', draft.correspondent, next);
      draft.correspondent = next;
      return applied(`correspondent ${JSON.stringify(resolved.value)}`);
    }

    case 'set-confidence': {
      const next = { value: action.confidence, ruleId: context.ruleId };
      draft.noteConflict('confidence', draft.confidence, next);
      draft.confidence = next;
      return applied(`confidence ${action.confidence}`);
    }

    case 'add-to-collection': {
      const resolved = resolveTemplate(action.collection, context);
      if (!resolved.ok) return skipped(resolved.detail);
      if (draft.hasCollection(resolved.value)) return skipped(`already in ${JSON.stringify(resolved.value)}`);
      draft.collections.push({ value: resolved.value, ruleId: context.ruleId, create: action.create ?? true });
      return applied(`collection ${JSON.stringify(resolved.value)}`);
    }

    case 'add-tags': {
      const added: string[] = [];
      const skippedTags: string[] = [];
      for (const tag of action.tags) {
        const resolved = resolveTemplate(tag, context);
        if (!resolved.ok) {
          skippedTags.push(resolved.detail);
          continue;
        }
        if (draft.hasTag(resolved.value)) continue;
        draft.tags.push({ value: resolved.value, ruleId: context.ruleId });
        added.push(resolved.value);
      }
      if (added.length === 0) {
        return skipped(skippedTags.length > 0 ? skippedTags.join('; ') : 'every tag was already present');
      }
      const note = skippedTags.length === 0 ? '' : ` (${skippedTags.length} skipped: ${skippedTags.join('; ')})`;
      return applied(`tags ${added.join(', ')}${note}`);
    }

    case 'set-custom-field': {
      let value = action.value;
      if (typeof value === 'string') {
        const resolved = resolveTemplate(value, context);
        if (!resolved.ok) return skipped(resolved.detail);
        value = resolved.value;
      }
      const next = { value, ruleId: context.ruleId };
      const existing = draft.customFields.find((entry) => entry.field === action.field);
      draft.noteConflict(`customField:${action.field}`, existing, next);
      if (existing !== undefined) {
        draft.customFields.splice(draft.customFields.indexOf(existing), 1);
      }
      draft.customFields.push({ field: action.field, value, ruleId: context.ruleId });
      return applied(`${action.field} = ${JSON.stringify(value)}`);
    }

    case 'route-to-review': {
      const resolved = resolveTemplate(action.explanation, context);
      if (!resolved.ok) return skipped(resolved.detail);
      draft.review.push({
        reasonCode: action.reasonCode,
        explanation: resolved.value,
        severity: action.severity ?? 'warning',
        ...(action.proposedAction === undefined ? {} : { proposedAction: action.proposedAction }),
        ruleId: context.ruleId,
      });
      return applied(`review queue: ${action.reasonCode} — ${resolved.value}`);
    }

    case 'stop': {
      draft.stopped = true;
      return applied('evaluation stops here');
    }
  }
};

export const ingestionFacet: RuleFacet<IngestionSubject, IngestionCondition, IngestionAction, IngestionDraft, IngestionOutcome> = {
  kind: 'ingestion',
  evaluateLeaf,
  createDraft: () => new IngestionDraft(),
  applyAction,
  isStopped: (draft) => draft.stopped,
  finish: (draft) => draft.finish(),
};
