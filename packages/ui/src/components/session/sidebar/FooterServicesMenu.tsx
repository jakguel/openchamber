import React, { useEffect } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Icon } from '@/components/icon/Icon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';

import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  formatQuotaValueLabel,
  formatQuotaResetLabel,
  formatWindowLabel,
  calculatePace,
  calculateExpectedUsagePercent,
} from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  isDesktopLocalOriginActive,
  isDesktopShell,
  isVSCodeRuntime,
} from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { forceKillTerminal } from '@/lib/terminalApi';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useServicesMenuModel } from '@/components/layout/useServicesMenuModel';

type ServicesTab = 'instance' | 'usage' | 'mcp';

const footerButtonClassName = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

const formatTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

/**
 * Self-contained, memoized Services (provider usage/consumption) menu for the
 * left-nav SidebarFooter. Owns its own open/tab state and useQuotaStore LEAF
 * selectors internally so mounting it in the footer does not fan quota churn out
 * to the session list. The popup opens ABOVE the cloud trigger, pinned to the
 * viewport left edge (x~0) via a virtual left-edge anchor + portalToBody.
 *
 * Relocated from Header.tsx's DesktopServicesMenu.
 */
export const FooterServicesMenu = React.memo(function FooterServicesMenu(): React.ReactNode {
  const { t } = useI18n();

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const [isOpen, setIsOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<ServicesTab>(isDesktopApp ? 'instance' : 'usage');
  useEffect(() => {
    if (!isDesktopApp && activeTab === 'instance') {
      setActiveTab('usage');
    }
  }, [activeTab, isDesktopApp]);

  // Quota leaf selectors (kept inside this memoized component).
  const quotaResults = useQuotaStore((state) => state.results);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const showPredValues = useQuotaStore((state) => state.showPredValues);

  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  const {
    servicesTabs,
    servicesTabItems,
    quotaDisplayTabItems,
    rateLimitGroups,
    hasRateLimits,
    expandedFamilies,
    toggleFamilyExpanded,
    handleDisplayModeChange,
    handleUsageRefresh,
    isUsageRefreshSpinning,
  } = useServicesMenuModel({ isDesktopApp });

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  // --- Instance label (Electron remote/local) -------------------------------
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      if (isDesktopLocalOriginActive()) {
        setCurrentInstanceLabel('Local');
        return;
      }

      const cfg = await desktopHostsGet();
      const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
      const runtimeApiBaseUrl = getRuntimeApiBaseUrl();

      if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
        setCurrentInstanceLabel('Local');
        return;
      }

      const match = cfg.hosts.find((host) => {
        return runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false;
      });

      if (match?.label?.trim()) {
        setCurrentInstanceLabel(redactSensitiveUrl(match.label.trim()));
        return;
      }

      setCurrentInstanceLabel('Instance');
    } catch {
      setCurrentInstanceLabel('Local');
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
  }, [refreshCurrentInstanceLabel]);

  // --- Dev shutdown (web localhost only) ------------------------------------
  const [isDevShutdownInFlight, setIsDevShutdownInFlight] = React.useState(false);
  const showDevShutdown = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (isDesktopApp) return false;
    if (isVSCode) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }, [isDesktopApp, isVSCode]);

  const handleDevShutdown = React.useCallback(async () => {
    if (isDevShutdownInFlight) return;
    setIsDevShutdownInFlight(true);
    setIsOpen(false);

    const previewUrls: string[] = [];
    let shutdownRequested = false;
    try {
      try {
        for (const [, dirState] of useTerminalStore.getState().sessions.entries()) {
          for (const tab of dirState.tabs) {
            if (tab.previewUrl) {
              previewUrls.push(tab.previewUrl);
            }
          }
        }
      } catch (err) {
        console.warn(
          '[FooterServicesMenu] dev-shutdown: collecting terminal preview URLs failed (best-effort, continuing)',
          err,
        );
      }

      try {
        await forceKillTerminal({});
      } catch (err) {
        console.warn(
          '[FooterServicesMenu] dev-shutdown: forceKillTerminal failed (best-effort, continuing)',
          err,
        );
      }

      try {
        const devRes = await runtimeFetch('/api/system/dev-shutdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previewUrls }),
        });
        if (devRes.ok) {
          shutdownRequested = true;
        } else {
          const shutdownRes = await runtimeFetch('/api/system/shutdown', { method: 'POST' });
          shutdownRequested = shutdownRes.ok;
        }
      } catch (err) {
        console.warn(
          '[FooterServicesMenu] dev-shutdown: shutdown request (/api/system/dev-shutdown -> /api/system/shutdown) failed (best-effort, continuing)',
          err,
        );
      }
    } finally {
      if (!shutdownRequested) {
        setIsDevShutdownInFlight(false);
      }
    }
  }, [isDevShutdownInFlight]);

  // --- Left-edge virtual anchor (pins popup to viewport x~0, above trigger) --
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const leftEdgeAnchor = React.useMemo(() => ({
    getBoundingClientRect: (): DOMRect => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const top = rect ? rect.top : (typeof window !== 'undefined' ? window.innerHeight : 0);
      return {
        x: 0,
        y: top,
        width: 0,
        height: 0,
        top,
        left: 0,
        right: 0,
        bottom: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  }), []);

  // --- Services keyboard shortcuts (survive sidebar collapse) ----------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleServicesCombo = getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleServicesCombo)) {
        e.preventDefault();

        if (isOpen) {
          setIsOpen(false);
        } else {
          // Force the sidebar open so this footer-hosted trigger/popup is not
          // anchored against an aria-hidden / pointer-events-none subtree.
          useUIStore.getState().setSidebarOpen(true);
          setIsOpen(true);
          void refreshCurrentInstanceLabel();
          if (activeTab === 'usage' && quotaResults.length === 0) {
            void fetchAllQuotas();
          }
        }
        return;
      }

      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();

        const tabValues = servicesTabs.map((tab) => tab.value);
        if (tabValues.length === 0) {
          return;
        }

        const currentIndex = tabValues.indexOf(activeTab);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabValues.length;
        const nextTab = tabValues[nextIndex];
        useUIStore.getState().setSidebarOpen(true);
        setActiveTab(nextTab);
        setIsOpen(true);
        void refreshCurrentInstanceLabel();
        if (nextTab === 'usage' && quotaResults.length === 0) {
          void fetchAllQuotas();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    isOpen,
    activeTab,
    servicesTabs,
    quotaResults.length,
    fetchAllQuotas,
    refreshCurrentInstanceLabel,
  ]);

  return (
    <>
      <DropdownMenu
        open={isOpen}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (open) {
            void refreshCurrentInstanceLabel();
            if (activeTab === 'usage' && quotaResults.length === 0) {
              void fetchAllQuotas();
            }
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={isDesktopApp
                  ? t('header.services.openWithCurrent', { current: currentInstanceLabel })
                  : t('header.services.open')}
                className={footerButtonClassName}
              >
                <Icon name="cloud" className="h-4.5 w-4.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <p>
              {isDesktopApp
                ? t('header.services.tooltip.currentInstanceWithShortcuts', {
                    current: currentInstanceLabel,
                    toggle: shortcutLabel('toggle_services_menu'),
                    nextTab: shortcutLabel('cycle_services_tab'),
                  })
                : t('header.services.tooltip.servicesWithShortcuts', {
                    toggle: shortcutLabel('toggle_services_menu'),
                    nextTab: shortcutLabel('cycle_services_tab'),
                  })}
            </p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="start"
          anchor={leftEdgeAnchor}
          portalToBody
          className="w-[min(27rem,calc(100vw-2rem))] max-h-[min(var(--available-height,75vh),75vh)] overflow-y-auto bg-[var(--surface-elevated)] p-0"
        >
          <div className="sticky top-0 z-20 px-2 pt-1.5 pb-px">
            <div className="h-9">
              <SortableTabsStrip
                items={servicesTabItems}
                activeId={activeTab}
                onSelect={(tabID) => {
                  const value = tabID as ServicesTab;
                  setActiveTab(value);
                  if (value === 'usage' && quotaResults.length === 0) {
                    void fetchAllQuotas();
                  }
                }}
                layoutMode="fit"
                variant="active-pill"
                activePillInsetClassName="gap-0.5 px-px py-0"
                activePillButtonClassName="h-8"
                className="h-full"
              />
            </div>
          </div>

          {isDesktopApp && activeTab === 'instance' ? (
            <div>
              <DesktopHostSwitcherDialog
                embedded
                open={isOpen && activeTab === 'instance'}
                onOpenChange={() => {}}
                onHostSwitched={() => setIsOpen(false)}
              />
            </div>
          ) : null}

          {activeTab === 'mcp' ? (
            <McpDropdownContent active={isOpen && activeTab === 'mcp'} />
          ) : null}

          {activeTab === 'usage' ? (
            <div className="overflow-x-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--interactive-border)] px-4 py-2.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="typography-ui-header font-semibold text-foreground">{t('header.services.rateLimits')}</span>
                  <span className="truncate typography-micro text-muted-foreground">{formatTime(quotaLastUpdated, timeFormatPreference)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-7 w-[10.5rem]">
                    <SortableTabsStrip
                      items={quotaDisplayTabItems}
                      activeId={quotaDisplayMode}
                      onSelect={(tabID) => void handleDisplayModeChange(tabID as 'usage' | 'remaining')}
                      layoutMode="fit"
                      variant="active-pill"
                      activePillInsetClassName="gap-0.5 px-px py-0"
                      className="h-full"
                    />
                  </div>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                      'hover:text-foreground hover:bg-interactive-hover',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                    )}
                    onClick={handleUsageRefresh}
                    disabled={isQuotaLoading || isUsageRefreshSpinning}
                    aria-label={t('header.services.refreshRateLimitsAria')}
                  >
                    <Icon name="refresh" className={cn('h-4 w-4', isUsageRefreshSpinning && 'animate-spin')} />
                  </button>
                </div>
              </div>

              {!hasRateLimits ? (
                <div className="px-4 py-5 text-center">
                  <span className="typography-ui-label text-muted-foreground">{t('header.services.noRateLimits')}</span>
                </div>
              ) : null}

              <div className="py-2">
                {rateLimitGroups.map((group, index) => {
                  const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];
                  return (
                    <React.Fragment key={group.providerId}>
                      {index > 0 ? <div className="mx-4 my-2 border-t border-[var(--interactive-border)]" /> : null}
                      <div className="flex items-center gap-2 px-4 py-2">
                        <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                        <span className="typography-ui-label font-medium text-foreground">{group.providerName}</span>
                      </div>
                      {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                        <div className="px-4 pb-2">
                          <span className="typography-ui-label text-muted-foreground">{group.error ?? t('header.services.noRateLimitsReported')}</span>
                        </div>
                      ) : (
                        <div className="space-y-3 px-4 pb-2">
                          {group.entries.map(([label, window]) => {
                            const displayPercent = quotaDisplayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
                            const paceInfo = calculatePace(window.usedPercent, window.resetAt, window.windowSeconds, label);
                            const expectedMarker = paceInfo?.dailyAllocationPercent != null
                              ? (quotaDisplayMode === 'remaining'
                                  ? 100 - calculateExpectedUsagePercent(paceInfo.elapsedRatio)
                                  : calculateExpectedUsagePercent(paceInfo.elapsedRatio))
                              : null;
                            const metricLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
                            const resetLabel = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
                            return (
                              <div key={`${group.providerId}-${label}`} className="flex flex-col gap-1.5">
                                <div className="flex min-w-0 items-center justify-between gap-3">
                                  <div className="min-w-0 flex items-center gap-2">
                                    <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                    {resetLabel ? (
                                      <span className="truncate typography-micro text-muted-foreground">
                                        {resetLabel}
                                      </span>
                                    ) : null}
                                  </div>
                                  <span className="typography-ui-label tabular-nums text-foreground">
                                    {metricLabel === '-' ? '' : metricLabel}
                                  </span>
                                </div>
                                <UsageProgressBar
                                  percent={displayPercent}
                                  tonePercent={window.usedPercent}
                                  className="h-1.5"
                                  expectedMarkerPercent={expectedMarker}
                                />
                                {paceInfo && showPredValues ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
                              </div>
                            );
                          })}
                          {group.modelFamilies && group.modelFamilies.length > 0 ? (
                            <div className="space-y-0.5">
                              {group.modelFamilies.map((family) => {
                                const familyKey = family.familyId ?? 'other';
                                const isExpanded = providerExpandedFamilies.includes(familyKey);
                                return (
                                  <Collapsible
                                    key={familyKey}
                                    open={isExpanded}
                                    onOpenChange={() => toggleFamilyExpanded(group.providerId, familyKey)}
                                  >
                                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left hover:bg-[var(--interactive-hover)]/50 transition-colors">
                                      <span className="typography-ui-label font-medium text-foreground">{family.familyLabel}</span>
                                      {isExpanded ? <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" /> : <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />}
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                      <div className="space-y-2.5 pb-1 pl-1 pt-1">
                                        {family.models.map(([modelName, window]) => {
                                          const displayPercent = quotaDisplayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
                                          const paceInfo = calculatePace(window.usedPercent, window.resetAt, window.windowSeconds);
                                          const expectedMarker = paceInfo?.dailyAllocationPercent != null
                                            ? (quotaDisplayMode === 'remaining'
                                                ? 100 - calculateExpectedUsagePercent(paceInfo.elapsedRatio)
                                                : calculateExpectedUsagePercent(paceInfo.elapsedRatio))
                                            : null;
                                          const metricLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
                                          return (
                                            <div key={`${group.providerId}-${modelName}`} className="flex flex-col gap-1.5">
                                              <div className="flex min-w-0 items-center justify-between gap-3">
                                                <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                                <span className="typography-ui-label tabular-nums text-foreground">
                                                  {metricLabel === '-' ? '' : metricLabel}
                                                </span>
                                              </div>
                                              <UsageProgressBar
                                                percent={displayPercent}
                                                tonePercent={window.usedPercent}
                                                className="h-1.5"
                                                expectedMarkerPercent={expectedMarker}
                                              />
                                              {paceInfo && showPredValues ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </CollapsibleContent>
                                  </Collapsible>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ) : null}

          {showDevShutdown ? (
            <>
              <div className="mx-4 my-2 border-t border-[var(--interactive-border)]" />
              <div className="px-2 pb-2">
                <DropdownMenuItem
                  disabled={isDevShutdownInFlight}
                  onSelect={() => {
                    void handleDevShutdown();
                  }}
                >
                  {t('header.services.shutdownDev')}
                </DropdownMenuItem>
              </div>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
});
