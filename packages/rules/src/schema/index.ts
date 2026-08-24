/**
 * The rule set as a whole: one document, two facets, one version number.
 */
import * as z from 'zod';

import { DedupRuleSetSchema } from './dedup.js';
import { IngestionRuleSetSchema } from './ingestion.js';

export const RuleSetSchema = z.discriminatedUnion('kind', [IngestionRuleSetSchema, DedupRuleSetSchema]).meta({
  id: 'RuleSet',
  title: 'Recueil rule set',
  description:
    'A versioned, declarative set of rules, in YAML or JSON. `kind: ingestion` drives CONCEPT.md ' +
    '§5.3 stage 8; `kind: dedup` drives §5.6. Both share the envelope, the precedence and the trace.',
});

export type RuleSet = z.infer<typeof RuleSetSchema>;

export * from './common.js';
export * from './matchers.js';
export * from './ingestion.js';
export * from './dedup.js';
