/**
 * Post-render DOM fit pass for PlantUML box labels (openchamber-f9d.26.1).
 *
 * The @plantuml/core engine sizes boxes with its own logical font metrics (and ships no font
 * files), while the browser paints labels with the CSS font — on platforms where the painted
 * glyphs run wider, a boxed label overflows its rect. `skinparam defaultFontName` does not steer
 * the engine metrics, so this corrects on the paint side: measure the real rendered text and, only
 * where it overflows its box, condense it to the exact inner width via SVG `textLength` +
 * `lengthAdjust="spacingAndGlyphs"` (which reacts to the ACTUAL painted metrics → cross-platform).
 * Labels with no enclosing rect (edge/relation/title) are left untouched, and font-size is never
 * modified (diagramScale reads the first <text> font-size). Idempotent.
 */

const BOX_INNER_PADDING_PX = 3;

// Sub-pixel slack so getBBox rounding never triggers a spurious condense.
const OVERFLOW_EPSILON_PX = 0.5;

type Box = { x: number; y: number; width: number; height: number };

const safeBBox = (el: SVGGraphicsElement): DOMRect | null => {
  try {
    return el.getBBox();
  } catch {
    return null;
  }
};

export function fitPlantumlBoxText(svgHost: Element | null | undefined): void {
  if (!svgHost) return;

  const rects = Array.from(svgHost.querySelectorAll<SVGGraphicsElement>('rect'));
  if (rects.length === 0) return;

  // getBBox reports the box in user units — the same unit `textLength` expects. Skip zero-area.
  const boxes: Box[] = [];
  for (const rect of rects) {
    const b = safeBBox(rect);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    boxes.push({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  if (boxes.length === 0) return;

  const texts = Array.from(svgHost.querySelectorAll<SVGGraphicsElement>('text'));
  for (const text of texts) {
    const tb = safeBBox(text);
    if (!tb || tb.width <= 0) continue;

    const cx = tb.x + tb.width / 2;
    const cy = tb.y + tb.height / 2;

    // The label's box is the smallest-area rect whose bounds contain the text bbox centre.
    let box: Box | null = null;
    let boxArea = Number.POSITIVE_INFINITY;
    for (const candidate of boxes) {
      const inside =
        cx >= candidate.x &&
        cx <= candidate.x + candidate.width &&
        cy >= candidate.y &&
        cy <= candidate.y + candidate.height;
      if (!inside) continue;
      const area = candidate.width * candidate.height;
      if (area < boxArea) {
        boxArea = area;
        box = candidate;
      }
    }

    if (!box) continue;

    const available = box.width - BOX_INNER_PADDING_PX * 2;
    if (available <= 0) continue;

    if (tb.width > available + OVERFLOW_EPSILON_PX) {
      text.setAttribute('textLength', String(available));
      text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}
