/**
 * Post-render DOM fit pass for PlantUML box labels (openchamber-f9d.26.1, anchor-aware in 5ki.42).
 *
 * The @plantuml/core engine sizes boxes with its own logical font metrics (and ships no font
 * files), while the browser paints labels with the CSS font — on platforms where the painted
 * glyphs run wider, a boxed label overflows its box. `skinparam defaultFontName` does not steer
 * the engine metrics, so this corrects on the paint side: measure the real rendered text and, only
 * where it overflows the room available FROM ITS ANCHOR, condense it to that room via SVG
 * `textLength` + `lengthAdjust="spacingAndGlyphs"` (which reacts to the ACTUAL painted metrics →
 * cross-platform). Font-size is never modified and the text is never re-anchored/re-centered.
 *
 * A label's box is a direct background shape of its nearest ancestor `<g class="entity">`
 * (rectangle/class/usecase boxes: `<rect>`/`<ellipse>`/`<circle>`) or `<g class="cluster">`
 * (package/folder/frame containers: `<path>`/`<polygon>`). Among the group's direct
 * rect/path/polygon/ellipse/circle children we pick the SMALLEST-area one whose bbox CONTAINS the
 * label's anchor point — this selects the tight box a title sits in and, crucially, leaves labels
 * that sit OUTSIDE every candidate shape untouched (e.g. an actor's caption below its stick-figure
 * icon, which must keep its natural width, not be crushed to icon width).
 *
 * Width is ANCHOR-AWARE. PlantUML titles are frequently NOT centered in their box (a package title
 * is left-anchored a few px inside the folder shape), so fitting to the full inner width lets a
 * left-anchored label spill past the right edge. Instead the room is measured from the anchor to
 * the relevant padded edge per the text-anchor: `middle` → symmetric `2*min(anchorX-left,
 * right-anchorX)`; `start`/default → `right-anchorX`; `end` → `anchorX-left`. Idempotent: any prior
 * fit is stripped before measuring, so re-running on the same DOM yields the same result.
 */

const BOX_INNER_PADDING_PX = 3;

// Sub-pixel slack so getBBox rounding never triggers a spurious condense.
const OVERFLOW_EPSILON_PX = 0.5;

type Box = { x: number; y: number; width: number; height: number };

type TextAnchor = 'start' | 'middle' | 'end';

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

/**
 * The tightest candidate background shape the anchor sits in: the SMALLEST-area direct
 * rect/path/polygon/ellipse/circle child of the group whose bbox contains {anchorX, anchorY}.
 * ellipse/circle are included so usecase/round boxes are scanned (getBBox returns the axis-aligned
 * box, so the area math holds). Returns null when no candidate contains the anchor — the caller
 * then leaves the label untouched (unboxed captions).
 */
const containingShapeBox = (group: Element, anchorX: number, anchorY: number): Box | null => {
  const shapes = Array.from(
    group.querySelectorAll<SVGGraphicsElement>(
      ':scope > rect, :scope > path, :scope > polygon, :scope > ellipse, :scope > circle',
    ),
  );
  let box: Box | null = null;
  let minArea = Number.POSITIVE_INFINITY;
  for (const shape of shapes) {
    const b = safeBBox(shape);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    if (anchorX < b.x || anchorX > b.x + b.width || anchorY < b.y || anchorY > b.y + b.height) continue;
    const area = b.width * b.height;
    if (area < minArea) {
      minArea = area;
      box = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  }
  return box;
};

/** Resolve the effective SVG text-anchor (CSS-resolved when possible, else the attribute). */
const readTextAnchor = (text: SVGGraphicsElement): TextAnchor => {
  let value = '';
  try {
    value = getComputedStyle(text as unknown as Element).textAnchor ?? '';
  } catch {
    // getComputedStyle can be unavailable for detached nodes; fall back to the attribute.
  }
  if (!value) value = text.getAttribute('text-anchor') ?? '';
  const normalized = value.trim().toLowerCase();
  return normalized === 'middle' || normalized === 'end' ? normalized : 'start';
};

export function fitPlantumlBoxText(svgHost: Element | null | undefined): void {
  if (!svgHost) return;

  const texts = Array.from(svgHost.querySelectorAll<SVGGraphicsElement>('text'));
  for (const text of texts) {
    // Idempotency: strip any prior fit so getBBox reports the NATURAL painted width, then re-decide.
    // Re-running on the same DOM therefore yields the same result.
    if (text.hasAttribute('textLength')) {
      text.removeAttribute('textLength');
      text.removeAttribute('lengthAdjust');
    }

    const tb = safeBBox(text);
    if (!tb || tb.width <= 0) continue;

    // Anchor point: the text `x` attribute when present (its true horizontal origin), else the
    // painted bbox center-x. y is always the painted vertical center.
    const xAttr = text.getAttribute('x');
    const parsedX = xAttr !== null && xAttr !== '' ? Number(xAttr) : Number.NaN;
    const anchorX = Number.isFinite(parsedX) ? parsedX : tb.x + tb.width / 2;
    const anchorY = tb.y + tb.height / 2;

    const group = nearestBoxGroup(text, svgHost);
    if (!group) continue;

    const box = containingShapeBox(group, anchorX, anchorY);
    if (!box) continue; // No enclosing shape (e.g. actor caption) → leave natural width.

    const left = box.x + BOX_INNER_PADDING_PX;
    const right = box.x + box.width - BOX_INNER_PADDING_PX;
    if (right <= left) continue;

    const anchor = readTextAnchor(text);
    let available: number;
    if (anchor === 'middle') {
      available = 2 * Math.min(anchorX - left, right - anchorX);
    } else if (anchor === 'end') {
      available = anchorX - left;
    } else {
      available = right - anchorX;
    }
    if (available <= 0) continue;

    if (tb.width > available + OVERFLOW_EPSILON_PX) {
      text.setAttribute('textLength', String(available));
      text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}
