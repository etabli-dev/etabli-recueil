/**
 * The errors the services throw.
 *
 * Each one carries the RFC 9457 problem type the API layer will render (`@recueil/schemas`
 * `ProblemSchema`), so that the mapping from a thrown error to an HTTP response is a lookup and not
 * a chain of `instanceof` guesses in the route handler.
 */

export type ProblemStatus = 400 | 404 | 409 | 412 | 422 | 500;

export class RecueilError extends Error {
  readonly type: string;

  readonly status: ProblemStatus;

  readonly detail?: Record<string, unknown>;

  constructor(
    type: string,
    status: ProblemStatus,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.type = type;
    this.status = status;
    this.detail = detail;
  }
}

/** The record is not there, or is trashed and the caller did not ask for trashed records. */
export class NotFoundError extends RecueilError {
  constructor(entityType: string, id: string) {
    super('recueil:not-found', 404, `No ${entityType} with id '${id}'.`, { entityType, id });
  }
}

/**
 * A conditional write lost. P1: "conflicts logged, not merged" — the caller is told the current
 * version and re-reads; nothing is merged behind their back (§1.7).
 */
export class VersionConflictError extends RecueilError {
  constructor(entityType: string, id: string, expected: number, actual: number) {
    super(
      'recueil:version-conflict',
      412,
      `${entityType} '${id}' has moved on: expected version ${expected}, found ${actual}.`,
      { entityType, id, expected, actual },
    );
  }
}

/** A uniqueness rule or a state rule refuses the write. */
export class ConflictError extends RecueilError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('recueil:conflict', 409, message, detail);
  }
}

/** The input is the wrong shape for what it claims to be. */
export class ValidationError extends RecueilError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('recueil:invalid-input', 422, message, detail);
  }
}

/**
 * A data-model invariant would be broken. Distinct from a validation error: the input was
 * well-formed and the operation is still refused, because carrying it out would leave the library
 * in a state `spec/data-model.md` says cannot exist.
 */
export class InvariantError extends RecueilError {
  constructor(invariant: string, message: string, detail?: Record<string, unknown>) {
    super('recueil:invariant-violated', 409, `${invariant}: ${message}`, { invariant, ...detail });
  }
}
