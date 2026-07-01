import React from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ChatView } from '@/components/views/ChatView';
import { FilesView } from '@/components/views/FilesView';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

const CHAT_TAB_ID = 'chat';
const EMPTY_PATHS: string[] = [];

const MemoizedChatView = React.memo(ChatView);

const toFileName = (path: string): string => {
  const segments = path.split('/');
  return segments[segments.length - 1] || path;
};

const toRelativePath = (path: string, root: string): string => {
  if (root && path === root) {
    return toFileName(path);
  }
  if (root && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1);
  }
  return path;
};

export const SessionViewWrapper: React.FC = () => {
  const { t } = useI18n();
  const root = useEffectiveDirectory();
  const rootKey = root ?? '';

  const openPaths = useFilesViewTabsStore((s) =>
    rootKey ? (s.byRoot[rootKey]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS,
  );
  const selectedPath = useFilesViewTabsStore((s) =>
    rootKey ? (s.byRoot[rootKey]?.selectedPath ?? null) : null,
  );
  const closeSessionFileTab = useUIStore((s) => s.closeSessionFileTab);
  const setActiveSessionFileTabId = useUIStore((s) => s.setActiveSessionFileTabId);

  const [activeTabId, setActiveTabId] = React.useState<string>(CHAT_TAB_ID);

  React.useEffect(() => {
    if (selectedPath) {
      setActiveTabId((prev) => (selectedPath !== prev ? selectedPath : prev));
    }
  }, [selectedPath]);

  React.useEffect(() => {
    if (activeTabId !== CHAT_TAB_ID && !openPaths.includes(activeTabId)) {
      setActiveTabId(CHAT_TAB_ID);
    }
  }, [openPaths, activeTabId]);

  const handleSelect = React.useCallback(
    (id: string) => {
      setActiveTabId(id);
      setActiveSessionFileTabId(rootKey, id);
    },
    [rootKey, setActiveSessionFileTabId],
  );

  const handleClose = React.useCallback(
    (id: string) => {
      closeSessionFileTab(rootKey, id);
    },
    [rootKey, closeSessionFileTab],
  );

  const items = React.useMemo<SortableTabsStripItem[]>(() => {
    const fileTabs: SortableTabsStripItem[] = openPaths.map((path) => ({
      id: path,
      label: toFileName(path),
      title: toRelativePath(path, rootKey),
      closable: true,
      closeLabel: t('sessionTabs.closeFile', { name: toFileName(path) }),
      icon: <FileTypeIcon filePath={path} className="h-4 w-4" />,
    }));
    return [
      { id: CHAT_TAB_ID, label: t('sessionTabs.chat'), closable: false },
      ...fileTabs,
    ];
  }, [openPaths, rootKey, t]);

  if (openPaths.length === 0) {
    return <MemoizedChatView />;
  }

  const isChatActive = activeTabId === CHAT_TAB_ID;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-stretch border-b border-border px-2">
        <SortableTabsStrip
          items={items}
          activeId={activeTabId}
          onSelect={handleSelect}
          onClose={handleClose}
          layoutMode="scrollable"
          variant="default"
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={cn('absolute inset-0', !isChatActive && 'invisible pointer-events-none')}>
          <MemoizedChatView />
        </div>
        <div className={cn('absolute inset-0', isChatActive && 'invisible pointer-events-none')}>
          <FilesView mode="editor-only" />
        </div>
      </div>
    </div>
  );
};
