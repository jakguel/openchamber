import * as React from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type { TocEntry } from '../toc';
import { buildTocTree, type TocNode } from './tocModel';
import { scrollToHeading } from './scrollToHeading';

type ScrollTarget = () => HTMLElement | null;

export type TocTreeProps = {
  /** Ordered ToC model from `extractToc` (H1–H3, document order). */
  entries: TocEntry[];
  /**
   * Resolve the scrollable container for the active preview surface. Read lazily
   * (per surface: inline div, fullscreen overlay, mobile ScrollShadow) so a
   * changing ref is always current at click time.
   */
  getScroller?: ScrollTarget;
  /** Resolve the element whose subtree holds the decorated heading ids. */
  getContentRoot?: ScrollTarget;
  /**
   * Alternative to `getScroller`/`getContentRoot`: fully own scrolling. When
   * provided it takes precedence and receives the heading id (`TocEntry.slug`).
   */
  onScrollToHeading?: (id: string) => void;
  /**
   * Resolves once the next render commit lands (heading ids in the live DOM).
   * A click awaits this ONLY when the target id is not yet present, so a static,
   * already-rendered document never waits. Pair with `createCommitSignal`.
   */
  waitForCommit?: () => Promise<void>;
  /** Slugs whose nodes start collapsed. Default: none (all expanded). */
  defaultCollapsedSlugs?: Iterable<string>;
  className?: string;
};

const indentStyle = (depth: number): React.CSSProperties => ({
  paddingInlineStart: `${(depth - 1) * 12}px`,
});

type NodeProps = {
  node: TocNode;
  collapsed: Set<string>;
  onToggle: (slug: string, open: boolean) => void;
  onSelect: (entry: TocEntry) => void;
};

const rowText = 'truncate text-left text-sm text-foreground';
const rowHover =
  'rounded-md hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

const LeafRow: React.FC<NodeProps> = ({ node, onSelect }) => {
  const { t } = useI18n();
  const { entry } = node;
  return (
    <li>
      <button
        type="button"
        style={indentStyle(entry.depth)}
        className={cn('flex w-full items-center gap-1.5 px-2 py-1', rowText, rowHover)}
        aria-label={t('markdown.toc.gotoHeadingAria', { heading: entry.text })}
        onClick={() => onSelect(entry)}
      >
        <span aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{entry.text}</span>
      </button>
    </li>
  );
};

const BranchRow: React.FC<NodeProps> = ({ node, collapsed, onToggle, onSelect }) => {
  const { t } = useI18n();
  const { entry, children } = node;
  const isCollapsed = collapsed.has(entry.slug);
  const toggleAria = isCollapsed
    ? t('markdown.toc.expandAria', { heading: entry.text })
    : t('markdown.toc.collapseAria', { heading: entry.text });
  return (
    <li>
      <Collapsible open={!isCollapsed} onOpenChange={(open) => onToggle(entry.slug, open)}>
        <div
          style={indentStyle(entry.depth)}
          className={cn('flex w-full items-center gap-0.5 px-2 py-1', rowHover)}
        >
          <CollapsibleTrigger
            aria-label={toggleAria}
            className="flex size-4 shrink-0 items-center justify-center rounded p-0 text-muted-foreground hover:bg-transparent"
          >
            <Icon
              name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'}
              className="size-4"
            />
          </CollapsibleTrigger>
          <button
            type="button"
            className={cn('flex min-w-0 flex-1 items-center', rowText)}
            aria-label={t('markdown.toc.gotoHeadingAria', { heading: entry.text })}
            onClick={() => onSelect(entry)}
          >
            <span className="truncate">{entry.text}</span>
          </button>
        </div>
        <CollapsibleContent>
          <ul className="list-none">
            {children.map((child) => (
              <TocNodeRow
                key={child.entry.slug}
                node={child}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
};

const TocNodeRow: React.FC<NodeProps> = (props) =>
  props.node.children.length > 0 ? <BranchRow {...props} /> : <LeafRow {...props} />;

/**
 * Presentation-only, collapsible ToC tree for the Markdown preview. Renders the
 * `extractToc` model as a nested tree — default ALL-EXPANDED — with ephemeral,
 * per-node collapse state (React `useState`, never persisted). Clicking an entry
 * awaits the post-commit signal (when the anchor id is not yet in the DOM) and
 * then scrolls the resolved scroller to the heading via `scrollToHeading`.
 *
 * Call sites (desktop sidebar / mobile sheet) supply the scroller + content root
 * refs and the commit signal; this component owns no layout or store state.
 */
export const TocTree: React.FC<TocTreeProps> = ({
  entries,
  getScroller,
  getContentRoot,
  onScrollToHeading,
  waitForCommit,
  defaultCollapsedSlugs,
  className,
}) => {
  const { t } = useI18n();
  const tree = React.useMemo(() => buildTocTree(entries), [entries]);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(
    () => new Set(defaultCollapsedSlugs ? Array.from(defaultCollapsedSlugs) : []),
  );

  const handleToggle = React.useCallback((slug: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const handleSelect = React.useCallback(
    async (entry: TocEntry) => {
      if (onScrollToHeading) {
        onScrollToHeading(entry.slug);
        return;
      }
      const root = getContentRoot?.();
      const scroller = getScroller?.();
      if (!root || !scroller) return;
      const present = root.querySelector(`#${CSS.escape(entry.slug)}`);
      if (!present && waitForCommit) {
        await waitForCommit();
      }
      scrollToHeading(scroller, root, entry.slug, { smooth: true });
    },
    [onScrollToHeading, getContentRoot, getScroller, waitForCommit],
  );

  if (entries.length === 0) return null;

  return (
    <nav aria-label={t('markdown.toc.navAria')} className={cn('min-w-0', className)}>
      <ul className="list-none">
        {tree.map((node) => (
          <TocNodeRow
            key={node.entry.slug}
            node={node}
            collapsed={collapsed}
            onToggle={handleToggle}
            onSelect={handleSelect}
          />
        ))}
      </ul>
    </nav>
  );
};
