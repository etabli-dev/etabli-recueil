/**
 * Validating rules that arrived as JSON.
 *
 * §5.6 says rules are edited as YAML or JSON in the UI, which means they arrive from outside the
 * program and have to be checked before they are trusted — including their regular expressions,
 * which are the one part of a rule that can be syntactically valid JSON and still not compile.
 * An operator who has just typed `(\d{4}` deserves to be told at save time and not to discover it
 * as a rule that silently never fires.
 *
 * The validator collects every problem rather than throwing on the first, because a rule set that
 * reports one error per save is a rule set nobody finishes editing.
 */
import { ValidationError } from '@recueil/core';

import { DETECTED_TYPES, IDENTIFIER_SCHEMES } from '../types.js';
import type { IngestRule, RuleMatch, RulePattern } from './types.js';

export interface RuleProblem {
  ruleId: string | null;
  path: string;
  message: string;
}

export interface ParseRulesResult {
  rules: IngestRule[];
  problems: RuleProblem[];
}

const DETECTED = new Set<string>(DETECTED_TYPES);
const SCHEMES = new Set<string>(IDENTIFIER_SCHEMES);
const SOURCE_KINDS = new Set([
  'upload',
  'folder',
  'webdav',
  'imap',
  'scanner',
  'connector',
  'mobile',
  'import',
  'api',
  'plugin',
  'derived',
]);

/** Check a rule set. Valid rules come back; every problem is reported, none is silently dropped. */
export const parseRules = (input: unknown): ParseRulesResult => {
  const problems: RuleProblem[] = [];
  const rules: IngestRule[] = [];

  if (!Array.isArray(input)) {
    return { rules, problems: [{ ruleId: null, path: '', message: 'the rule set is not an array' }] };
  }

  const seen = new Set<string>();

  input.forEach((raw, index) => {
    const at = `[${index}]`;
    if (typeof raw !== 'object' || raw === null) {
      problems.push({ ruleId: null, path: at, message: 'a rule must be an object' });
      return;
    }
    const candidate = raw as Record<string, unknown>;
    const id = candidate['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      problems.push({ ruleId: null, path: `${at}.id`, message: 'a rule needs a non-empty string id' });
      return;
    }
    if (seen.has(id)) {
      problems.push({ ruleId: id, path: `${at}.id`, message: `duplicate rule id '${id}'` });
      return;
    }
    seen.add(id);

    const before = problems.length;
    const match = validateMatch(candidate['match'], `${at}.match`, id, problems);
    const actions = validateActions(candidate['actions'], `${at}.actions`, id, problems);
    if (problems.length !== before) return;

    const rule: IngestRule = { id, match, actions };
    if (typeof candidate['title'] === 'string') rule.title = candidate['title'];
    if (typeof candidate['enabled'] === 'boolean') rule.enabled = candidate['enabled'];
    if (typeof candidate['priority'] === 'number') rule.priority = candidate['priority'];
    if (typeof candidate['stopOnMatch'] === 'boolean') rule.stopOnMatch = candidate['stopOnMatch'];
    rules.push(rule);
  });

  return { rules, problems };
};

/** The same check, but a throw rather than a report. For a caller that has nowhere to show them. */
export const parseRulesOrThrow = (input: unknown): IngestRule[] => {
  const { rules, problems } = parseRules(input);
  if (problems.length > 0) {
    throw new ValidationError(
      `The ingestion rule set has ${problems.length} problem(s): ` +
        problems.map((problem) => `${problem.path}: ${problem.message}`).join('; '),
    );
  }
  return rules;
};

const validateMatch = (
  raw: unknown,
  path: string,
  ruleId: string,
  problems: RuleProblem[],
): RuleMatch => {
  if (typeof raw !== 'object' || raw === null) {
    problems.push({ ruleId, path, message: 'match must be an object' });
    return {};
  }
  const source = raw as Record<string, unknown>;
  const match: RuleMatch = {};

  const sourceKind = stringArray(
    source['sourceKind'],
    `${path}.sourceKind`,
    ruleId,
    problems,
    SOURCE_KINDS,
  );
  if (sourceKind !== null) match.sourceKind = sourceKind as RuleMatch['sourceKind'];

  const sourceId = stringArray(source['sourceId'], `${path}.sourceId`, ruleId, problems);
  if (sourceId !== null) match.sourceId = sourceId;

  const mediaType = stringArray(source['mediaType'], `${path}.mediaType`, ruleId, problems);
  if (mediaType !== null) match.mediaType = mediaType;

  const detectedType = stringArray(
    source['detectedType'],
    `${path}.detectedType`,
    ruleId,
    problems,
    DETECTED,
  );
  if (detectedType !== null) match.detectedType = detectedType as RuleMatch['detectedType'];

  const hasIdentifier = stringArray(
    source['hasIdentifier'],
    `${path}.hasIdentifier`,
    ruleId,
    problems,
    SCHEMES,
  );
  if (hasIdentifier !== null) match.hasIdentifier = hasIdentifier as RuleMatch['hasIdentifier'];

  const resolvedBy = stringArray(source['resolvedBy'], `${path}.resolvedBy`, ruleId, problems);
  if (resolvedBy !== null) match.resolvedBy = resolvedBy;

  for (const key of ['path', 'filename', 'sender', 'subject', 'text'] as const) {
    const pattern = validatePattern(source[key], `${path}.${key}`, ruleId, problems);
    if (pattern !== null) match[key] = pattern;
  }

  for (const key of ['minConfidence', 'maxConfidence'] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || value < 0 || value > 1) {
      problems.push({ ruleId, path: `${path}.${key}`, message: 'must be a number within 0..1' });
      continue;
    }
    match[key] = value;
  }

  return match;
};

const validateActions = (
  raw: unknown,
  path: string,
  ruleId: string,
  problems: RuleProblem[],
): IngestRule['actions'] => {
  if (typeof raw !== 'object' || raw === null) {
    problems.push({ ruleId, path, message: 'actions must be an object' });
    return {};
  }
  const source = raw as Record<string, unknown>;
  const actions: IngestRule['actions'] = {};

  if (source['itemType'] !== undefined) {
    if (typeof source['itemType'] !== 'string' || source['itemType'].length === 0) {
      problems.push({ ruleId, path: `${path}.itemType`, message: 'must be a non-empty string' });
    } else {
      actions.itemType = source['itemType'];
    }
  }

  const tags = stringArray(source['addTags'], `${path}.addTags`, ruleId, problems);
  if (tags !== null) actions.addTags = tags;

  const collections = stringArray(
    source['addCollectionIds'],
    `${path}.addCollectionIds`,
    ruleId,
    problems,
  );
  if (collections !== null) actions.addCollectionIds = collections;

  for (const key of ['setFields', 'setCustomFields'] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push({ ruleId, path: `${path}.${key}`, message: 'must be an object' });
      continue;
    }
    actions[key] = value as Record<string, never>;
  }

  if (source['confidenceDelta'] !== undefined) {
    const delta = source['confidenceDelta'];
    if (typeof delta !== 'number' || delta < -1 || delta > 1) {
      problems.push({
        ruleId,
        path: `${path}.confidenceDelta`,
        message: 'must be a number within -1..1',
      });
    } else {
      actions.confidenceDelta = delta;
    }
  }

  for (const key of ['review', 'stop'] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null) {
      problems.push({ ruleId, path: `${path}.${key}`, message: 'must be an object' });
      continue;
    }
    const nested = value as Record<string, unknown>;
    if (typeof nested['reasonCode'] !== 'string' || nested['reasonCode'].length === 0) {
      problems.push({
        ruleId,
        path: `${path}.${key}.reasonCode`,
        message: 'must be a non-empty string',
      });
      continue;
    }
    if (typeof nested['explanation'] !== 'string' || nested['explanation'].length === 0) {
      problems.push({
        ruleId,
        path: `${path}.${key}.explanation`,
        message: 'must be a non-empty sentence a person will read',
      });
      continue;
    }
    actions[key] = nested as never;
  }

  return actions;
};

const validatePattern = (
  raw: unknown,
  path: string,
  ruleId: string,
  problems: RuleProblem[],
): RulePattern | null => {
  if (raw === undefined) return null;
  if (typeof raw === 'string') return validatePattern({ pattern: raw }, path, ruleId, problems);
  if (typeof raw !== 'object' || raw === null) {
    problems.push({ ruleId, path, message: 'must be a string or a { pattern, flags } object' });
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const pattern = candidate['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    problems.push({ ruleId, path: `${path}.pattern`, message: 'must be a non-empty string' });
    return null;
  }
  const flags = candidate['flags'];
  if (flags !== undefined && typeof flags !== 'string') {
    problems.push({ ruleId, path: `${path}.flags`, message: 'must be a string' });
    return null;
  }
  try {
    const set = new Set([...((flags as string | undefined) ?? ''), 'u']);
    set.delete('g');
    set.delete('y');
    // eslint-disable-next-line no-new
    new RegExp(pattern, [...set].join(''));
  } catch (error) {
    problems.push({
      ruleId,
      path,
      message: `is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  return flags === undefined ? { pattern } : { pattern, flags: flags as string };
};

const stringArray = (
  raw: unknown,
  path: string,
  ruleId: string,
  problems: RuleProblem[],
  vocabulary?: ReadonlySet<string>,
): string[] | null => {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    problems.push({ ruleId, path, message: 'must be an array of strings' });
    return null;
  }
  const values = raw as string[];
  if (vocabulary !== undefined) {
    const unknown = values.filter((value) => !vocabulary.has(value));
    if (unknown.length > 0) {
      problems.push({
        ruleId,
        path,
        message: `unknown value(s) ${unknown.join(', ')}; expected one of ${[...vocabulary].join(', ')}`,
      });
      return null;
    }
  }
  return values;
};
