/**
 * The one decision every source shares: may the original be moved, deleted or flagged now?
 *
 * The answer is the same in all three sources and it is deliberately conservative:
 *
 *   1. `leave` never touches anything, so it needs no evidence.
 *   2. An outcome the operator did not list in `consumeOn` is left alone. `failed` and `stopped` are
 *      not in the default list, because a document the pipeline refused is precisely the one whose
 *      copy on the far side may be the last one.
 *   3. Anything else has to pass `verifyOutcome`: every digest the outcome named is re-read out of
 *      the content store, re-hashed and matched against its `documents` row. Only then may the
 *      original be destroyed, and the sentence that says why is recorded next to the deletion.
 *
 * Order matters here in a way it does not read as: the verification is performed *before* the far
 * side is touched, not after, and its result is what gates the touch rather than annotating it.
 */
import type { Recueil } from '@recueil/core';

import type { AcknowledgementAction, ConsumableStatus, ConsumePolicy, IngestOutcome } from './types.js';
import { DEFAULT_CONSUME_ON } from './types.js';
import { verifyOutcome } from './verify.js';
import type { StoreVerification } from './verify.js';

export const consumeStatuses = (
  configured: readonly ConsumableStatus[] | undefined,
): ReadonlySet<ConsumableStatus> => new Set(configured ?? DEFAULT_CONSUME_ON);

export interface ConsumeEvidence {
  /** True when the far side may now be touched: moved, deleted, or flagged. */
  allowed: boolean;
  /** What to record when it may not be. */
  action: Extract<AcknowledgementAction, 'left' | 'refused'>;
  detail: string;
  verification: StoreVerification | null;
}

/**
 * The evidence half, without the policy.
 *
 * Separate from `decideConsume` because `ImapSource` needs it on its own: setting `\Seen` on a
 * message is not destructive enough to need a `move` or `delete` policy, but it is still a change
 * to the user's mailbox that must not happen until the bytes are demonstrably in the store —
 * otherwise a failed ingest silently marks the mail read and nothing ever comes back for it.
 */
export const evidenceForConsume = async (input: {
  recueil: Recueil;
  outcome: IngestOutcome;
  consumeOn?: readonly ConsumableStatus[];
}): Promise<ConsumeEvidence> => {
  const allowed = consumeStatuses(input.consumeOn);

  if (!allowed.has(input.outcome.status)) {
    return {
      allowed: false,
      action: 'left',
      detail:
        `the outcome is '${input.outcome.status}', which the consume policy does not act on ` +
        `(${[...allowed].join(', ')})`,
      verification: null,
    };
  }

  const verification = await verifyOutcome(input.recueil, input.outcome);
  if (!verification.ok) {
    return {
      allowed: false,
      action: 'refused',
      detail: `the store write could not be verified, so the original was kept: ${verification.summary}`,
      verification,
    };
  }

  return { allowed: true, action: 'left', detail: verification.summary, verification };
};

export interface ConsumeDecision extends ConsumeEvidence {
  /** True when the source may now move or delete the original. */
  consume: boolean;
}

/** Decide, on queried evidence, whether the original may be consumed. */
export const decideConsume = async (input: {
  recueil: Recueil;
  outcome: IngestOutcome;
  policy: ConsumePolicy;
  consumeOn?: readonly ConsumableStatus[];
}): Promise<ConsumeDecision> => {
  if (input.policy.mode === 'leave') {
    return {
      consume: false,
      allowed: false,
      action: 'left',
      detail: 'the consume policy is `leave`: the original stays where it is',
      verification: null,
    };
  }

  const evidence = await evidenceForConsume({
    recueil: input.recueil,
    outcome: input.outcome,
    ...(input.consumeOn === undefined ? {} : { consumeOn: input.consumeOn }),
  });
  return { ...evidence, consume: evidence.allowed };
};
