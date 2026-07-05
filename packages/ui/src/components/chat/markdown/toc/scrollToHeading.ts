/**
 * Manual, container-relative scroll for the Markdown preview ToC.
 *
 * WHY NOT `element.scrollIntoView`: the preview lives in three different scroll
 * contexts — a plain `overflow-auto` div (inline desktop), a CSS-transformed
 * fullscreen overlay, and a mobile `ScrollShadow`. `scrollIntoView` is
 * unreliable across a transformed ancestor (it walks the wrong scroll parent),
 * so we compute the target `scrollTop` ourselves and set it on the KNOWN
 * scroller. The pure arithmetic is factored out (`computeScrollTop`) so it is
 * unit-testable with explicit numbers; the DOM read/write lives in
 * `scrollToHeading` and is exercised by the real-Chromium e2e.
 */

/**
 * Pure scroll-offset arithmetic. Given the scroller's CURRENT `scrollTop`, the
 * target element's viewport `top` and the scroller's viewport `top` (both from
 * `getBoundingClientRect().top`), return the `scrollTop` that brings the target
 * to the top of the scroller. Clamped at 0 (scrollTop can never be negative).
 *
 * Derivation: the element's offset WITHIN the scroller's scrollable content is
 * `(elTop - scrollerTop)` relative to the current scroll position, so the
 * absolute target is `currentScrollTop + (elTop - scrollerTop)`.
 */
export const computeScrollTop = (
  currentScrollTop: number,
  elTop: number,
  scrollerTop: number,
): number => Math.max(0, currentScrollTop + (elTop - scrollerTop));

export type ScrollToHeadingOptions = {
  /** Use smooth scrolling via `scroller.scrollTo` when available. */
  smooth?: boolean;
};

/**
 * Scroll `scroller` so the heading with DOM id `id` (looked up inside
 * `contentRoot`) sits at the top of the scroller. No-ops safely when the id is
 * not present in `contentRoot` (e.g. ids not injected yet / stale slug).
 *
 * `id` is the FULL prefixed id from `TocEntry.slug` (e.g. `md-h-overview`); it is
 * used verbatim — never re-slugged.
 */
export const scrollToHeading = (
  scroller: HTMLElement,
  contentRoot: HTMLElement,
  id: string,
  options: ScrollToHeadingOptions = {},
): void => {
  const el = contentRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!el) return;
  const top = computeScrollTop(
    scroller.scrollTop,
    el.getBoundingClientRect().top,
    scroller.getBoundingClientRect().top,
  );
  if (options.smooth && typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: 'smooth' });
  } else {
    scroller.scrollTop = top;
  }
};

/**
 * A one-shot "wait for the next render commit" bridge. The Markdown renderer
 * exposes an `onCommit` callback that fires once the render + heading-id
 * injection is in the LIVE DOM. A ToC click must await that signal before it
 * scrolls (so the anchor id exists). Wire `notify` into the renderer's
 * `onCommit` prop and pass `waitForCommit` to `TocTree`.
 *
 * Each `waitForCommit()` resolves on the NEXT `notify()`; already-committed
 * content needs no wait (the caller checks id presence first), so this never
 * hangs on a static, already-rendered document.
 */
export type CommitSignal = {
  notify: () => void;
  waitForCommit: () => Promise<void>;
};

export const createCommitSignal = (): CommitSignal => {
  let pending: Array<() => void> = [];
  return {
    notify: () => {
      const resolvers = pending;
      pending = [];
      for (const resolve of resolvers) resolve();
    },
    waitForCommit: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  };
};
