/**
 * The command vocabulary behind the palette.
 *
 * A command is the same thing a shortcut fires and the same thing a menu item would call, named
 * once. Keeping the list as data means the palette needs no knowledge of what any of them do, and
 * a UI plugin can contribute commands later the same way it contributes item-pane sections
 * (CONCEPT.md §5.13).
 */

export interface Command {
  id: string;
  /** What the user reads. Imperative: "Open the reader", not "Reader". */
  title: string;
  /** The heading it is filed under. */
  group: string;
  /** The shortcut that also fires it, when there is one. */
  shortcutId?: string;
  /** Extra words the search should match but the label need not show. */
  keywords?: string;
  run: () => void;
  /** A command that cannot act right now is shown greyed rather than hidden, so it stays findable. */
  disabled?: boolean;
}

/**
 * Subsequence matching, scored.
 *
 * A palette that only does substring matching fails the thing people actually type: `bib` for
 * "Sort by bibliography", `ol` for "Open the last item". Matching characters in order, and
 * preferring matches that start a word, gets both without a fuzzy-search dependency.
 */
export const scoreCommand = (command: Command, query: string): number | null => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;

  const haystack = `${command.title} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
  let score = 0;
  let cursor = 0;

  for (const character of needle) {
    if (character === ' ') continue;
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    const startsWord = found === 0 || haystack[found - 1] === ' ';
    score += startsWord ? 3 : 1;
    // Consecutive characters are worth more than scattered ones.
    if (found === cursor) score += 2;
    cursor = found + 1;
  }
  return score;
};

/** The commands that match, best first, then in declaration order. */
export const filterCommands = (commands: readonly Command[], query: string): Command[] =>
  commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry): entry is { command: Command; index: number; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.command);
