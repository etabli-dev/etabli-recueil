/**
 * Binding the shortcut map to the document.
 *
 * One listener, on the document, at the capture phase, driven by the table in `shortcuts.ts`.
 * Components register handlers by shortcut id and never see a `KeyboardEvent`, which is what keeps
 * the map authoritative: a binding that is not in the table cannot exist.
 */
import { useEffect, useRef } from 'react';

import { SHORTCUTS, isTypingTarget, matchesChord, shortcutById } from './shortcuts.js';
import type { ShortcutScope } from './shortcuts.js';

export type ShortcutHandlers = Record<string, (() => void) | undefined>;

export interface UseShortcutsOptions {
  /** Which scope's shortcuts are live. Global ones are always live. */
  scope: ShortcutScope;
  /** Off while a modal owns the keyboard, except for the handlers the modal itself registers. */
  enabled?: boolean;
}

export const useShortcuts = (handlers: ShortcutHandlers, options: UseShortcutsOptions): void => {
  const { scope, enabled = true } = options;

  // The handler map is read at keypress time rather than captured, so a component may pass a fresh
  // object of closures on every render without re-binding the listener.
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.repeat && !event.ctrlKey && !event.metaKey) return;

      const typing = isTypingTarget(event.target);
      for (const shortcut of SHORTCUTS) {
        if (shortcut.scope !== 'global' && shortcut.scope !== scope) continue;
        if (typing && shortcut.whileTyping !== true) continue;
        if (!matchesChord(event, shortcut.keys)) continue;

        const handler = latest.current[shortcut.id];
        if (handler === undefined) continue;

        event.preventDefault();
        event.stopPropagation();
        handler();
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [scope, enabled]);
};

/** The chord for a shortcut id, for rendering beside a command. */
export const chordFor = (id: string): string => shortcutById(id)?.keys ?? '';
