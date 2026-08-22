/**
 * Scopes: what a token is allowed to do.
 *
 * `spec/data-model.md` §3.2 gives the shape — "array of scope strings (`items:read`, `sr:write`,
 * `analytics:read`, …)" — and CONCEPT.md §5.12 adds that scopes are "resource-and-verb pairs
 * (`items:read`, `sr:write`, `admin:*`)". This module is the whole of the authorisation model, and
 * it is deliberately small: three rules, no roles, no inheritance graph.
 *
 * 1. **A scope is `resource:verb`.** Either half may be the wildcard `*`.
 * 2. **`write` implies `read` on the same resource.** A client that may replace an item may
 *    certainly look at one, and forcing every caller to hold both halves produces token lists full
 *    of `items:read, items:write` and nothing gained.
 * 3. **`admin:*` is every scope.** It is the shape CONCEPT.md names, so it is the shape honoured,
 *    and it is spelled out rather than implied so that a token list reads truthfully.
 *
 * Everything else is a refusal. An unknown resource in a *granted* scope grants nothing rather than
 * failing loudly, because a token minted by a newer server and read by an older one should lose
 * privileges, never gain them.
 */

/** The verbs. `read` is safe; `write` covers create, update, trash and restore. */
export const SCOPE_VERBS = ['read', 'write'] as const;

export type ScopeVerb = (typeof SCOPE_VERBS)[number];

/**
 * The resources the v1 surface divides into.
 *
 * One entry per group of endpoints a person would sensibly grant separately. `export` is its own
 * resource because the tokened `.bib` feed of CONCEPT.md §5.11 exists precisely so that Overleaf
 * can be given a credential that can read a bibliography and nothing else.
 */
export const SCOPE_RESOURCES = [
  'items',
  'documents',
  'attachments',
  'collections',
  'tags',
  'notes',
  'fields',
  'creators',
  'search',
  'export',
  'events',
  'trash',
  'connector',
  'tokens',
  'system',
] as const;

export type ScopeResource = (typeof SCOPE_RESOURCES)[number];

/** Every concrete scope this server knows, for validation and for the token-creation form. */
export const KNOWN_SCOPES: readonly string[] = SCOPE_RESOURCES.flatMap((resource) =>
  SCOPE_VERBS.map((verb) => `${resource}:${verb}`),
);

/** The catch-all a bootstrap or an administrative token holds. */
export const ADMIN_SCOPE = 'admin:*';

export const SCOPE_PATTERN = /^(?:\*|[a-z][a-z0-9_]*):(?:\*|[a-z][a-z0-9_]*)$/;

/** A scope string as it may be *granted*: a known scope, a wildcard form, or `admin:*`. */
export const isGrantableScope = (value: string): boolean =>
  value === ADMIN_SCOPE || SCOPE_PATTERN.test(value);

const split = (scope: string): { resource: string; verb: string } => {
  const separator = scope.indexOf(':');
  return separator === -1
    ? { resource: scope, verb: '*' }
    : { resource: scope.slice(0, separator), verb: scope.slice(separator + 1) };
};

/** Does one granted scope satisfy one required scope? The three rules above, and nothing more. */
export const grantSatisfies = (granted: string, required: string): boolean => {
  if (granted === ADMIN_SCOPE || granted === '*' || granted === '*:*') return true;

  const want = split(required);
  const have = split(granted);

  if (have.resource !== '*' && have.resource !== want.resource) return false;
  if (have.verb === '*' || have.verb === want.verb) return true;

  // Rule 2: write implies read, and only in that direction.
  return have.verb === 'write' && want.verb === 'read';
};

/** Does this set of granted scopes satisfy the requirement? */
export const hasScope = (granted: readonly string[], required: string): boolean =>
  granted.some((scope) => grantSatisfies(scope, required));

/** Read-only in the sense invariant A2 means it: nothing in the set can write anything. */
export const isReadOnly = (granted: readonly string[]): boolean =>
  !granted.some(
    (scope) => scope === ADMIN_SCOPE || split(scope).verb === 'write' || split(scope).verb === '*',
  );
