/**
 * A pane: the structural unit of the three-pane layout.
 *
 * All three share one component so that focus, the heading level and the scroll container behave
 * identically in each — which is what makes the keyboard map in `src/keyboard/shortcuts.ts`
 * describable in one sentence per key rather than one per pane.
 */
import { forwardRef } from 'react';
import type { ReactNode } from 'react';

export interface PaneProps {
  /** The pane's stable name, used by the focus manager and the shortcut map. */
  id: string;
  title: string;
  /** Rendered in the header, to the right of the title: sort controls, counts, filters. */
  toolbar?: ReactNode;
  children: ReactNode;
  active?: boolean;
}

/**
 * `tabIndex={-1}` rather than `0`: a pane is focusable by the shortcut map, but it is not a tab
 * stop, because tabbing through three container elements to reach a text field is not keyboard-first.
 */
export const Pane = forwardRef<HTMLElement, PaneProps>(
  ({ id, title, toolbar, children, active = false }, ref) => (
    <section
      ref={ref}
      className="pane"
      data-pane={id}
      data-active={active ? 'true' : 'false'}
      aria-label={title}
      tabIndex={-1}
    >
      <header className="pane__header">
        <h2 className="pane__title">{title}</h2>
        {toolbar === undefined ? null : <div className="pane__toolbar">{toolbar}</div>}
      </header>
      <div className="pane__body">{children}</div>
    </section>
  ),
);
Pane.displayName = 'Pane';
