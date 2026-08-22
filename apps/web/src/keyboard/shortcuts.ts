/**
 * The shortcut map — one table, and the only place a binding is written down.
 *
 * CONCEPT.md §5.14 says the web client is keyboard-first, which is a claim about discoverability
 * as much as about bindings: a shortcut nobody can find is a shortcut nobody has. So the map is
 * data, not a pile of `if (event.key === …)` in components. The help overlay renders it, the
 * command palette renders it beside each command, and `test/shortcuts.test.ts` asserts that no two
 * shortcuts in the same scope claim the same chord.
 *
 * Notation: parts joined with `+`. `Mod` is Command on macOS and Control everywhere else, which is
 * the only platform difference the client has. The final part is matched against `KeyboardEvent.key`
 * case-insensitively, so `?` is `?` rather than `Shift+/`.
 */

export type ShortcutScope = 'global' | 'library' | 'reader';

export interface Shortcut {
  /** Stable identifier. Handlers are registered against it, never against the chord. */
  id: string;
  /** The chord, in the notation above. */
  keys: string;
  scope: ShortcutScope;
  /** The heading it appears under in the help overlay. */
  group: string;
  description: string;
  /**
   * Whether the shortcut fires while a text field has focus. False for almost everything: `j`
   * must type a `j` in the title field, not move the selection.
   */
  whileTyping?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  /* Global ---------------------------------------------------------------------------------- */
  {
    id: 'command-palette',
    keys: 'Mod+k',
    scope: 'global',
    group: 'Everywhere',
    description: 'Open the command palette',
    whileTyping: true,
  },
  {
    id: 'shortcut-help',
    keys: '?',
    scope: 'global',
    group: 'Everywhere',
    description: 'Show this list of shortcuts',
  },
  {
    id: 'dismiss',
    keys: 'Escape',
    scope: 'global',
    group: 'Everywhere',
    description: 'Close the overlay, or leave the field being edited',
    whileTyping: true,
  },

  /* Panes ----------------------------------------------------------------------------------- */
  {
    id: 'focus-collections',
    keys: '1',
    scope: 'library',
    group: 'Panes',
    description: 'Focus the collections pane',
  },
  {
    id: 'focus-items',
    keys: '2',
    scope: 'library',
    group: 'Panes',
    description: 'Focus the item list',
  },
  {
    id: 'focus-item-pane',
    keys: '3',
    scope: 'library',
    group: 'Panes',
    description: 'Focus the item pane',
  },
  {
    id: 'focus-search',
    keys: '/',
    scope: 'library',
    group: 'Panes',
    description: 'Focus the search box',
  },

  /* The item list --------------------------------------------------------------------------- */
  {
    id: 'item-next',
    keys: 'j',
    scope: 'library',
    group: 'Item list',
    description: 'Select the next item',
  },
  {
    id: 'item-previous',
    keys: 'k',
    scope: 'library',
    group: 'Item list',
    description: 'Select the previous item',
  },
  {
    id: 'item-first',
    keys: 'g',
    scope: 'library',
    group: 'Item list',
    description: 'Select the first item',
  },
  {
    id: 'item-last',
    keys: 'Shift+G',
    scope: 'library',
    group: 'Item list',
    description: 'Select the last loaded item',
  },
  {
    id: 'item-load-more',
    keys: 'm',
    scope: 'library',
    group: 'Item list',
    description: 'Load the next page of items',
  },
  {
    id: 'item-open',
    keys: 'Enter',
    scope: 'library',
    group: 'Item list',
    description: "Open the selected item's first attachment in the reader",
  },
  {
    id: 'sort-reverse',
    keys: 'r',
    scope: 'library',
    group: 'Item list',
    // There is no companion "cycle the sort field": the list is ordered by (dateModified, id) and
    // `GET /api/v1/items` takes no sort field, so reversing is the whole of the ordering surface.
    description: 'Reverse the order: oldest first, or newest first',
  },

  /* The reader ------------------------------------------------------------------------------ */
  {
    id: 'reader-next-page',
    keys: 'n',
    scope: 'reader',
    group: 'Reader',
    description: 'Next page',
  },
  {
    id: 'reader-previous-page',
    keys: 'p',
    scope: 'reader',
    group: 'Reader',
    description: 'Previous page',
  },
  {
    id: 'reader-zoom-in',
    keys: '+',
    scope: 'reader',
    group: 'Reader',
    description: 'Zoom in',
  },
  {
    id: 'reader-zoom-out',
    keys: '-',
    scope: 'reader',
    group: 'Reader',
    description: 'Zoom out',
  },
  {
    id: 'reader-zoom-reset',
    keys: '0',
    scope: 'reader',
    group: 'Reader',
    description: 'Reset the zoom to 100%',
  },
  {
    id: 'reader-find',
    keys: 'f',
    scope: 'reader',
    group: 'Reader',
    description: 'Search the document text',
  },
  {
    id: 'reader-close',
    keys: 'q',
    scope: 'reader',
    group: 'Reader',
    description: 'Return to the library',
  },
];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

export const shortcutById = (id: string): Shortcut | undefined =>
  SHORTCUTS.find((shortcut) => shortcut.id === id);

/** The shortcuts in a scope, plus the global ones, in declaration order. */
export const shortcutsForScope = (scope: ShortcutScope): Shortcut[] =>
  SHORTCUTS.filter((shortcut) => shortcut.scope === scope || shortcut.scope === 'global');

const isApplePlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform ?? '');

interface ParsedChord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/**
 * Modifier words, each followed by `+`, then the key.
 *
 * Split on `+` naively and the chord `+` — zoom in — parses as two empty parts and matches nothing,
 * which is exactly the kind of silence a keyboard map must not have.
 */
const CHORD_PATTERN = /^((?:[A-Za-z]+\+)*)(.+)$/u;

export const parseChord = (keys: string): ParsedChord => {
  const match = CHORD_PATTERN.exec(keys);
  const key = match?.[2] ?? keys;
  const modifiers = (match?.[1] ?? '')
    .split('+')
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
  return {
    mod: modifiers.includes('mod'),
    ctrl: modifiers.includes('ctrl'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift'),
    key,
  };
};

/** Does this keyboard event fire this chord? */
export const matchesChord = (
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  keys: string,
): boolean => {
  const chord = parseChord(keys);
  const wantsCommand = chord.mod && isApplePlatform();
  const wantsControl = chord.ctrl || (chord.mod && !isApplePlatform());

  if (event.ctrlKey !== wantsControl) return false;
  if (event.metaKey !== wantsCommand) return false;
  if (event.altKey !== chord.alt) return false;

  if (chord.shift) {
    if (!event.shiftKey) return false;
  } else if (event.shiftKey && !isShiftedGlyph(chord.key)) {
    // `g` and `Shift+G` are two shortcuts, so a plain letter or a named key must not match while
    // Shift is held. Punctuation that is itself typed with Shift — `?`, `+` — is exempt, because
    // demanding shiftKey === false there would mean it never matched at all.
    return false;
  }

  return event.key.toLowerCase() === chord.key.toLowerCase();
};

/** A single character that a standard layout produces only with Shift held. */
const isShiftedGlyph = (key: string): boolean => key.length === 1 && !/[a-z0-9]/iu.test(key);

/** The chord as a human reads it, with the platform's own modifier glyphs. */
export const formatChord = (keys: string): string => {
  const chord = parseChord(keys);
  const apple = isApplePlatform();
  const parts: string[] = [];
  if (chord.mod) parts.push(apple ? '⌘' : 'Ctrl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push(apple ? '⌥' : 'Alt');
  if (chord.shift) parts.push(apple ? '⇧' : 'Shift');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join(apple ? '' : '+');
};

/**
 * Is the event coming from somewhere the user is typing?
 *
 * Anything editable counts, including `contenteditable`, because the alternative is a title field
 * in which `j` selects the next item instead of typing a letter.
 */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range'].includes(type);
};
