import { copyTextToClipboard } from '@/lib/clipboard';
import { getExternalFaviconUrl, isExternalHttpUrl, isLoopbackHttpUrl } from '@/lib/url';
import { dropdownMenuItemClass, dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { createPlantumlRenderQueue, type PlantumlRenderQueue } from './plantuml/renderQueue';
import { renderPlantuml } from './plantuml/renderPlantuml';
import { buildPlantumlCacheKey } from './plantuml/cacheKey';
import { PLANTUML_BLOCK_SELECTOR, PLANTUML_SOURCE_ATTR } from './plantuml/extractPlantumlBlocks';
import { applyDiagramHostBodyScale } from './diagramScale';
import { fitPlantumlBoxText } from './plantuml/fitBoxText';
import { planHeadingIds } from './toc';

// ---------------------------------------------------------------------------
// Shared decoration context
// ---------------------------------------------------------------------------

export type MermaidRender = { svg?: string; ascii?: string };

export type DecorateLabels = {
  copy: string;
  copied: string;
  copyTable: string;
  downloadTable: string;
  copyDiagram: string;
  downloadDiagram: string;
  expandDiagram: string;
  previewLabel: string;
  previewTitle: string;
};

export type PlantumlRenderSlot = {
  queue: PlantumlRenderQueue;
  themeId: string;
  // The selected PlantUML theme (store union incl. 'none'). Part of the render cache key so a
  // theme switch invalidates the cached SVG (themeId above is the app COLOR theme, not this).
  plantumlTheme: string;
  // The vendored raw theme body spliced into the source at render time ('' for 'none').
  themeBody: string;
  dark: boolean;
  labels: { loading: string; error: string };
};

// Opt-in slot for heading id injection (decorateHeadings). When present, the
// rendered h1/h2/h3 get stable, de-duped ids derived from `renderedContent` so a
// ToC can anchor-scroll to them. Absent by default (chat renderer never sets it)
// so heading id injection is a complete no-op there. Mirrors the renderPlantuml?
// optional-slot pattern below.
export type HeadingIdSlot = {
  // The EXACT markdown text the renderer lexed (already frontmatter-stripped if
  // the renderer stripped it), so the extracted heading order matches the
  // rendered <h1-3> order 1:1 for positional id assignment.
  renderedContent: string;
};

export type DecorateContext = {
  labels: DecorateLabels;
  // Renders a mermaid block source to svg/ascii using current theme colors.
  renderMermaid: (source: string) => MermaidRender;
  // Async twin of renderMermaid: the persistent PlantUML render queue plus theme context.
  // Optional so existing callers and non-plantuml content are unaffected, and the synchronous
  // renderMermaid contract above stays UNTOUCHED. Wired by the renderer in f9d.16.5; when
  // absent, decoratePlantuml is a no-op.
  renderPlantuml?: PlantumlRenderSlot;
  onPreviewLoopback?: (url: string) => void;
  // Opt-in heading id injection (see HeadingIdSlot). No-op when absent.
  injectHeadingIds?: HeadingIdSlot;
};

/**
 * Build the persistent single-flight PlantUML render queue with the A2 engine renderer
 * (renderPlantuml) injected as its sole external boundary. Call ONCE per renderer instance:
 * the queue must survive morphdom re-decoration to dedup/supersede across passes. The
 * ~8.6MB @plantuml/core engine is not loaded here — renderPlantuml lazy-loads it, so only an
 * actual enqueue() from decoratePlantuml (a real plantuml block) triggers that load.
 */
export const createPlantumlQueue = (): PlantumlRenderQueue =>
  createPlantumlRenderQueue({
    render: (_key, source, dark, themeBody) => renderPlantuml(source, dark, themeBody),
  });

// Reference the app's icon sprite (injected into <body> by the shared Icon
// component) so DOM-built controls use the same themed icons as the rest of
// the app. Sprite symbols are registered under `#oc-<name>`.
const spriteIcon = (name: string): string =>
  `<svg class="remixicon size-3.5" viewBox="0 0 24 24" aria-hidden="true"><use href="#oc-${name}"></use></svg>`;

const ICONS = {
  copy: spriteIcon('file-copy'),
  check: spriteIcon('check'),
  download: spriteIcon('download'),
  expand: spriteIcon('fullscreen'),
} as const;

const ICON_BTN_CLASS =
  'p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors';

const setHtml = (el: Element, html: string): void => {
  el.innerHTML = html;
};

const makeIconButton = (icon: keyof typeof ICONS, title: string, slot: string): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ICON_BTN_CLASS;
  button.setAttribute('data-md-action', slot);
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  setHtml(button, ICONS[icon]);
  return button;
};

const flashCopied = (button: HTMLButtonElement, copiedTitle: string, restore: keyof typeof ICONS, restoreTitle: string): void => {
  setHtml(button, ICONS.check);
  button.setAttribute('title', copiedTitle);
  window.setTimeout(() => {
    setHtml(button, ICONS[restore]);
    button.setAttribute('title', restoreTitle);
  }, 2000);
};

// ---------------------------------------------------------------------------
// Code blocks: inline-code marker + copy button wrapper
// ---------------------------------------------------------------------------

const decorateInlineCode = (root: HTMLElement): void => {
  const inline = root.querySelectorAll<HTMLElement>(':not(pre) > code');
  for (const code of Array.from(inline)) {
    if (code.getAttribute('data-markdown') !== 'inline-code') {
      code.setAttribute('data-markdown', 'inline-code');
    }
  }
};

const decorateCodeBlocks = (root: HTMLElement, labels: DecorateLabels): void => {
  const blocks = root.querySelectorAll<HTMLPreElement>('pre');
  for (const pre of Array.from(blocks)) {
    // Skip diagram placeholders (mermaid/plantuml handled separately).
    if (pre.querySelector('code.language-mermaid, code.language-plantuml')) continue;
    const parent = pre.parentElement;
    if (!parent) continue;
    // Already wrapped (idempotent across morphdom passes).
    if (parent.closest('[data-component="markdown-code"]')) continue;

    // `data-md-lang` is stamped by the async highlight pass; on the synchronous
    // first paint it isn't set yet, so fall back to the `language-*` class marked
    // emits — keeps the card header label stable instead of flashing 'text'.
    const classLang = pre.querySelector('code')?.className.match(/language-([\w+#.-]+)/)?.[1];
    const language = pre.getAttribute('data-md-lang') ?? classLang ?? 'text';

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-component', 'markdown-code');
    wrapper.className =
      'my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between border-b border-border/70 px-3 py-1.5';
    const langLabel = document.createElement('span');
    langLabel.className = 'font-mono text-[13px] text-muted-foreground';
    langLabel.textContent = language;
    const copyBtn = makeIconButton('copy', labels.copy, 'copy-code');
    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    const body = document.createElement('div');
    body.className = 'px-3 py-2.5 overflow-x-auto';

    parent.replaceChild(wrapper, pre);
    pre.style.margin = '0';
    pre.style.background = 'transparent';
    body.appendChild(pre);
    wrapper.appendChild(header);
    wrapper.appendChild(body);
  }
};

// ---------------------------------------------------------------------------
// Tables: wrapper + copy/download toolbars
// ---------------------------------------------------------------------------

const extractTableData = (table: HTMLTableElement): { headers: string[]; rows: string[][] } => {
  const headers: string[] = [];
  const rows: string[][] = [];
  const headerCells = table.querySelectorAll('thead th');
  for (const cell of Array.from(headerCells)) headers.push((cell.textContent ?? '').trim());
  const bodyRows = table.querySelectorAll('tbody tr');
  for (const row of Array.from(bodyRows)) {
    const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.textContent ?? '').trim());
    if (cells.length > 0) rows.push(cells);
  }
  return { headers, rows };
};

const escapeCsv = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export const tableToCSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string =>
  [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');

export const tableToTSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string =>
  [headers, ...rows].map((row) => row.join('\t')).join('\n');

export const tableToMarkdown = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
};

const buildTableMenu = (action: string, items: Array<{ key: string; label: string }>): HTMLDivElement => {
  const menu = document.createElement('div');
  // Match the app's DropdownMenu look (same class tokens + surface colors).
  menu.className = `absolute top-full right-0 mt-1 hidden ${dropdownMenuPopupClass}`;
  menu.style.backgroundColor = 'var(--surface-elevated)';
  menu.style.color = 'var(--surface-elevated-foreground)';
  menu.setAttribute('data-md-menu', action);
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `w-full text-left ${dropdownMenuItemClass}`;
    button.setAttribute('data-md-action', `${action}-${item.key}`);
    button.textContent = item.label;
    menu.appendChild(button);
  }
  return menu;
};

const decorateTables = (root: HTMLElement, labels: DecorateLabels): void => {
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  for (const table of Array.from(tables)) {
    const existing = table.closest('[data-markdown="table-wrapper"]');
    if (existing) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'group my-4 flex flex-col space-y-2';
    wrapper.setAttribute('data-markdown', 'table-wrapper');

    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center justify-end gap-1';

    const copyGroup = document.createElement('div');
    copyGroup.className = 'relative';
    copyGroup.appendChild(makeIconButton('copy', labels.copyTable, 'table-copy-toggle'));
    copyGroup.appendChild(buildTableMenu('table-copy', [
      { key: 'csv', label: 'CSV' },
      { key: 'tsv', label: 'TSV' },
      { key: 'markdown', label: 'Markdown' },
    ]));

    const downloadGroup = document.createElement('div');
    downloadGroup.className = 'relative';
    downloadGroup.appendChild(makeIconButton('download', labels.downloadTable, 'table-download-toggle'));
    downloadGroup.appendChild(buildTableMenu('table-download', [
      { key: 'csv', label: 'CSV' },
      { key: 'markdown', label: 'Markdown' },
    ]));

    toolbar.appendChild(copyGroup);
    toolbar.appendChild(downloadGroup);

    const scroll = document.createElement('div');
    scroll.className = 'overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]';

    const parent = table.parentElement;
    if (!parent) continue;
    parent.replaceChild(wrapper, table);
    table.setAttribute('data-markdown', 'table');
    table.classList.add('w-full', 'border-collapse', 'text-sm');

    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      tr.classList.add('border-b', 'border-border/60');
    }
    const lastBodyRow = table.querySelector('tbody tr:last-child');
    lastBodyRow?.classList.remove('border-b');
    lastBodyRow?.classList.add('border-0');
    for (const th of Array.from(table.querySelectorAll('th'))) {
      th.classList.add('border-r', 'border-border/60', 'px-4', 'py-2.5', 'text-left', 'align-middle', 'font-semibold', 'text-foreground', 'last:border-r-0');
    }
    for (const td of Array.from(table.querySelectorAll('td'))) {
      td.classList.add('border-r', 'border-border/60', 'px-4', 'py-2.5', 'align-middle', 'text-foreground/90', 'last:border-r-0');
    }

    scroll.appendChild(table);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(scroll);
  }
};

// ---------------------------------------------------------------------------
// Mermaid: replace ```mermaid code fences with rendered diagram blocks
// ---------------------------------------------------------------------------

const decorateMermaid = (root: HTMLElement, ctx: DecorateContext): void => {
  const codes = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  for (const code of Array.from(codes)) {
    const pre = code.parentElement as HTMLPreElement | null;
    if (!pre) continue;
    const source = (code.textContent ?? '').replace(/\s+$/, '');
    const rendered = ctx.renderMermaid(source);

    const block = document.createElement('div');
    block.setAttribute('data-markdown', 'mermaid-block');
    block.className = 'group relative';

    const scroll = document.createElement('div');
    scroll.setAttribute('data-markdown', 'mermaid-scroll');

    const toolbar = document.createElement('div');
    toolbar.className = 'absolute top-1 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity';

    if (rendered.svg) {
      const svgHost = document.createElement('div');
      svgHost.setAttribute('data-markdown', 'mermaid');
      svgHost.setAttribute('data-md-diagram', 'mermaid');
      setHtml(svgHost, rendered.svg);
      scroll.appendChild(svgHost);
      const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
      copy.setAttribute('data-md-source', source);
      const download = makeIconButton('download', ctx.labels.downloadDiagram, 'mermaid-download');
      download.setAttribute('data-md-svg', '1');
      // Magnify: emits data-md-action="mermaid-expand"; the React hook
      // (useMermaidInlineInteractions) listens for it and opens the fullscreen popup.
      const expand = makeIconButton('expand', ctx.labels.expandDiagram, 'mermaid-expand');
      toolbar.appendChild(copy);
      toolbar.appendChild(download);
      toolbar.appendChild(expand);
    } else {
      const asciiPre = document.createElement('pre');
      asciiPre.setAttribute('data-markdown', 'mermaid-ascii');
      asciiPre.textContent = rendered.ascii || source;
      scroll.appendChild(asciiPre);
      const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
      copy.setAttribute('data-md-source', rendered.ascii || source);
      // Magnify is available in ascii mode too; the popup re-renders the source per the
      // current rendering mode.
      const expand = makeIconButton('expand', ctx.labels.expandDiagram, 'mermaid-expand');
      toolbar.appendChild(copy);
      toolbar.appendChild(expand);
    }

    block.appendChild(scroll);
    block.appendChild(toolbar);

    const host = pre.parentElement;
    if (!host) continue;
    host.replaceChild(block, pre);
  }
};

// ---------------------------------------------------------------------------
// PlantUML: async twin of mermaid — placeholder -> queued render -> guarded inject
// ---------------------------------------------------------------------------

const buildPlantumlPlaceholder = (label: string): HTMLElement => {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-markdown', 'plantuml-loading');
  wrap.className = 'flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground';
  const spinner = document.createElement('span');
  spinner.className = 'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = label;
  wrap.appendChild(spinner);
  wrap.appendChild(text);
  return wrap;
};

const buildPlantumlError = (title: string, detail?: string): HTMLElement => {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-markdown', 'plantuml-error');
  wrap.className = 'px-3 py-4 text-sm text-destructive';
  const heading = document.createElement('div');
  heading.className = 'font-medium';
  heading.textContent = title;
  wrap.appendChild(heading);
  if (detail && detail.trim().length > 0) {
    const sub = document.createElement('div');
    sub.className = 'mt-1 text-xs text-muted-foreground';
    sub.textContent = detail;
    wrap.appendChild(sub);
  }
  return wrap;
};

const PLANTUML_HOST_SELECTOR = '[data-markdown="plantuml"]';
const PLANTUML_LOADING_SELECTOR = '[data-markdown="plantuml-loading"]';
// Stamped on a LIVE block once its current render key has actually painted, so a later
// post-pass over an unchanged block is a no-op (AC9 — no double-paint). morphdom strips this
// attr whenever it updates the block (source edit → fresh spinner, attr absent on the temp
// node), which correctly re-arms the block for a repaint; a morphdom-SKIPPED block (unchanged
// data-md-id, e.g. a theme toggle) keeps the stamp, so the key comparison alone re-triggers.
const PLANTUML_RENDERED_KEY_ATTR = 'data-plantuml-rendered-key';

/**
 * Build the placeholder DOM for every ```plantuml fence — but DO NOT enqueue the async render
 * here. This runs against the DETACHED pre-morphdom `temp` node; morphdom then reuses the LIVE
 * node and discards `temp`, so a render enqueued against `temp` would resolve into a
 * disconnected node and be dropped by the generation guard (the perpetual-spinner bug). The
 * enqueue + guarded paint happens in renderPlantumlBlocks, run POST-commit against the live DOM.
 */
const decoratePlantuml = (root: HTMLElement, ctx: DecorateContext): void => {
  const slot = ctx.renderPlantuml;
  // Wiring gate: with no renderPlantuml slot this is a no-op. (The ~8.6MB engine is still never
  // touched here — enqueue/load lives in renderPlantumlBlocks, gated on a LIVE plantuml block.)
  if (!slot) return;
  const codes = root.querySelectorAll<HTMLElement>('pre > code.language-plantuml');
  for (const code of Array.from(codes)) {
    const pre = code.parentElement as HTMLPreElement | null;
    if (!pre) continue;
    const source = (code.textContent ?? '').replace(/\s+$/, '');

    const block = document.createElement('div');
    block.setAttribute('data-markdown', 'plantuml-block');
    block.setAttribute(PLANTUML_SOURCE_ATTR, source);
    block.className = 'group relative';

    const scroll = document.createElement('div');
    scroll.setAttribute('data-markdown', 'plantuml-scroll');

    const svgHost = document.createElement('div');
    svgHost.setAttribute('data-markdown', 'plantuml');
    svgHost.setAttribute('data-md-diagram', 'plantuml');
    svgHost.appendChild(buildPlantumlPlaceholder(slot.labels.loading));

    scroll.appendChild(svgHost);

    const toolbar = document.createElement('div');
    toolbar.className = 'absolute top-1 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity';
    // Magnify: emits data-md-action="plantuml-expand"; the React hook
    // (usePlantumlInlineInteractions) listens for it and opens the fullscreen popup.
    const expand = makeIconButton('expand', ctx.labels.expandDiagram, 'plantuml-expand');
    toolbar.appendChild(expand);

    block.appendChild(scroll);
    block.appendChild(toolbar);

    const host = pre.parentElement;
    if (!host) continue;
    host.replaceChild(block, pre);
  }
};

/**
 * Post-commit PlantUML render pass — the fix for the async-repaint bug. Runs AFTER the live DOM
 * is committed (the synchronous first-paint append AND every morphdom re-decoration cycle),
 * against the LIVE target, so every enqueue/paint is anchored to the LIVE block node rather than
 * the detached `temp` node decoratePlantuml sees. Because morphdom reuses the same live block
 * node across source edits, the queue's per-node generation + latest-only backpressure stay
 * coherent: a superseding source bumps the generation and any stale in-flight render loses the
 * isEligible check. This mirrors mermaid's synchronous paint, but for the async engine.
 *
 * Block-presence gate (AC6): no slot OR no live plantuml block ⇒ zero enqueues ⇒ renderPlantuml
 * (and its lazy engine load) is never invoked, so the baseline bundle stays engine-free.
 */
export const renderPlantumlBlocks = (target: HTMLElement, ctx: DecorateContext): void => {
  const slot = ctx.renderPlantuml;
  if (!slot) return;
  const blocks = target.querySelectorAll<HTMLElement>(PLANTUML_BLOCK_SELECTOR);
  for (const block of Array.from(blocks)) {
    if (!block.isConnected) continue;
    const svgHost = block.querySelector<HTMLElement>(PLANTUML_HOST_SELECTOR);
    if (!svgHost) continue;
    const source = block.getAttribute(PLANTUML_SOURCE_ATTR) ?? '';
    const key = buildPlantumlCacheKey(slot, source);

    // Re-enqueue only when the block still shows the loading placeholder (never painted, or
    // morphdom reset the host to a fresh spinner) OR its render key changed (source edit or a
    // light/dark theme flip). A settled block whose key is unchanged is skipped — no double
    // paint (AC9) and no wasted engine work during streaming. A morphdom-SKIPPED block (theme
    // toggle: unchanged data-md-id, morphdom never ran) still repaints because the dark flip
    // changes the key even though its stamp survived (AC8).
    const loading = svgHost.querySelector(PLANTUML_LOADING_SELECTOR) !== null;
    if (!loading && block.getAttribute(PLANTUML_RENDERED_KEY_ATTR) === key) continue;

    const handle = slot.queue.enqueue(key, source, slot.dark, slot.themeBody, block);
    void handle.promise.then((result) => {
      // Generation guard against the LIVE node: only paint if this exact block is still
      // connected AND still carries the same key+generation. A newer source (or theme) already
      // bumped the generation via a later enqueue on the same live node, so a stale render — or
      // one targeting a node morphdom has since discarded — loses here (AC4/AC7 latest-only).
      if (!slot.queue.isEligible(block, handle.key, handle.generation)) return;
      // Re-query the live host: morphdom may have swapped the host element since enqueue.
      const liveHost = block.querySelector<HTMLElement>(PLANTUML_HOST_SELECTOR);
      if (!liveHost) return;
      const scaleHost = liveHost.closest<HTMLElement>('[data-md-diagram]');
      if (result.svg) {
        setHtml(liveHost, result.svg);
        // Condense any box label that overflows its rect BEFORE the body-scale reads geometry.
        fitPlantumlBoxText(liveHost);
        // The shared applyDiagramBodyScale passes already ran (pre-paint), so scale THIS host now
        // against its just-painted svg — the async PlantUML paint is the only moment its svg
        // exists. Single-host (no whole-container rescan on the paint hot path).
        if (scaleHost) applyDiagramHostBodyScale(scaleHost);
      } else {
        // Error affordance in-place — the placeholder is replaced, never left spinning (AC2).
        setHtml(liveHost, '');
        liveHost.appendChild(buildPlantumlError(slot.labels.error, result.error));
        // Clear any scale a prior good render stamped so a good->error transition leaves no
        // stale transform on the now-svg-less host. This branch bypasses scaleHostToBodyPx, so
        // it must ALSO clear the reserved marginBottom (the bottom-clip height compensation) or a
        // prior upscale would strand phantom space below the error affordance.
        if (scaleHost) {
          scaleHost.removeAttribute('data-md-diagram-scale');
          scaleHost.style.transform = '';
          scaleHost.style.removeProperty('transform-origin');
          scaleHost.style.removeProperty('margin-bottom');
        }
      }
      // Stamp the settled key so an unchanged follow-up pass skips this block (AC9).
      block.setAttribute(PLANTUML_RENDERED_KEY_ATTR, key);
    });
  }
};

// ---------------------------------------------------------------------------
// External links: favicon + loopback preview button
// ---------------------------------------------------------------------------

const decorateLinks = (root: HTMLElement, ctx: DecorateContext): void => {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const anchor of Array.from(anchors)) {
    if (anchor.getAttribute('data-md-link-decorated') === 'true') continue;
    if (anchor.getAttribute('data-openchamber-file-link') === 'true') continue;
    const href = anchor.getAttribute('href') ?? '';
    if (!isExternalHttpUrl(href)) continue;
    anchor.setAttribute('data-md-link-decorated', 'true');

    const faviconUrl = getExternalFaviconUrl(href);
    if (faviconUrl) {
      const favWrap = document.createElement('span');
      favWrap.className =
        'mr-1 inline-flex size-[18px] items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)] align-middle';
      const img = document.createElement('img');
      img.src = faviconUrl;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'size-3.5 rounded-sm';
      img.addEventListener('error', () => favWrap.remove(), { once: true });
      favWrap.appendChild(img);
      anchor.parentNode?.insertBefore(favWrap, anchor);
    }

    if (ctx.onPreviewLoopback && isLoopbackHttpUrl(href)) {
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = `ml-1 align-middle ${ICON_BTN_CLASS}`;
      preview.setAttribute('data-md-action', 'preview-loopback');
      preview.setAttribute('data-md-url', href);
      preview.setAttribute('title', ctx.labels.previewTitle);
      preview.setAttribute('aria-label', ctx.labels.previewLabel);
      setHtml(preview, ICONS.download);
      anchor.parentNode?.insertBefore(preview, anchor.nextSibling);
    }
  }
};

// Assign stable, de-duped ids to the rendered h1/h2/h3 headings BY POSITION
// (nth collected heading token -> nth rendered h-tag), so a ToC can anchor-scroll
// to them. Runs POST-sanitize (called from decorateMarkdown on the temp node
// before morphdom), so the ids bypass DOMPurify's allowlist. Opt-in: only when
// ctx.injectHeadingIds is provided. On a heading token/element count mismatch it
// SKIPS injection entirely and warns — never risking a misassignment. Ids are
// de-duped in-document and against existing ids because morphdom keys on id, so
// a duplicate would corrupt the DOM on the next content edit.
export const decorateHeadings = (root: HTMLElement, slot: HeadingIdSlot): void => {
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3');

  // Reserve every id already in the tree EXCEPT the target headings (whose ids we
  // own/overwrite), so injected slugs never collide with a pre-existing id.
  const targets = new Set<Element>(Array.from(headings));
  const reserved = new Set<string>();
  root.querySelectorAll<HTMLElement>('[id]').forEach((el) => {
    if (!targets.has(el) && el.id) reserved.add(el.id);
  });

  const ids = planHeadingIds(slot.renderedContent, headings.length, { existingIds: reserved });
  if (!ids) {
    console.warn(
      '[decorateHeadings] heading token/element count mismatch — skipping id injection to avoid misassignment',
    );
    return;
  }

  headings.forEach((heading, index) => {
    heading.id = ids[index]!;
  });
};

/** Run all idempotent DOM decoration passes over freshly-rendered markdown. */
export const decorateMarkdown = (root: HTMLElement, ctx: DecorateContext): void => {
  decorateInlineCode(root);
  decorateMermaid(root, ctx);
  decoratePlantuml(root, ctx);
  decorateCodeBlocks(root, ctx.labels);
  decorateTables(root, ctx.labels);
  decorateLinks(root, ctx);
  // Opt-in, runs LAST so heading ids can de-dupe against any ids the decorators
  // above introduced. No-op unless a caller wired ctx.injectHeadingIds.
  if (ctx.injectHeadingIds) decorateHeadings(root, ctx.injectHeadingIds);
};

// ---------------------------------------------------------------------------
// Delegated interactions (copy/download/menus/preview)
// ---------------------------------------------------------------------------

const downloadBlob = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const closeAllMenus = (container: HTMLElement): void => {
  for (const menu of Array.from(container.querySelectorAll<HTMLElement>('[data-md-menu]'))) {
    menu.classList.add('hidden');
  }
};

/**
 * Attach a single delegated click listener for all in-markdown actions: code
 * copy, table copy/download menus, mermaid copy/download, loopback preview.
 * Returns a cleanup function.
 */
export const attachMarkdownInteractions = (
  container: HTMLElement,
  ctx: DecorateContext,
): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionEl = target.closest<HTMLElement>('[data-md-action]');
    if (!actionEl) {
      closeAllMenus(container);
      return;
    }
    const action = actionEl.getAttribute('data-md-action') ?? '';

    // Copy code
    if (action === 'copy-code') {
      const code = actionEl.closest('[data-component="markdown-code"]')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) void copyTextToClipboard(text).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copy));
      return;
    }

    // Toggle table menus
    if (action === 'table-copy-toggle' || action === 'table-download-toggle') {
      event.preventDefault();
      const menu = actionEl.parentElement?.querySelector<HTMLElement>('[data-md-menu]') ?? null;
      const willOpen = menu?.classList.contains('hidden') ?? false;
      closeAllMenus(container);
      if (menu && willOpen) menu.classList.remove('hidden');
      return;
    }

    // Table copy formats
    if (action.startsWith('table-copy-')) {
      const format = action.replace('table-copy-', '');
      const table = actionEl.closest('[data-markdown="table-wrapper"]')?.querySelector('table');
      if (table instanceof HTMLTableElement) {
        const data = extractTableData(table);
        const content = format === 'csv' ? tableToCSV(data) : format === 'tsv' ? tableToTSV(data) : tableToMarkdown(data);
        void copyTextToClipboard(content);
      }
      closeAllMenus(container);
      return;
    }

    // Table download formats
    if (action.startsWith('table-download-')) {
      const format = action.replace('table-download-', '');
      const table = actionEl.closest('[data-markdown="table-wrapper"]')?.querySelector('table');
      if (table instanceof HTMLTableElement) {
        const data = extractTableData(table);
        const content = format === 'csv' ? tableToCSV(data) : tableToMarkdown(data);
        downloadBlob(format === 'csv' ? 'table.csv' : 'table.md', content, format === 'csv' ? 'text/csv' : 'text/markdown');
      }
      closeAllMenus(container);
      return;
    }

    // Mermaid copy source / ascii
    if (action === 'mermaid-copy') {
      const source = actionEl.getAttribute('data-md-source') ?? '';
      if (source) void copyTextToClipboard(source).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copyDiagram));
      return;
    }

    // Mermaid download svg
    if (action === 'mermaid-download') {
      const svgHost = actionEl.closest('[data-markdown="mermaid-block"]')?.querySelector('[data-markdown="mermaid"]');
      const svg = svgHost?.innerHTML ?? '';
      if (svg) downloadBlob('diagram.svg', svg, 'image/svg+xml;charset=utf-8');
      return;
    }

    // Loopback preview
    if (action === 'preview-loopback') {
      event.preventDefault();
      const url = actionEl.getAttribute('data-md-url') ?? '';
      if (url) ctx.onPreviewLoopback?.(url);
      return;
    }
  };

  container.addEventListener('click', handleClick);
  return () => container.removeEventListener('click', handleClick);
};
