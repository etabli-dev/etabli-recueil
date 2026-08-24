/**
 * The pure parts of the review workspace.
 *
 * The cursor, which a rendering test would assert slowly and vaguely, and the wording of the two
 * banners — which is where the honesty of the whole screen lives, because the API has no reopen and
 * an interface that used the word "undo" for what is possible after sending would be lying.
 */
import { describe, expect, it } from 'vitest';

import {
  SENT_HISTORY,
  describeAfterSending,
  describePending,
  describeSent,
  nextAfterResolution,
  rememberSent,
  stepSelection,
  visibleEntries,
} from '../src/review/decisions.js';
import type { PendingDecision, SentDecision } from '../src/review/decisions.js';
import type { ReviewResolution } from '../src/api/queries.js';
import { CREATED_ITEM_ID, reviewEntry, secondEntry } from './ingestion-fixtures.js';

const entries = [reviewEntry(), secondEntry(), reviewEntry({ id: 'third' })];

const pendingOf = (kind: 'accept' | 'reject', index = 0, edits?: Record<string, unknown>): PendingDecision => ({
  entry: entries[index] as (typeof entries)[number],
  kind,
  stagedAt: 0,
  ...(edits === undefined ? {} : { edits }),
});

const resolutionOf = (overrides: Partial<ReviewResolution> = {}): ReviewResolution => ({
  entry: reviewEntry({ status: 'accepted' }),
  decision: 'accept',
  itemId: CREATED_ITEM_ID,
  attachmentId: null,
  warnings: [],
  ...overrides,
});

describe('nextAfterResolution', () => {
  it('moves to the entry that took the resolved one’s place', () => {
    expect(nextAfterResolution(entries, entries[0]!.id)).toBe(entries[1]!.id);
  });

  it('falls back to the previous entry when the resolved one was last', () => {
    expect(nextAfterResolution(entries, 'third')).toBe(entries[1]!.id);
  });

  it('selects nothing when the queue is emptied', () => {
    expect(nextAfterResolution([entries[0]!], entries[0]!.id)).toBeNull();
  });

  it('selects the first entry when the resolved one is not in the list', () => {
    expect(nextAfterResolution(entries, 'not-loaded')).toBe(entries[0]!.id);
  });
});

describe('stepSelection', () => {
  it('moves forward and back', () => {
    expect(stepSelection(entries, entries[0]!.id, 1)).toBe(entries[1]!.id);
    expect(stepSelection(entries, entries[1]!.id, -1)).toBe(entries[0]!.id);
  });

  it('clamps rather than wrapping: a work list is not a carousel', () => {
    expect(stepSelection(entries, entries[0]!.id, -1)).toBe(entries[0]!.id);
    expect(stepSelection(entries, 'third', 1)).toBe('third');
  });

  it('starts at either end when nothing is selected', () => {
    expect(stepSelection(entries, null, 1)).toBe(entries[0]!.id);
    expect(stepSelection(entries, null, -1)).toBe('third');
  });

  it('selects nothing in an empty queue', () => {
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe('visibleEntries', () => {
  it('hides an entry whose decision is staged, so the queue shrinks as it is worked through', () => {
    expect(visibleEntries(entries, [pendingOf('accept', 0)]).map((entry) => entry.id)).toEqual([
      entries[1]!.id,
      'third',
    ]);
  });

  it('shows everything when nothing is staged', () => {
    expect(visibleEntries(entries, [])).toHaveLength(3);
  });
});

describe('the wording', () => {
  it('says a staged decision has not been sent', () => {
    expect(describePending(pendingOf('accept'))).toBe(
      'Accepting “low_confidence_metadata” — not sent yet.',
    );
  });

  it('says when the staged decision carries edits', () => {
    expect(describePending(pendingOf('accept', 0, { itemType: 'invoice' }))).toContain('with your edits');
  });

  it('reports what the server said an acceptance did, not what was asked for', () => {
    expect(describeSent({ resolution: resolutionOf(), sentAt: 0 })).toBe(
      'Accepted “low_confidence_metadata”. It created one item.',
    );
  });

  it('does not claim an item when the proposal created none', () => {
    expect(describeSent({ resolution: resolutionOf({ itemId: null }), sentAt: 0 })).toBe(
      'Accepted “low_confidence_metadata”. The proposal created nothing.',
    );
  });

  it('never calls the post-send reversal an undo, because the queue has no reopen', () => {
    const sent: SentDecision = { resolution: resolutionOf(), sentAt: 0 };
    const after = describeAfterSending(sent);
    expect(after).not.toMatch(/undo/iu);
    expect(after).toContain('stays resolved');
    expect(after).toContain('trash');
  });

  it('says plainly that nothing can be reversed when nothing was created', () => {
    const sent: SentDecision = { resolution: resolutionOf({ itemId: null }), sentAt: 0 };
    expect(describeAfterSending(sent)).toContain('cannot be taken back');
  });
});

describe('the sent history', () => {
  it('is bounded, so the banner never offers a reversal it has forgotten the details of', () => {
    let history: SentDecision[] = [];
    for (let index = 0; index < SENT_HISTORY + 3; index += 1) {
      history = rememberSent(history, {
        resolution: resolutionOf({ entry: reviewEntry({ id: `e${String(index)}` }) }),
        sentAt: index,
      });
    }
    expect(history).toHaveLength(SENT_HISTORY);
    expect(history[0]?.resolution.entry.id).toBe(`e${String(SENT_HISTORY + 2)}`);
  });
});
