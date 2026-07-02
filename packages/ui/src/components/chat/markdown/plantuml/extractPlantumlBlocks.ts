/**
 * Positional extractor for decorated PlantUML blocks — the twin of extractMermaidBlocks.
 *
 * Popup source lookup is positional (a clicked block's DOM index maps to a source), and
 * mermaid + plantuml blocks interleave, so plantuml needs its OWN selector and array or
 * the indices misalign. Unlike extractMermaidBlocks (which parses the markdown string),
 * this reads the already-decorated DOM so the source travels with the node.
 *
 * The DOM is inverted behind minimal structural interfaces (a real Element/Document
 * satisfies them; unit tests pass hand-built fakes), keeping the extractor testable
 * without a DOM env. assertPlantumlDomContract enforces that at compile time.
 */

export const PLANTUML_BLOCK_SELECTOR = '[data-markdown="plantuml-block"]';
export const PLANTUML_SOURCE_ATTR = 'data-plantuml-source';
const MD_SOURCE_SELECTOR = '[data-md-source]';
const MD_SOURCE_ATTR = 'data-md-source';

export interface PlantumlBlockNode {
  getAttribute(name: string): string | null;
  querySelector(selectors: string): PlantumlBlockNode | null;
  textContent: string | null;
}

export interface PlantumlBlockContainer {
  querySelectorAll(selectors: string): ArrayLike<PlantumlBlockNode>;
}

export interface PlantumlBlock {
  source: string;
  index: number;
}

const trimTrailing = (value: string): string => value.replace(/\s+$/, '');

/**
 * Reads a block's PlantUML source. Canonical location is the data-plantuml-source
 * attribute stamped by decoratePlantuml; falls back (in order) to a data-md-source
 * toolbar button, a nested <code>, then the block's own text — so the extractor is
 * robust to however the decorate pass ends up carrying the source.
 */
export const readPlantumlSource = (node: PlantumlBlockNode): string => {
  const attr = node.getAttribute(PLANTUML_SOURCE_ATTR);
  if (attr !== null && attr.trim().length > 0) return trimTrailing(attr);

  const marked = node.querySelector(MD_SOURCE_SELECTOR);
  const fromMarked = marked?.getAttribute(MD_SOURCE_ATTR);
  if (fromMarked !== null && fromMarked !== undefined && fromMarked.trim().length > 0) {
    return trimTrailing(fromMarked);
  }

  const code = node.querySelector('code');
  const text = code?.textContent ?? node.textContent ?? '';
  return trimTrailing(text);
};

/**
 * Returns one entry per [data-markdown="plantuml-block"] node in DOM order, each with its
 * source and positional index. Array position equals index, so a positional popup lookup
 * can index directly while `index` stays authoritative if callers filter the list.
 */
export const extractPlantumlBlocks = (root: PlantumlBlockContainer): PlantumlBlock[] => {
  const nodes = root.querySelectorAll(PLANTUML_BLOCK_SELECTOR);
  const blocks: PlantumlBlock[] = [];
  for (let index = 0; index < nodes.length; index++) {
    blocks.push({ source: readPlantumlSource(nodes[index]), index });
  }
  return blocks;
};

/**
 * Compile-time contract (never called): a live Document/HTMLElement satisfies the root
 * type and a live Element satisfies the node type, so decorate.ts and MarkdownRendererImpl
 * can pass real DOM values without a type break.
 */
export const assertPlantumlDomContract = (
  root: Document | HTMLElement,
  block: Element,
): [PlantumlBlockContainer, PlantumlBlockNode] => [root, block];
