/**
 * The command palette.
 *
 * Every action the interface can take, reachable by typing part of its name. This is the escape
 * hatch that makes a keyboard-first interface learnable: a user who cannot remember the chord types
 * three letters instead, and sees the chord next to the command they picked.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { filterCommands } from './commands.js';
import type { Command } from './commands.js';
import { formatChord, shortcutById } from './shortcuts.js';

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly Command[];
  onClose: () => void;
}

export const CommandPalette = ({ open, commands, onClose }: CommandPaletteProps): JSX.Element | null => {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlighted(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlighted((current) => (current >= matches.length ? Math.max(matches.length - 1, 0) : current));
  }, [matches.length]);

  if (!open) return null;

  const run = (command: Command): void => {
    if (command.disabled === true) return;
    onClose();
    command.run();
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={matches[highlighted] === undefined ? undefined : `palette-${matches[highlighted].id}`}
          placeholder="Type a command…"
          aria-label="Type a command"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlighted((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((current) =>
                matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const command = matches[highlighted];
              if (command !== undefined) run(command);
            }
          }}
        />
        {matches.length === 0 ? (
          <p className="palette__empty">No command matches “{query}”.</p>
        ) : (
          <ul className="palette__list" id="palette-list" role="listbox" aria-label="Commands">
            {matches.map((command, index) => {
              const shortcut = command.shortcutId === undefined ? undefined : shortcutById(command.shortcutId);
              return (
                <li
                  key={command.id}
                  id={`palette-${command.id}`}
                  role="option"
                  aria-selected={index === highlighted}
                  aria-disabled={command.disabled === true}
                  className="palette__item"
                  data-highlighted={index === highlighted ? 'true' : 'false'}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    run(command);
                  }}
                >
                  <span className="palette__group">{command.group}</span>
                  <span className="palette__title">{command.title}</span>
                  {shortcut === undefined ? null : (
                    <kbd className="palette__chord">{formatChord(shortcut.keys)}</kbd>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
