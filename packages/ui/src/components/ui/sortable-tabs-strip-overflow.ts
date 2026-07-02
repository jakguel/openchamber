// Constant width reserved for the overflow scroll-arrow rail. Kept in sync with
// the right-edge gradient offset so the fade ends exactly before the rail.
export const SCROLL_RAIL_WIDTH = 56;

// Sub-pixel measurement epsilon; overflow must exceed this to count.
const OVERFLOW_DEADBAND = 2;

// Decide whether the tab content overflows the width available to it, measured
// INDEPENDENTLY of whether the scroll rail is currently mounted. The rail is a
// flex sibling after scrollRef, so mounting it shrinks scrollRef.clientWidth by
// railWidth. Adding railWidth back when railMounted reconstructs the constant
// full width, so the decision is identical in both rail states (no fit/overflow
// oscillation at the mount boundary).
export function computeRailOverflow(params: {
  scrollWidth: number;
  clientWidth: number;
  railMounted: boolean;
  railWidth: number;
}): boolean {
  const { scrollWidth, clientWidth, railMounted, railWidth } = params;
  const railIndependentWidth = clientWidth + (railMounted ? railWidth : 0);
  return scrollWidth - railIndependentWidth > OVERFLOW_DEADBAND;
}
