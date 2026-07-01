// Renderer-agnostic body-text scaling for rendered diagram SVGs (mermaid today,
// PlantUML later). scaleForBodyText is pure/unit-testable; DOM reads live in
// applyDiagramBodyScale.

// Clamp keeps a huge diagram legible (>=0.6x) and stops a tiny one blowing up (<=1.4x).
export const DIAGRAM_SCALE_MIN = 0.6;
export const DIAGRAM_SCALE_MAX = 1.4;

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
    const intrinsic = readIntrinsicSvgFontPx(svg);
    if (intrinsic == null) {
      host.style.transform = '';
      host.style.removeProperty('transform-origin');
      host.removeAttribute('data-md-diagram-scale');
      continue;
    }
    const scale = scaleForBodyText(intrinsic, targetBodyPx);
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
