/**
 * The command palette's matching.
 */
import { describe, expect, it } from 'vitest';

import { filterCommands, scoreCommand } from '../src/keyboard/commands.js';
import type { Command } from '../src/keyboard/commands.js';

const command = (id: string, title: string, group = 'Library'): Command => ({
  id,
  title,
  group,
  run: () => undefined,
});

const COMMANDS = [
  command('all', 'Show all items'),
  command('sort', 'Cycle the sort field'),
  command('open', 'Open the selected item in the reader'),
  command('methods', 'Go to Methods', 'Collections'),
];

describe('the command palette matching', () => {
  it('returns everything for an empty query', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
  });

  it('matches characters in order rather than only substrings', () => {
    expect(filterCommands(COMMANDS, 'sortf').map((c) => c.id)).toContain('sort');
    expect(filterCommands(COMMANDS, 'gtm').map((c) => c.id)).toContain('methods');
  });

  it('drops a command whose characters are not all there', () => {
    expect(filterCommands(COMMANDS, 'zzz')).toEqual([]);
    expect(scoreCommand(command('x', 'Open'), 'zzz')).toBeNull();
  });

  it('prefers word starts, so an acronym finds the right command', () => {
    const [best] = filterCommands(COMMANDS, 'sai');
    expect(best?.id).toBe('all');
  });

  it('searches the group and the keywords as well as the title', () => {
    expect(filterCommands(COMMANDS, 'collections').map((c) => c.id)).toContain('methods');
  });
});
