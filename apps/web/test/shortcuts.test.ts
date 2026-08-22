/**
 * The shortcut map.
 *
 * Two chords that fire in the same scope is the bug this file exists to catch: it is invisible in
 * review, and the symptom is one of the two shortcuts silently never working.
 */
import { describe, expect, it } from 'vitest';

import {
  SHORTCUTS,
  formatChord,
  isTypingTarget,
  matchesChord,
  shortcutsForScope,
} from '../src/keyboard/shortcuts.js';

const keyboardEvent = (key: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
  altKey: modifiers.altKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
});

describe('the shortcut map', () => {
  it('gives every shortcut a unique id', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never binds one chord to two shortcuts that are live at the same time', () => {
    for (const scope of ['library', 'reader'] as const) {
      const chords = shortcutsForScope(scope).map((shortcut) => shortcut.keys);
      expect(new Set(chords).size, `duplicate chord in the ${scope} scope`).toBe(chords.length);
    }
  });

  it('describes every shortcut, because the help overlay is generated from this table', () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.description.length, shortcut.id).toBeGreaterThan(3);
      expect(shortcut.group.length, shortcut.id).toBeGreaterThan(0);
    }
  });

  it('matches a plain key only when no modifier is held', () => {
    expect(matchesChord(keyboardEvent('j'), 'j')).toBe(true);
    expect(matchesChord(keyboardEvent('J', { shiftKey: true }), 'j')).toBe(false);
    expect(matchesChord(keyboardEvent('j', { ctrlKey: true }), 'j')).toBe(false);
  });

  it('distinguishes g from Shift+G, which are two different shortcuts', () => {
    expect(matchesChord(keyboardEvent('g'), 'g')).toBe(true);
    expect(matchesChord(keyboardEvent('G', { shiftKey: true }), 'Shift+G')).toBe(true);
    expect(matchesChord(keyboardEvent('G', { shiftKey: true }), 'g')).toBe(false);
    expect(matchesChord(keyboardEvent('g'), 'Shift+G')).toBe(false);
  });

  it('matches a glyph that is itself typed with Shift', () => {
    expect(matchesChord(keyboardEvent('?', { shiftKey: true }), '?')).toBe(true);
    expect(matchesChord(keyboardEvent('+', { shiftKey: true }), '+')).toBe(true);
  });

  it('treats Mod as Control off macOS', () => {
    expect(matchesChord(keyboardEvent('k', { ctrlKey: true }), 'Mod+k')).toBe(true);
    expect(matchesChord(keyboardEvent('k', { metaKey: true }), 'Mod+k')).toBe(false);
  });

  it('renders a chord the way the help overlay shows it', () => {
    expect(formatChord('Mod+k')).toBe('Ctrl+K');
    expect(formatChord('Escape')).toBe('Escape');
    expect(formatChord('j')).toBe('J');
  });

  it('knows where the user is typing', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const textarea = document.createElement('textarea');

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('lets only the shortcuts marked whileTyping fire from a text field', () => {
    const typable = SHORTCUTS.filter((shortcut) => shortcut.whileTyping === true).map((s) => s.id);
    // The palette and the two ways out have to work mid-edit; nothing else may.
    expect(typable.sort()).toEqual(['command-palette', 'dismiss']);
  });
});
