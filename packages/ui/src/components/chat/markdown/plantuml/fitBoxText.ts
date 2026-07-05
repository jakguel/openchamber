/**
 * Post-render DOM fit pass for PlantUML box labels (openchamber-f9d.26.1).
 *
 * The @plantuml/core engine sizes boxes with its own logical font metrics (and ships no font
 * files), while the browser paints labels with the CSS font — on platforms where the painted
 * glyphs run wider, a boxed label overflows its box. `skinparam defaultFontName` does not steer
 * the engine metrics, so this corrects on the paint side: measure the real rendered text and, only
 * where it overflows its box, condense it to the exact inner width via SVG `textLength` +
 * `lengthAdjust="spacingAndGlyphs"` (which reacts to the ACTUAL painted metrics → cross-platform).
 *
 * A label's box is the primary background shape of its nearest ancestor `<g class="entity">`
 * (rectangle/class boxes, drawn as `<rect>`) or `<g class="cluster">` (package/folder/frame
 * container boxes, drawn as `<path>`/`<polygon>`) — the largest-area direct child among
 * rect/path/polygon. The background CHILD shape's bbox is the fit box, NOT the group's own bbox,
 * because the group bbox is inflated by the very text that overflows it. Labels with no enclosing
 * entity/cluster group (edge/relation/free title) are left untouched, and font-size is never
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

const nearestBoxGroup = (text: Element, host: Element): Element | null => {
  let node: Element | null = text.parentElement;
  while (node && node !== host) {
    if (node.matches('g.entity, g.cluster')) return node;
    node = node.parentElement;
  }
  return null;
};

const backgroundShapeBox = (group: Element): Box | null => {
  const shapes = Array.from(
    group.querySelectorAll<SVGGraphicsElement>(':scope > rect, :scope > path, :scope > polygon'),
  );
  let box: Box | null = null;
  let maxArea = 0;
  for (const shape of shapes) {
    const b = safeBBox(shape);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const area = b.width * b.height;
    if (area > maxArea) {
      maxArea = area;
      box = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  }
  return box;
};

export function fitPlantumlBoxText(svgHost: Element | null | undefined): void {
  if (!svgHost) return;

  const texts = Array.from(svgHost.querySelectorAll<SVGGraphicsElement>('text'));
  for (const text of texts) {
    const tb = safeBBox(text);
    if (!tb || tb.width <= 0) continue;

    const group = nearestBoxGroup(text, svgHost);
    if (!group) continue;

    const box = backgroundShapeBox(group);
    if (!box) continue;

    const cx = tb.x + tb.width / 2;
    const cy = tb.y + tb.height / 2;
    const inside =
      cx >= box.x &&
      cx <= box.x + box.width &&
      cy >= box.y &&
      cy <= box.y + box.height;
    if (!inside) continue;

    const available = box.width - BOX_INNER_PADDING_PX * 2;
    if (available <= 0) continue;

    if (tb.width > available + OVERFLOW_EPSILON_PX) {
      text.setAttribute('textLength', String(available));
      text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}
