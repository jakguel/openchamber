import React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { Icon } from "@/components/icon/Icon";
import { computeRailOverflow, SCROLL_RAIL_WIDTH } from './sortable-tabs-strip-overflow';

export type SortableTabsStripItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  title?: string;
  closable?: boolean;
  closeLabel?: string;
};

type SortableTabsStripProps = {
  items: SortableTabsStripItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onReorder?: (activeId: string, overId: string) => void;
  layoutMode?: 'scrollable' | 'fit';
  variant?: 'default' | 'active-pill' | 'animated';
  activePillInsetClassName?: string;
  activePillButtonClassName?: string;
  inactiveTabsIconOnly?: boolean;
  iconOnlyActiveTab?: boolean;
  animateActivePill?: boolean;
  activePillLowercase?: boolean;
  /**
   * Opt-in: pin the first tab (assumed to be the Chat tab) as a non-scrolling
   * flex sibling before the scroll region. Defaults to false — byte-identical
   * to today for every existing caller.
   */
  pinFirstTab?: boolean;
  /**
   * Opt-in scaffold: render overflow scroll-arrow controls. Typed now so the
   * prop surface is stable; behavior is implemented in a follow-up work item.
   */
  showScrollButtons?: boolean;
  /**
   * Opt-in scaffold: give file tabs an equal fixed width with a right-edge
   * ombre fade replacing truncation. Typed now; behavior implemented later.
   */
  equalTabWidth?: boolean;
  className?: string;
};

const restrictToXAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

// Minimum per-click scroll distance (one file-tab width) so an ultra-narrow
// strip still advances when clientWidth / 2 would be smaller.
const MIN_SCROLL_STEP = 140;

const SortableTabWrapper: React.FC<{ id: string; children: React.ReactNode; className?: string }> = ({ id, children, className }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      data-sortable-tab-id={id}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn('h-full rounded-md', className, isDragging && 'opacity-50')}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

const StaticTabWrapper: React.FC<{ id: string; children: React.ReactNode; className?: string }> = ({ id, children, className }) => (
  <div className={cn('h-full', className)} data-sortable-tab-id={id}>{children}</div>
);

export const SortableTabsStrip: React.FC<SortableTabsStripProps> = ({
  items,
  activeId,
  onSelect,
  onClose,
  onReorder,
  layoutMode = 'scrollable',
  variant = 'default',
  activePillInsetClassName,
  activePillButtonClassName,
  inactiveTabsIconOnly = false,
  iconOnlyActiveTab = false,
  animateActivePill,
  activePillLowercase = true,
  pinFirstTab = false,
  showScrollButtons = false,
  equalTabWidth = false,
  className,
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowCloseControls = isMobile || isTablet;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  // Rail-independent "does content overflow" flag that gates rail mounting.
  const [hasOverflow, setHasOverflow] = React.useState(false);
  const hasOverflowRef = React.useRef(false);
  const itemIDs = React.useMemo(() => items.map((item) => item.id), [items]);
  const isScrollable = layoutMode === 'scrollable';
  const isDefaultVariant = variant === 'default';
  const isActivePillVariant = variant === 'active-pill';
  const isAnimatedVariant = variant === 'animated';
  const usesActivePillIndicator = isActivePillVariant || isAnimatedVariant;
  const useUnderlineIndicator = isDefaultVariant;
  const usesIndicator = usesActivePillIndicator || useUnderlineIndicator;
  const useIntrinsicPillSizing = isActivePillVariant && isScrollable;
  const showPillTrackBackground = usesActivePillIndicator;
  const shouldAnimateActivePill = animateActivePill ?? isAnimatedVariant;
  const reorderEnabled = typeof onReorder === 'function';
  const Wrapper = reorderEnabled ? SortableTabWrapper : StaticTabWrapper;
  // File tabs render at a fixed equal width with a right-edge ombre fade
  // (replacing truncation) ONLY on the default underline variant when scrollable.
  // Off by default -> byte-identical for every other caller.
  const equalWidthFileTabs = equalTabWidth && useUnderlineIndicator && isScrollable;
  const tabRefs = React.useRef<Map<string, HTMLElement>>(new Map());
  const [pillRect, setPillRect] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Pin the first (Chat) tab as a non-scrolling flex sibling. Only the first
  // tab pins — this is deliberately NOT a generalized pin framework.
  const pinFirst = pinFirstTab && items.length > 0;
  const pinnedItem = pinFirst ? items[0] : null;
  const scrollItems = pinFirst ? items.slice(1) : items;
  const pinnedTabRef = React.useRef<HTMLDivElement>(null);
  const [pinnedWidth, setPinnedWidth] = React.useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const isSamePillRect = React.useCallback((
    a: { left: number; top: number; width: number; height: number } | null,
    b: { left: number; top: number; width: number; height: number } | null,
  ) => {
    if (!a || !b) {
      return a === b;
    }
    return Math.abs(a.left - b.left) < 0.5
      && Math.abs(a.top - b.top) < 0.5
      && Math.abs(a.width - b.width) < 0.5
      && Math.abs(a.height - b.height) < 0.5;
  }, []);

  const setTabRef = React.useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      tabRefs.current.set(id, element);
      return;
    }
    tabRefs.current.delete(id);
  }, []);

  const updateActivePillRect = React.useCallback(() => {
    if (!usesIndicator || !activeId) {
      setPillRect((prev) => (prev === null ? prev : null));
      return;
    }

    const container = scrollRef.current;
    const activeTab = tabRefs.current.get(activeId);
    if (!container || !activeTab) {
      setPillRect((prev) => (prev === null ? prev : null));
      return;
    }

    // Walk offsetParent chain to compute position relative to the scroll container.
    // Unlike getBoundingClientRect, offsetLeft/offsetTop are unaffected by CSS
    // transforms (e.g. dropdown entry scale animation), preventing pill mis-positioning
    // on first render.
    let left = 0;
    let top = 0;
    let el: HTMLElement | null = activeTab;
    while (el && el !== container) {
      left += el.offsetLeft;
      top += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }

    const nextRect = {
      left,
      top,
      width: activeTab.offsetWidth,
      height: activeTab.offsetHeight,
    };

    setPillRect((prev) => (isSamePillRect(prev, nextRect) ? prev : nextRect));
  }, [activeId, isSamePillRect, usesIndicator]);

  const updateOverflow = React.useCallback(() => {
    if (!isScrollable) {
      setOverflow({ left: false, right: false });
      setHasOverflow((prev) => (prev === false ? prev : false));
      hasOverflowRef.current = false;
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      setOverflow({ left: false, right: false });
      setHasOverflow((prev) => (prev === false ? prev : false));
      hasOverflowRef.current = false;
      return;
    }

    setOverflow({
      left: element.scrollLeft > 2,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 2,
    });

    const next = computeRailOverflow({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      railMounted: showScrollButtons && hasOverflowRef.current,
      railWidth: SCROLL_RAIL_WIDTH,
    });
    hasOverflowRef.current = next;
    setHasOverflow((prev) => (prev === next ? prev : next));
  }, [isScrollable, showScrollButtons]);

  React.useEffect(() => {
    if (!isScrollable) {
      setOverflow({ left: false, right: false });
      setHasOverflow((prev) => (prev === false ? prev : false));
      hasOverflowRef.current = false;
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    updateOverflow();
    element.addEventListener('scroll', updateOverflow, { passive: true });
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', updateOverflow);
      observer.disconnect();
    };
  }, [isScrollable, items.length, updateOverflow]);

  React.useEffect(() => {
    if (!usesIndicator) {
      setPillRect(null);
      return;
    }

    updateActivePillRect();

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(updateActivePillRect);
    observer.observe(element);

    if (activeId) {
      const activeTab = tabRefs.current.get(activeId);
      if (activeTab) {
        observer.observe(activeTab);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [activeId, items.length, updateActivePillRect, usesIndicator]);

  React.useLayoutEffect(() => {
    updateActivePillRect();
  });

  React.useEffect(() => {
    if (!isScrollable || !activeId) {
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const escapedID = typeof window.CSS?.escape === 'function'
        ? window.CSS.escape(activeId)
        : activeId.replace(/"/g, '\\"');
      const target = element.querySelector<HTMLElement>(`[data-sortable-tab-id="${escapedID}"]`);
      if (!target) {
        return;
      }

      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateOverflow();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeId, isScrollable, items.length, updateOverflow]);

  React.useEffect(() => {
    if (!pinFirst) {
      setPinnedWidth((prev) => (prev === 0 ? prev : 0));
      return;
    }

    const element = pinnedTabRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      const width = element.offsetWidth;
      setPinnedWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [pinFirst, pinnedItem?.label]);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    if (!onReorder) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorder(String(active.id), String(over.id));
  }, [onReorder]);

  const handleScrollButton = React.useCallback((direction: 'left' | 'right') => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const step = Math.max(element.clientWidth / 2, MIN_SCROLL_STEP);
    const prefersReducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    element.scrollBy({
      left: direction === 'left' ? -step : step,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, []);

  const tabRegion = (
    <>
      {pinFirst && pinnedItem ? (
        <div ref={pinnedTabRef} className="flex h-full shrink-0">
          <div
            className={cn(
              'group relative z-10 flex h-full min-w-0 shrink-0 flex-nowrap items-center bg-sidebar',
              pinnedItem.id === activeId ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={pinnedItem.id === activeId}
              onClick={() => onSelect(pinnedItem.id)}
              className="flex h-full min-w-0 flex-nowrap items-center typography-micro max-w-56 justify-start truncate px-3 text-left"
              title={pinnedItem.title ?? pinnedItem.label}
            >
              <span className="flex min-w-0 flex-nowrap items-center gap-1.5">
                {pinnedItem.icon ? (
                  <span
                    className={cn(
                      'relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-200 ease-out',
                      pinnedItem.id === activeId ? 'text-[var(--primary-base)]' : 'text-muted-foreground'
                    )}
                  >
                    <span className="flex items-center justify-center">{pinnedItem.icon}</span>
                  </span>
                ) : null}
                <span className="truncate leading-[1.2]">{pinnedItem.label}</span>
              </span>
            </button>
            {useUnderlineIndicator && pinnedItem.id === activeId ? (
              <div
                className="pointer-events-none absolute inset-x-0 -bottom-px z-10 h-[3px] rounded-t-[2px] bg-[var(--primary-base)]"
                aria-hidden
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {isScrollable && overflow.left ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 z-20 bg-gradient-to-r to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
          style={pinFirst ? { left: pinnedWidth } : undefined}
          aria-hidden
        />
      ) : null}
      {isScrollable && overflow.right ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 z-20 bg-gradient-to-l to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
          style={pinFirst ? undefined : (showScrollButtons ? { right: SCROLL_RAIL_WIDTH } : undefined)}
          aria-hidden
        />
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          'relative flex h-full min-w-0 flex-1',
          usesActivePillIndicator ? 'items-center overflow-x-hidden overflow-y-hidden' : 'items-stretch',
          usesActivePillIndicator && '@container/pill-tabs',
          usesActivePillIndicator && 'pill-tabs__track',
          usesActivePillIndicator && (activePillInsetClassName ?? 'gap-0.5 py-0.5'),
          useUnderlineIndicator && 'items-center overflow-y-hidden',
          showPillTrackBackground && 'rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] p-0.5 gap-0.5',
          isScrollable
            ? 'overflow-x-auto scrollbar-none'
            : 'overflow-x-hidden',
        )}
        style={
          isScrollable
            ? (pinFirst
              ? { scrollbarWidth: 'none', msOverflowStyle: 'none', scrollPaddingInlineStart: pinnedWidth }
              : { scrollbarWidth: 'none', msOverflowStyle: 'none' })
            : undefined
        }
        role={pinFirst ? undefined : 'tablist'}
        aria-label={pinFirst ? undefined : t('sortableTabsStrip.aria.tabs')}
      >
        {usesActivePillIndicator && pillRect ? (
          <div
            className={cn(
              'pointer-events-none absolute left-0 top-0 z-0 rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] bg-[var(--surface-elevated)]',
              'border border-border/60'
            )}
            style={{
              transform: `translate3d(${pillRect.left}px, ${pillRect.top}px, 0)`,
              width: `${pillRect.width}px`,
              height: `${pillRect.height}px`,
              transition: shouldAnimateActivePill
                ? 'transform 300ms cubic-bezier(0.65, 0, 0.35, 1), width 300ms cubic-bezier(0.65, 0, 0.35, 1), height 300ms cubic-bezier(0.65, 0, 0.35, 1)'
                : undefined,
            }}
          />
        ) : null}
        {useUnderlineIndicator && pillRect ? (
          <div
            className="pointer-events-none absolute left-0 -bottom-px z-10 h-[3px] rounded-t-[2px] bg-[var(--primary-base)]"
            style={{
              transform: `translate3d(${pillRect.left}px, 0, 0)`,
              width: `${pillRect.width}px`,
            }}
            aria-hidden
          />
        ) : null}
        {scrollItems.map((item) => {
          const isActive = item.id === activeId;
          const showInactiveIconOnly = inactiveTabsIconOnly && usesActivePillIndicator && !isActive && Boolean(item.icon);
          const shouldShowLabel = !showInactiveIconOnly;
          const shouldShowIcon = Boolean(item.icon) && (!iconOnlyActiveTab || isActive);
          const useIntrinsicActiveTab = inactiveTabsIconOnly && usesActivePillIndicator && isActive && !isScrollable && !useIntrinsicPillSizing;
          const closable = item.closable !== false && Boolean(onClose);
          const closeReplacesIcon = closable && Boolean(item.icon);
          const wrapperClassName = (isScrollable || useIntrinsicPillSizing)
            ? undefined
            : usesActivePillIndicator
              ? (useIntrinsicActiveTab
                ? 'flex-none basis-auto'
                : (isMobile ? 'flex-1 basis-0 min-w-0' : 'flex-1 basis-0 min-w-fit'))
              : 'min-w-0 flex-1 basis-0';
          const handleAuxClick = closable
            ? (event: React.MouseEvent<HTMLDivElement>) => {
                // Middle-click (button === 1) closes the tab. Matches browser tab behavior.
                if (event.button !== 1) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onClose?.(item.id);
              }
            : undefined;
          const handleMouseDown = closable
            ? (event: React.MouseEvent<HTMLDivElement>) => {
                // Prevent the browser's middle-click autoscroll affordance.
                if (event.button === 1) {
                  event.preventDefault();
                }
              }
            : undefined;
          return (
            <Wrapper key={item.id} id={item.id} className={wrapperClassName}>
              <div
                ref={(element) => setTabRef(item.id, element)}
                onAuxClick={handleAuxClick}
                onMouseDown={handleMouseDown}
                className={cn(
                  'group flex h-full min-w-0 flex-nowrap items-center',
                  (isScrollable || useIntrinsicPillSizing)
                    ? (equalWidthFileTabs ? 'w-[140px] shrink-0' : 'shrink-0')
                    : usesActivePillIndicator
                      ? 'w-full'
                      : 'w-full min-w-0',
                  usesActivePillIndicator
                    ? 'relative z-10 bg-transparent'
                    : isActive
                      ? 'relative z-10 bg-transparent text-foreground'
                      : 'relative z-10 bg-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={showInactiveIconOnly ? (item.title ?? item.label) : undefined}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    usesActivePillIndicator
                      ? 'animated-tabs__button pill-tabs__button relative z-10 flex flex-1 min-w-0 flex-nowrap items-center justify-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] text-sm font-medium transition-colors duration-150 !min-h-0'
                      : equalWidthFileTabs
                        ? 'flex h-full min-w-0 flex-1 flex-nowrap items-center typography-ui-label'
                        : 'flex h-full min-w-0 flex-nowrap items-center typography-micro',
                    usesActivePillIndicator && activePillLowercase ? 'lowercase' : null,
                    usesActivePillIndicator && (showInactiveIconOnly ? 'gap-0' : 'gap-1.5'),
                    usesActivePillIndicator
                      ? useIntrinsicPillSizing
                        ? 'shrink-0 whitespace-nowrap px-3 text-center'
                        : isScrollable
                          ? 'max-w-56 shrink-0 px-3 text-center'
                          : (showInactiveIconOnly
                            ? 'px-2 !min-w-0 text-center'
                            : useIntrinsicActiveTab
                              ? 'shrink-0 whitespace-nowrap px-3 text-center'
                              : 'px-3 text-center')
                      : isScrollable
                        ? (equalWidthFileTabs
                          ? 'justify-start px-[3px] text-left'
                          : 'max-w-56 justify-start truncate px-3 text-left')
                        : 'w-full justify-center truncate px-3 text-center',
                    usesActivePillIndicator
                      ? (activePillButtonClassName ?? (isActivePillVariant ? (isMobile ? 'h-[38px]' : 'h-[31px]') : 'h-7'))
                      : null,
                    usesActivePillIndicator
                      ? isActive
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                      : null,
                    usesActivePillIndicator
                      ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background'
                      : null
                  )}
                  title={item.title ?? item.label}
                >
                  {usesActivePillIndicator ? (
                    <>
                      {shouldShowIcon ? (
                        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && (alwaysShowCloseControls ? 'opacity-0' : 'group-hover:opacity-0'))}>{item.icon}</span>
                          {closeReplacesIcon ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className={cn('absolute inset-0 z-20 flex !min-h-0 !min-w-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground', alwaysShowCloseControls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onClose?.(item.id);
                              }}
                              aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                              title={item.closeLabel ?? `Close ${item.label} tab`}
                            >
                              <Icon name="close" className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {shouldShowLabel ? <span className="animated-tabs__label truncate">{item.label}</span> : null}
                    </>
                  ) : (
                    <span className={cn('flex min-w-0 flex-nowrap items-center gap-1.5', !isScrollable && 'justify-center', equalWidthFileTabs && 'flex-1')}>
                      {shouldShowIcon ? (
                        <span
                          className={cn(
                            'relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-200 ease-out',
                            isActive ? 'text-[var(--primary-base)]' : 'text-muted-foreground'
                          )}
                        >
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && (alwaysShowCloseControls ? 'opacity-0' : 'group-hover:opacity-0'))}>{item.icon}</span>
                          {closeReplacesIcon ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className={cn('absolute inset-0 z-20 flex !min-h-0 !min-w-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground', alwaysShowCloseControls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onClose?.(item.id);
                              }}
                              aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                              title={item.closeLabel ?? `Close ${item.label} tab`}
                            >
                              <Icon name="close" className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span className={cn(equalWidthFileTabs ? 'tab-label-ombre flex-1 min-w-0' : 'truncate', 'leading-[1.2]')}>{item.label}</span>
                    </span>
                  )}
                </button>
                {closable && !closeReplacesIcon ? (
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose?.(item.id);
                    }}
                    className={cn(
                      'relative z-20 inline-flex !min-h-0 !min-w-0 items-center justify-center transition-opacity',
                      equalWidthFileTabs && 'flex-none',
                      usesActivePillIndicator
                        ? '-ml-2.5 mr-1 h-[88%] w-5 self-center !aspect-auto rounded-md'
                        : 'aspect-square h-[65%] min-h-4 max-h-5 rounded-sm mr-1',
                      usesActivePillIndicator
                        ? (isActive
                          ? 'text-muted-foreground hover:bg-transparent hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-transparent hover:text-foreground group-hover:opacity-100')
                        : (isActive
                          ? 'text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-interactive-hover/80 hover:text-foreground group-hover:opacity-100')
                    )}
                    aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                    title={item.closeLabel ?? `Close ${item.label} tab`}
                  >
                    <Icon name="close" className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            </Wrapper>
          );
        })}
      </div>
    </>
  );

  const list = (
    <div className={cn('relative flex h-full min-w-0 flex-1', className)}>
      {pinFirst ? (
        <div
          className="relative flex h-full min-w-0 flex-1"
          role="tablist"
          aria-label={t('sortableTabsStrip.aria.tabs')}
        >
          {tabRegion}
        </div>
      ) : (
        tabRegion
      )}
      {showScrollButtons && isScrollable && hasOverflow ? (
        <div
          className="flex h-full shrink-0 items-center justify-end gap-0.5 pl-1"
          style={{ width: SCROLL_RAIL_WIDTH }}
        >
          <button
            type="button"
            onClick={() => handleScrollButton('left')}
            disabled={!overflow.left}
            aria-label={t('sortableTabsStrip.aria.scrollLeft')}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:bg-interactive-hover/60 hover:text-foreground',
              'disabled:pointer-events-none disabled:opacity-40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]'
            )}
          >
            <Icon name="arrow-left-s" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => handleScrollButton('right')}
            disabled={!overflow.right}
            aria-label={t('sortableTabsStrip.aria.scrollRight')}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:bg-interactive-hover/60 hover:text-foreground',
              'disabled:pointer-events-none disabled:opacity-40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]'
            )}
          >
            <Icon name="arrow-right-s" className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );

  if (!reorderEnabled) {
    return list;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToXAxis]}
    >
      <SortableContext items={itemIDs} strategy={horizontalListSortingStrategy}>
        {list}
      </SortableContext>
      <DragOverlay dropAnimation={null} />
    </DndContext>
  );
};
