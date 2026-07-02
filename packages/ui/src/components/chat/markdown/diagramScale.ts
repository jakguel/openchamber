// Renderer-agnostic body-text scaling for rendered diagram SVGs (mermaid today,
// PlantUML later). scaleForBodyText is pure/unit-testable; DOM reads live in
// applyDiagramBodyScale.

// Clamp keeps a huge diagram legible (>=0.6x) and stops a tiny one blowing up (<=1.4x).
export const DIAGRAM_SCALE_MIN = 0.6;
export const DIAGRAM_SCALE_MAX = 1.4;

// Sub-pixel safety margin for the inline width clamp: keep the painted (transformed)
// host strictly inside its container so integer/subpixel rounding never pushes
// scrollWidth past clientWidth and resurrects the inner scrollbar the fit-to-width
// design removed.
const DIAGRAM_FIT_EPSILON_PX = 1;

export function scaleForBodyText(intrinsicFontPx: number, targetBodyPx: number): number {
  if (
    !Number.isFinite(intrinsicFontPx) ||
    !Number.isFinite(targetBodyPx) ||
    intrinsicFontPx <= 0 ||
    targetBodyPx <= 0
  ) {
    return 1;
  }
  const ratio = targetBodyPx / intrinsicFontPx;
  if (ratio < DIAGRAM_SCALE_MIN) return DIAGRAM_SCALE_MIN;
  if (ratio > DIAGRAM_SCALE_MAX) return DIAGRAM_SCALE_MAX;
  return ratio;
}

// Must run on a CONNECTED node: getComputedStyle resolves px (incl. font-size set
// via the SVG's own <style>) only in the live document.
function readIntrinsicSvgFontPx(svg: SVGElement): number | null {
  const textEl = svg.querySelector('text');
  if (textEl) {
    const computed = Number.parseFloat(getComputedStyle(textEl).fontSize);
    if (Number.isFinite(computed) && computed > 0) return computed;
    const attr = Number.parseFloat(textEl.getAttribute('font-size') ?? '');
    if (Number.isFinite(attr) && attr > 0) return attr;
  }
  const rootComputed = Number.parseFloat(getComputedStyle(svg).fontSize);
  if (Number.isFinite(rootComputed) && rootComputed > 0) return rootComputed;
  return null;
}

// Non-destructive scale transform on each [data-md-diagram] host (existing svg
// width/height sizing untouched). Cheap bail with no diagrams keeps it hot-path
// safe; idempotent (sets, never multiplies — font-size ignores ancestor transform).
export function applyDiagramBodyScale(container: HTMLElement | null): void {
  if (!container) return;
  const hosts = container.querySelectorAll<HTMLElement>('[data-md-diagram]');
  if (hosts.length === 0) return;
  const targetBodyPx = Number.parseFloat(getComputedStyle(container).fontSize);
  if (!Number.isFinite(targetBodyPx) || targetBodyPx <= 0) return;

  for (const host of Array.from(hosts)) {
    const svg = host.querySelector('svg');
    if (!svg) continue;

    // Clear any prior transform BEFORE measuring so the fitted (pre-scale) layout
    // width is read. getBoundingClientRect folds in transform:scale, so a stale
    // scale from an earlier idempotent run would corrupt the width-ceiling below.
    host.style.transform = '';
    host.style.removeProperty('transform-origin');

    const intrinsic = readIntrinsicSvgFontPx(svg);
    if (intrinsic == null) {
      host.removeAttribute('data-md-diagram-scale');
      continue;
    }
    let scale = scaleForBodyText(intrinsic, targetBodyPx);

    // Inline fit-to-width width clamp: the font-balance upscale may only consume the
    // headroom actually available between the fitted diagram and its container.
    // Chromium counts the host transform:scale in scrollWidth, so a diagram already
    // fitted to the container width (see index.css svg max-width:100%) and then
    // upscaled >1x overflows and gets clipped by the mermaid-scroll overflow:hidden.
    // Cap the effective scale at (container / fitted) so host*scale never exceeds the
    // container: a wide diagram (fitted == container) gets ~1x (no upscale, no clip),
    // while a narrower one keeps its legibility upscale up to the point of overflow.
    //
    // Scoped to the inline box only (overflow-x: hidden). The fullscreen popup and the
    // ASCII fallback use overflow:auto and OWN their horizontal scroll, so they keep the
    // full font-balance scale untouched — the clamp would wrongly shrink a pan/zoom view.
    const scrollParent = host.parentElement;
    if (scrollParent instanceof HTMLElement && getComputedStyle(scrollParent).overflowX === 'hidden') {
      const fittedWidth = host.getBoundingClientRect().width;
      const availWidth = scrollParent.clientWidth;
      if (fittedWidth > 0 && availWidth > 0) {
        const widthCeiling = (availWidth - DIAGRAM_FIT_EPSILON_PX) / fittedWidth;
        if (widthCeiling < scale) scale = widthCeiling;
      }
    }

    if (scale === 1) {
      host.style.transform = '';
      host.style.removeProperty('transform-origin');
    } else {
      host.style.transformOrigin = 'top left';
      host.style.transform = `scale(${scale})`;
    }
    host.setAttribute('data-md-diagram-scale', String(scale));
  }
}
