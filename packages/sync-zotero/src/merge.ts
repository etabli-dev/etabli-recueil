/**
 * The per-field three-way merge (ADR-0025 §4).
 *
 * Pure: projections in, a decision out. Nothing here reads either library, which is what makes
 * the rule small enough to state and to test exhaustively:
 *
 * | base vs Recueil | base vs Zotero | outcome                                       |
 * |-----------------|----------------|-----------------------------------------------|
 * | same            | same           | nothing to do                                 |
 * | same            | changed        | take Zotero's value                           |
 * | changed         | same           | take Recueil's value                          |
 * | changed         | changed, equal | both agree: take it                           |
 * | changed         | changed, differ| conflict — the policy decides                 |
 *
 * Sets (tags, collection memberships) are merged element by element instead: an element either
 * side added is added, an element either side removed is removed. Two people tagging the same item
 * differently is not a conflict.
 */

export type ConflictPolicy = 'review' | 'zotero' | 'recueil';

/** A projection flattened to named scalars and named sets. */
export interface Flat {
  scalars: Record<string, string>;
  sets: Record<string, readonly string[]>;
}

export interface FieldConflict {
  field: string;
  base: string | null;
  recueil: string | null;
  zotero: string | null;
}

export interface MergeResult {
  merged: Flat;
  /** Scalar fields and sets whose merged value differs from Recueil's: they are written locally. */
  toRecueil: string[];
  /** Scalar fields and sets whose merged value differs from Zotero's: they are pushed. */
  toZotero: string[];
  /** Conflicts found in this merge (whatever the policy did with them). */
  conflicts: FieldConflict[];
  /** Fields settled by a person's decision; a write of these may move a Recueil lock. */
  decided: string[];
}

export interface MergeOptions {
  policy: ConflictPolicy;
  /**
   * Fields with an open conflict from an earlier run. Under `review` they are frozen — neither
   * side is written — until the conflict is resolved or both sides come to agree.
   */
  frozen?: ReadonlySet<string>;
  /** Fields Recueil holds a manual lock on (P4): a pull never overwrites them. */
  lockedInRecueil?: ReadonlySet<string>;
  /** A person's decision on an earlier conflict: that side's value wins, whatever the policy. */
  forced?: ReadonlyMap<string, 'zotero' | 'recueil'>;
}

const valueOf = (flat: Flat, field: string): string | null => flat.scalars[field] ?? null;

export const mergeThreeWay = (base: Flat, recueil: Flat, zotero: Flat, options: MergeOptions): MergeResult => {
  const merged: Flat = { scalars: {}, sets: {} };
  const toRecueil: string[] = [];
  const toZotero: string[] = [];
  const conflicts: FieldConflict[] = [];
  const decided: string[] = [];

  const scalarFields = new Set([
    ...Object.keys(base.scalars),
    ...Object.keys(recueil.scalars),
    ...Object.keys(zotero.scalars),
  ]);

  for (const field of [...scalarFields].sort()) {
    const b = valueOf(base, field);
    const r = valueOf(recueil, field);
    const z = valueOf(zotero, field);
    const recueilChanged = r !== b;
    const zoteroChanged = z !== b;

    const forced = options.forced?.get(field);
    if (forced !== undefined) {
      const chosen = forced === 'zotero' ? z : r;
      setScalar(merged, field, chosen);
      decided.push(field);
      if (chosen !== r) toRecueil.push(field);
      if (chosen !== z) toZotero.push(field);
      continue;
    }

    const conflict = recueilChanged && zoteroChanged && r !== z;
    let result: string | null = !zoteroChanged ? r : !recueilChanged ? z : r;
    const locked = options.lockedInRecueil?.has(field) === true;

    if (conflict) {
      conflicts.push({ field, base: b, recueil: r, zotero: z });
      // A Recueil lock (P4) is never overridden by a policy; only a person's decision moves it.
      if (options.policy === 'zotero' && !locked) result = z;
      else if (options.policy === 'recueil') result = r;
      else {
        setScalar(merged, field, r);
        continue;
      }
    } else if (locked && result !== r) {
      // Zotero changed a field that is locked in Recueil: that is a conflict too.
      conflicts.push({ field, base: b, recueil: r, zotero: z });
      if (options.policy === 'recueil') result = r;
      else {
        setScalar(merged, field, r);
        continue;
      }
    } else if (options.frozen?.has(field) === true && r !== z) {
      // An earlier conflict on this field is still open: hold both sides.
      setScalar(merged, field, r);
      continue;
    }

    setScalar(merged, field, result);
    if (result !== r) toRecueil.push(field);
    if (result !== z) toZotero.push(field);
  }

  const setFields = new Set([...Object.keys(base.sets), ...Object.keys(recueil.sets), ...Object.keys(zotero.sets)]);
  for (const field of [...setFields].sort()) {
    const b = new Set(base.sets[field] ?? []);
    const r = new Set(recueil.sets[field] ?? []);
    const z = new Set(zotero.sets[field] ?? []);
    const out = new Set(b);
    for (const value of r) if (!b.has(value)) out.add(value);
    for (const value of z) if (!b.has(value)) out.add(value);
    for (const value of b) if (!r.has(value) || !z.has(value)) out.delete(value);
    const result = [...out].sort();
    merged.sets[field] = result;
    if (!sameSet(result, r)) toRecueil.push(field);
    if (!sameSet(result, z)) toZotero.push(field);
  }

  return { merged, toRecueil, toZotero, conflicts, decided };
};

const setScalar = (flat: Flat, field: string, value: string | null): void => {
  if (value !== null) flat.scalars[field] = value;
};

const sameSet = (values: readonly string[], set: ReadonlySet<string>): boolean =>
  values.length === set.size && values.every((value) => set.has(value));
