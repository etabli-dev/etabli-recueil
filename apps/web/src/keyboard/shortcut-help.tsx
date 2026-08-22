/**
 * The shortcut list, rendered from the map itself.
 *
 * Documentation that is generated from the binding table cannot go stale, which is the only kind of
 * shortcut documentation worth having.
 */
import { SHORTCUTS, formatChord } from './shortcuts.js';
import type { Shortcut, ShortcutScope } from './shortcuts.js';

export interface ShortcutHelpProps {
  open: boolean;
  scope: ShortcutScope;
  onClose: () => void;
}

export const ShortcutHelp = ({ open, scope, onClose }: ShortcutHelpProps): JSX.Element | null => {
  if (!open) return null;

  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of SHORTCUTS) {
    if (shortcut.scope !== 'global' && shortcut.scope !== scope) continue;
    const bucket = groups.get(shortcut.group) ?? [];
    bucket.push(shortcut);
    groups.set(shortcut.group, bucket);
  }

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="help__title">Keyboard shortcuts</h2>
        {[...groups].map(([group, shortcuts]) => (
          <section key={group} className="help__group">
            <h3>{group}</h3>
            <dl>
              {shortcuts.map((shortcut) => (
                <div key={shortcut.id} className="help__row">
                  <dt>
                    <kbd>{formatChord(shortcut.keys)}</kbd>
                  </dt>
                  <dd>{shortcut.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
};
