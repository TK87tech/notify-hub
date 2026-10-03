/**
 * One deliberate divergence from vite.config.ts: `@base-ui/react/*` resolves to
 * jsdom instead of the browser build.
 *
 * That package ships CSS-in-JS that measures the DOM on import. Under jsdom
 * `matchMedia` does not exist, so importing any component that touches it throws
 * a ReferenceError before a single assertion runs - a failure that looks like a
 * broken test rather than a missing browser API.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverStub {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

globalThis.ResizeObserver ??= ResizeObserverStub as never;
globalThis.IntersectionObserver ??= IntersectionObserverStub as never;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

if (!window.scrollTo) {
  window.scrollTo = (() => {}) as never;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (() => {}) as never;
}

/**
 * The Web Animations API, which jsdom does not implement.
 *
 * Base UI's ScrollArea calls `element.getAnimations()` to decide whether it can
 * animate a scroll without a visible jump. Without this stub it throws a
 * TypeError inside a promise, which surfaces as an unhandled error *after* the
 * test has already passed - and leaves a pending timer that wedges the whole
 * worker, so the run appears to hang rather than fail.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = (() => []) as never;
}

if (!document.getAnimations) {
  document.getAnimations = (() => []) as never;
}

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

/**
 * localStorage cleared between tests rather than once up front.
 *
 * The auth token lives there, so a leaked token from one test silently
 * authenticates the next one and the suite passes for the wrong reason.
 */
afterEach(() => {
  window.localStorage.clear();
});