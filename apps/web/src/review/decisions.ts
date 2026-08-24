/**
 * The pure parts of the review workspace: the cursor, and what a decision can be taken back.
 *
 * The second is the one that shaped the design. **The API has no reopen.** `ReviewService.accept`
 * and `reject` both refuse anything whose status is not `open`, so once a decision has been sent
 * there is no request that un-sends it — the entry is resolved for good, and the only reversal left
 * is trashing the item an acceptance created (P5).
 *
 * An interface that offered "undo" for that would be lying. So undo here is a *grace period*: a
 * keystroke stages the decision, the entry leaves the list at once, and the request is sent when the
 * window closes. `u` inside the window cancels it and nothing was ever sent. After it, the banner
 * stops saying undo and says what is actually still possible.
 *
 * That is not a trick to avoid implementing something. It is the only construction in which the
 * word means what it says, and it is what makes single-letter accept safe to press quickly — which
 * is the whole of whether M2's remaining ten per cent is bearable.
 */
import type { ReviewEntry } from '../api/ingestion.js';
import type { ReviewResolution } from '../api/queries.js';

/**
 * How long a decision can be taken back.
 *
 * Long enough to notice a mistake and reach for `u`, short enough that a reviewer working through a
 * queue is not holding a dozen unsent decisions when they close the tab. Every pending decision is
 * flushed on unmount and on the page being hidden, so the window is a delay and never a loss.
 */
export const UNDO_WINDOW_MS = 6000;

export type DecisionKind = 'accept' | 'reject';

/** A decision that has been made and not yet sent. */
export interface PendingDecision {
  /** Identifies this staging, not the entry: the same entry can only be staged once. */
  entry: ReviewEntry;
  kind: DecisionKind;
  note?: string | undefined;
  edits?: Record<string, unknown> | undefined;
  stagedAt: number;
}

/** A decision that has been sent and cannot be taken back. */
export interface SentDecision {
  resolution: ReviewResolution;
  sentAt: number;
}

/* Cursor ---------------------------------------------------------------------------------------- */

/**
 * Where the cursor goes when an entry leaves the list.
 *
 * Forward to the entry that took its place, and back to the previous one only when the resolved
 * entry was last — because the entry that has just gone is where the eye already is, and the next
 * decision is the one that slid up under it.
 */
export const nextAfterResolution = (
  entries: readonly ReviewEntry[],
  resolvedId: string,
): string | null => {
  const index = entries.findIndex((entry) => entry.id === resolvedId);
  if (index === -1) return entries[0]?.id ?? null;
  const remaining = entries.filter((entry) => entry.id !== resolvedId);
  if (remaining.length === 0) return null;
  return (remaining[index] ?? remaining[remaining.length - 1])?.id ?? null;
};

/** Move by one, clamped rather than wrapped: a work list is not a carousel. */
export const stepSelection = (
  entries: readonly ReviewEntry[],
  currentId: string | null,
  offset: 1 | -1,
): string | null => {
  if (entries.length === 0) return null;
  if (currentId === null) return (offset === 1 ? entries[0] : entries[entries.length - 1])?.id ?? null;
  const index = entries.findIndex((entry) => entry.id === currentId);
  if (index === -1) return entries[0]?.id ?? null;
  const target = Math.min(Math.max(index + offset, 0), entries.length - 1);
  return entries[target]?.id ?? null;
};

/** The entries still to be decided: what the server sent, less anything already staged. */
export const visibleEntries = (
  entries: readonly ReviewEntry[],
  pending: readonly PendingDecision[],
): ReviewEntry[] => {
  const staged = new Set(pending.map((decision) => decision.entry.id));
  return entries.filter((entry) => !staged.has(entry.id));
};

/* Describing ------------------------------------------------------------------------------------ */

/** A staged decision, before anything has been sent. */
export const describePending = (decision: PendingDecision): string => {
  const verb = decision.kind === 'accept' ? 'Accepting' : 'Rejecting';
  const edited = decision.kind === 'accept' && decision.edits !== undefined ? ', with your edits,' : '';
  return `${verb} “${decision.entry.reasonCode}”${edited} — not sent yet.`;
};

/**
 * What a sent decision did, from the server's own account of it.
 *
 * Built from `ReviewResolution`, never from what the client asked for. The distinction matters: an
 * acceptance whose proposal named two collections and whose execution created one item says
 * "created one item", because that is what happened.
 */
export const describeSent = (decision: SentDecision): string => {
  const { resolution } = decision;
  if (resolution.decision === 'reject') {
    return `Rejected “${resolution.entry.reasonCode}”. Nothing was created.`;
  }
  if (resolution.itemId === null) {
    return `Accepted “${resolution.entry.reasonCode}”. The proposal created nothing.`;
  }
  return `Accepted “${resolution.entry.reasonCode}”. It created one item.`;
};

/**
 * What is still possible once a decision has been sent.
 *
 * Deliberately not the word "undo". The queue entry is resolved and no request can reopen it; an
 * item that was created can be trashed, and that is a different and smaller statement.
 */
export const describeAfterSending = (decision: SentDecision): string =>
  decision.resolution.itemId === null
    ? 'This has been sent. The entry is resolved and the queue has no reopen, so it cannot be taken back.'
    : 'This has been sent. The entry stays resolved — the queue has no reopen — but the item it created can go to the trash, where it can be restored.';

/* The stack ------------------------------------------------------------------------------------- */

/**
 * How many sent decisions are remembered.
 *
 * Only for the banner's "what is still possible", so one is nearly enough; three lets a reviewer
 * who accepted a short run still reach the item from two decisions ago.
 */
export const SENT_HISTORY = 3;

export const rememberSent = (history: readonly SentDecision[], decision: SentDecision): SentDecision[] =>
  [decision, ...history].slice(0, SENT_HISTORY);
