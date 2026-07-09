import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { McpIcon } from '@/components/icons/McpIcon';
import type { SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useI18n } from '@/lib/i18n';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import {
  getAllModelFamilies,
  groupModelsByFamily,
  sortModelFamilies,
} from '@/lib/quota/model-families';
import { updateDesktopSettings } from '@/lib/persistence';
import type { UsageWindow } from '@/types';

export interface RateLimitGroup {
  providerId: string;
  providerName: string;
  entries: Array<[string, UsageWindow]>;
  error?: string;
  modelFamilies?: Array<{
    familyId: string | null;
    familyLabel: string;
    models: Array<[string, UsageWindow]>;
  }>;
}

export interface UseServicesMenuModelOptions {
  isDesktopApp: boolean;
}

export interface ServicesMenuModel {
  servicesTabs: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: React.ReactNode }>;
  servicesTabItems: SortableTabsStripItem[];
  quotaDisplayTabItems: SortableTabsStripItem[];
  rateLimitGroups: RateLimitGroup[];
  hasRateLimits: boolean;
  expandedFamilies: Record<string, string[]>;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  handleDisplayModeChange: (mode: 'usage' | 'remaining') => Promise<void>;
  handleUsageRefresh: () => void;
  isUsageRefreshSpinning: boolean;
}

export function useServicesMenuModel({ isDesktopApp }: UseServicesMenuModelOptions): ServicesMenuModel {
  const { t } = useI18n();

  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const expandedFamilies = useQuotaStore((state) => state.expandedFamilies);
  const toggleFamilyExpanded = useQuotaStore((state) => state.toggleFamilyExpanded);
  const quotaResults = useQuotaStore((state) => state.results);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const setQuotaDisplayMode = useQuotaStore((state) => state.setDisplayMode);

  const [isUsageRefreshSpinning, setIsUsageRefreshSpinning] = React.useState(false);

  const rateLimitGroups = React.useMemo(() => {
    const groups: RateLimitGroup[] = [];

    for (const provider of QUOTA_PROVIDERS) {
      if (!dropdownProviderIds.includes(provider.id)) {
        continue;
      }
      const result = quotaResults.find((entry) => entry.providerId === provider.id);
      const windows = (result?.usage?.windows ?? {}) as Record<string, UsageWindow>;
      const models = result?.usage?.models;
      const entries = Object.entries(windows);

      const group: RateLimitGroup = {
        providerId: provider.id,
        providerName: provider.name,
        entries,
        error: (result && !result.ok && result.configured) ? result.error : undefined,
      };

      // Add model families if provider has per-model quotas
      if (models && Object.keys(models).length > 0) {
        const providerSelectedModels = selectedModels[provider.id] ?? [];
        // hasExplicitSelection = true means user has selected specific models to show
        // If the array exists but is empty, treat as "show all" (user cleared selection)
        const hasExplicitSelection = providerSelectedModels.length > 0;
        const modelGroups = groupModelsByFamily(models, provider.id);
        const families = getAllModelFamilies(provider.id);
        const sortedFamilies = sortModelFamilies(families);

        group.modelFamilies = [];

        // Add predefined families first
        for (const family of sortedFamilies) {
          const modelNames = modelGroups.get(family.id) ?? [];
          if (modelNames.length === 0) continue;

          // Filter to selected models only, OR show all if nothing selected
          const selectedModelNames = hasExplicitSelection
            ? modelNames.filter((m: string) => providerSelectedModels.includes(m))
            : modelNames;
          if (selectedModelNames.length === 0) continue;

          const familyModels: Array<[string, UsageWindow]> = [];
          for (const modelName of selectedModelNames) {
            const modelUsage = models[modelName] as { windows?: Record<string, UsageWindow> } | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                familyModels.push([modelName, windowEntries[0][1]]);
              }
            }
          }

          if (familyModels.length > 0) {
            group.modelFamilies.push({
              familyId: family.id,
              familyLabel: family.label,
              models: familyModels,
            });
          }
        }

        // Add "Other" family for remaining models
        const otherModelNames = modelGroups.get(null) ?? [];
        const selectedOtherModels = hasExplicitSelection
          ? otherModelNames.filter((m: string) => providerSelectedModels.includes(m))
          : otherModelNames;
        if (selectedOtherModels.length > 0) {
          const otherModels: Array<[string, UsageWindow]> = [];
          for (const modelName of selectedOtherModels) {
            const modelUsage = models[modelName] as { windows?: Record<string, UsageWindow> } | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                otherModels.push([modelName, windowEntries[0][1]]);
              }
            }
          }
          if (otherModels.length > 0) {
            group.modelFamilies.push({
              familyId: null,
              familyLabel: t('header.services.modelFamily.other'),
              models: otherModels,
            });
          }
        }
      }

      if (entries.length > 0 || (group.modelFamilies && group.modelFamilies.length > 0) || group.error) {
        groups.push(group);
      }
    }

    return groups;
  }, [dropdownProviderIds, quotaResults, selectedModels, t]);
  const hasRateLimits = rateLimitGroups.length > 0;

  const handleDisplayModeChange = React.useCallback(async (mode: 'usage' | 'remaining') => {
    setQuotaDisplayMode(mode);
    try {
      await updateDesktopSettings({ usageDisplayMode: mode });
    } catch (error) {
      console.warn('Failed to update usage display mode:', error);
    }
  }, [setQuotaDisplayMode]);

  const handleUsageRefresh = React.useCallback(() => {
    if (isUsageRefreshSpinning) return;
    setIsUsageRefreshSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([fetchAllQuotas(), minSpinPromise]).finally(() => {
      setIsUsageRefreshSpinning(false);
    });
  }, [fetchAllQuotas, isUsageRefreshSpinning]);

  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: React.ReactNode }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: t('layout.services.instance'), icon: <Icon name="server" className="h-3.5 w-3.5" /> });
    }
    base.push(
      { value: 'usage', label: t('layout.services.usage'), icon: <Icon name="timer" className="h-3.5 w-3.5" /> },
      { value: 'mcp', label: 'MCP', icon: <McpIcon className="h-3.5 w-3.5" /> }
    );
    return base;
  }, [isDesktopApp, t]);

  const servicesTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return servicesTabs.map((tab) => ({
      id: tab.value,
      label: tab.label,
      icon: tab.icon,
    }));
  }, [servicesTabs]);

  const quotaDisplayTabs = React.useMemo(() => {
    return [
      { value: 'usage' as const, label: t('header.services.used') },
      { value: 'remaining' as const, label: t('header.services.remaining') },
    ];
  }, [t]);

  const quotaDisplayTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return quotaDisplayTabs.map((tab) => ({ id: tab.value, label: tab.label }));
  }, [quotaDisplayTabs]);

  return {
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
  };
}
