/**
 * Secrets that have to be stored, and the one rule that makes storing them acceptable.
 *
 * CONCEPT §5.15 says "secrets via environment", and for the server's own credentials that is what
 * happens. An ingestion source is different in kind: the operator adds a mailbox through the API at
 * ten past four on a Tuesday, and a password that can only arrive through the environment means
 * restarting the process to add a mailbox. So the password is stored — and because it is stored, it
 * is stored **encrypted with a key that is not in the database**, so that a leaked `recueil.db`,
 * a backup tarball or a `.sqlite` file mailed to a bug report does not carry the mailbox password
 * with it.
 *
 * The key comes from `RECUEIL_SECRET_KEY`. There is deliberately no fallback: a key derived from
 * the database path, the hostname or a constant would encrypt nothing while looking as though it
 * did, and the failure mode of that is an operator who believes their credentials are protected.
 * With no key configured, a request that carries a secret is refused with a 409 that names the
 * variable — which is a refusal a person can act on in thirty seconds.
 *
 * AES-256-GCM: authenticated, so a ciphertext altered in the database fails to decrypt rather than
 * decrypting to something else. A fresh 96-bit nonce per encryption, from `randomBytes`; the nonce
 * and the tag travel with the ciphertext in one `v1.<nonce>.<tag>.<ciphertext>` string, because a
 * three-column layout for one value is three chances to write one of them and not the others.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { ConflictError } from '@recueil/core';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'v1';

/**
 * Thrown when a secret is offered and there is nowhere safe to put it.
 *
 * A `ConflictError`, so it becomes a 409 through the one place a thrown thing becomes a problem
 * document (`problem.ts`) rather than needing a `catch` in a route. 409 rather than 422 because
 * nothing is wrong with the request: the server is in a state that refuses it, and the fix is one
 * environment variable away.
 */
export class SecretsUnavailableError extends ConflictError {
  readonly code = 'secrets_unavailable';

  constructor(message: string) {
    super(message, { variable: 'RECUEIL_SECRET_KEY' });
    this.name = 'SecretsUnavailableError';
  }
}

/** Thrown when stored ciphertext will not decrypt: a wrong key, or a tampered row. */
export class SecretDecryptionError extends ConflictError {
  readonly code = 'secret_undecryptable';

  constructor(message: string) {
    super(message, { variable: 'RECUEIL_SECRET_KEY' });
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Read a key from the configured value.
 *
 * Base64 or hex, both accepted, because an operator generating one with `openssl rand -base64 32`
 * and one generating it with `openssl rand -hex 32` are equally likely and neither should have to
 * read the source to find out which was wanted. Anything that does not decode to exactly 32 bytes
 * is refused at boot rather than at the first mailbox.
 */
export const parseSecretKey = (value: string): Buffer => {
  const trimmed = value.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]+$/u.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    candidates.push(Buffer.from(trimmed, 'hex'));
  }
  if (/^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, 'base64'));
  }
  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (key === undefined) {
    throw new SecretsUnavailableError(
      'RECUEIL_SECRET_KEY must be 32 bytes, as 64 hex characters or as base64. Generate one with ' +
        '`openssl rand -base64 32`.',
    );
  }
  return key;
};

/**
 * The box, which may be empty.
 *
 * An empty box is the honest representation of "no key is configured": it can be constructed, it
 * can be asked whether it is available, and every attempt to use it throws with the same sentence.
 * The alternative — a nullable box the callers each check — is a null check that one caller
 * forgets.
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(key: Buffer | null) {
    this.key = key;
  }

  /** Build one from the configured variable. `undefined` produces an unavailable box. */
  static fromConfig(value: string | undefined): SecretBox {
    return new SecretBox(value === undefined ? null : parseSecretKey(value));
  }

  get available(): boolean {
    return this.key !== null;
  }

  /** Encrypt a JSON-serialisable secret bag. Throws when no key is configured. */
  seal(secrets: Readonly<Record<string, string>>): string {
    const key = this.require();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(secrets), 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      nonce.toString('base64url'),
      tag.toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }

  /** Decrypt a bag sealed by {@link seal}. Throws rather than returning a partial answer. */
  open(sealed: string): Record<string, string> {
    const key = this.require();
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new SecretDecryptionError('The stored secret is not in the format this build writes.');
    }
    const nonce = Buffer.from(parts[1] as string, 'base64url');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    const body = Buffer.from(parts[3] as string, 'base64url');
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretDecryptionError('The stored secret has a malformed nonce or authentication tag.');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      const parsed: unknown = JSON.parse(plain.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SecretDecryptionError('The stored secret did not decrypt to an object.');
      }
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[name] = value;
      }
      return out;
    } catch (error) {
      if (error instanceof SecretDecryptionError) throw error;
      throw new SecretDecryptionError(
        'The stored secret could not be decrypted with the configured RECUEIL_SECRET_KEY. Either ' +
          'the key has changed or the row was altered; re-enter the credential.',
      );
    }
  }

  private require(): Buffer {
    if (this.key === null) {
      throw new SecretsUnavailableError(
        'This server has no RECUEIL_SECRET_KEY, so it will not store a credential. Set one — ' +
          '`openssl rand -base64 32` — and restart. Sources with no secret can be configured ' +
          'without it.',
      );
    }
    return this.key;
  }
}

/**
 * Constant-time equality for two secrets, for a caller comparing a supplied value with a stored one.
 *
 * Not used by the source routes — they never read a secret back out for comparison — but exported
 * because the temptation to write `a === b` on a credential is what this module exists to remove.
 */
export const secretsEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};
