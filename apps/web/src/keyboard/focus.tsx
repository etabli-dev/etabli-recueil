/**
 * Focus management between the three panes.
 *
 * "Keyboard-first" means the caret is somewhere known at all times. A pane registers its scroll
 * container here; the shortcut map moves focus between them by name; and each pane records which
 * of its own children last had focus, so that returning to a pane returns to the row you left
 * rather than to the top of it.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';

export type PaneName = 'collections' | 'items' | 'detail' | 'reader';

interface FocusContextValue {
  activePane: PaneName;
  focusPane: (pane: PaneName) => void;
  registerPane: (pane: PaneName) => RefCallback<HTMLElement>;
}

const FocusContext = createContext<FocusContextValue | null>(null);

export interface FocusManagerProps {
  initialPane?: PaneName;
  children: ReactNode;
}

export const FocusManager = ({ initialPane = 'items', children }: FocusManagerProps): JSX.Element => {
  const [activePane, setActivePane] = useState<PaneName>(initialPane);
  const panes = useRef(new Map<PaneName, HTMLElement>());

  const focusPane = useCallback((pane: PaneName) => {
    setActivePane(pane);
    const element = panes.current.get(pane);
    if (element === undefined) return;
    // Prefer whatever inside the pane is marked current — the selected row, the open section — so
    // that coming back to a pane resumes where it was left.
    const target = element.querySelector<HTMLElement>('[data-focus-target="true"]') ?? element;
    target.focus();
  }, []);

  const registerPane = useCallback(
    (pane: PaneName): RefCallback<HTMLElement> =>
      (element) => {
        if (element === null) panes.current.delete(pane);
        else panes.current.set(pane, element);
      },
    [],
  );

  const value = useMemo(
    () => ({ activePane, focusPane, registerPane }),
    [activePane, focusPane, registerPane],
  );

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
};

/**
 * The focus manager, or a no-op.
 *
 * A pane rendered on its own — in a test, or inside a plugin's preview — should not have to build
 * a focus manager to render, so the absence of the provider is a supported configuration rather
 * than an error.
 */
export const useFocusManager = (): FocusContextValue => {
  const value = useContext(FocusContext);
  return value ?? FALLBACK;
};

const FALLBACK: FocusContextValue = {
  activePane: 'items',
  focusPane: () => undefined,
  registerPane: () => () => undefined,
};
