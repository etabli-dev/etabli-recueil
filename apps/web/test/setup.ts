/**
 * The test environment.
 *
 * jsdom is a DOM, not a browser: it lays nothing out, so everything that depends on measurement has
 * to be supplied. The two stubs below are exactly that, and neither of them fakes any behaviour
 * under test — the virtualiser is given a viewport to render into, and a scroll container is given
 * a `scrollTo` that does nothing, because there is nothing to scroll.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library's automatic cleanup hooks itself onto a global `afterEach`, and this suite runs
// without Vitest's globals, so it is wired up by hand. Without it every test sees the previous
// test's DOM still in the document.
afterEach(cleanup);

class TestResizeObserver implements ResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver;
}

/**
 * Everything below needs a DOM, and one file in this suite deliberately runs without one: the
 * service worker's, because a worker has Node's set of web globals rather than jsdom's
 * (`test/service-worker.test.ts`). The guard is what lets one setup file serve both.
 */
const hasDom = typeof Element !== 'undefined' && typeof HTMLElement !== 'undefined';

if (hasDom && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function scrollTo(): void {};
}

/**
 * A laid-out viewport for the scroll containers.
 *
 * jsdom lays nothing out, so every element reports `offsetHeight === 0` — and a virtualiser given a
 * zero-height window correctly renders no rows, because none of them are visible. The size here is
 * arbitrary but real: a 640-pixel window over 76-pixel rows. Elements that have been given an
 * explicit pixel height in a style attribute keep it.
 */
const pixelsFrom = (value: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
};

if (hasDom) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return pixelsFrom(this.style.width) ?? 720;
    },
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return pixelsFrom(this.style.height) ?? 640;
    },
  });
}
