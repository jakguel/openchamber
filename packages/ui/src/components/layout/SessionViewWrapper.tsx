import React from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ChatView } from '@/components/views/ChatView';
import { FilesView, type FilesViewRef } from '@/components/views/FilesView';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

const CHAT_TAB_ID = 'chat';

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

  const sessionFileTabs = useUIStore((s) => s.sessionFileTabs);
  const activeSessionFileTabId = useUIStore((s) => s.activeSessionFileTabId);
  const closeSessionFileTab = useUIStore((s) => s.closeSessionFileTab);
  const setActiveSessionFileTabId = useUIStore((s) => s.setActiveSessionFileTabId);

  const filesViewRef = React.useRef<FilesViewRef>(null);

  const handleSelect = React.useCallback(
    (id: string) => {
      setActiveSessionFileTabId(rootKey, id);
    },
    [rootKey, setActiveSessionFileTabId],
  );

  const handleClose = React.useCallback(
    (id: string) => {
      // Route through FilesView so the unsaved-changes guard can fire.
      // FilesView calls onFileClose after the close is confirmed, which
      // removes the session-scoped tab.
      filesViewRef.current?.closeFile(id);
    },
    [],
  );

  const items = React.useMemo<SortableTabsStripItem[]>(() => {
    const fileTabs: SortableTabsStripItem[] = sessionFileTabs.map((path) => ({
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
  }, [sessionFileTabs, rootKey, t]);

  if (sessionFileTabs.length === 0) {
    return <MemoizedChatView />;
  }

  const isChatActive = activeSessionFileTabId === CHAT_TAB_ID;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-stretch border-b border-border px-2">
        <SortableTabsStrip
          items={items}
          activeId={activeSessionFileTabId}
          onSelect={handleSelect}
          onClose={handleClose}
          layoutMode="scrollable"
          variant="default"
          pinFirstTab={true}
          showScrollButtons={true}
          equalTabWidth={true}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={cn('absolute inset-0', !isChatActive && 'invisible pointer-events-none')}>
          <MemoizedChatView />
        </div>
        <div className={cn('absolute inset-0', isChatActive && 'invisible pointer-events-none')}>
          <FilesView
            ref={filesViewRef}
            mode="editor-only"
            onFileClose={(path) => closeSessionFileTab(rootKey, path)}
          />
        </div>
      </div>
    </div>
  );
};
