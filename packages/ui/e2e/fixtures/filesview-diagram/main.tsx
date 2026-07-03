import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { FilesView } from '@/components/views/FilesView';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Real-Chromium fixture that mounts the ACTUAL FilesView component with a markdown file open in
 * preview mode, so the e2e exercises FilesView's OWN onShowPopup wiring (both preview sites
 * sharing one useDiagramPopup instance + one popupElement) — not a standalone hook harness.
 *
 * Only the IO boundary is mocked: files.readFile returns the markdown text, files.listDirectory
 * returns an empty tree. Every internal module — FilesView, SimpleMarkdownRenderer,
 * useDiagramPopup, ToolOutputDialog, and all stores — is the REAL production code. Selection and
 * preview mode are established by presetting the real stores + localStorage the same way the app
 * does at runtime (no internal mocks).
 */

const ROOT_DIR = '/workspace';
const DOC_PATH = '/workspace/diagrams.md';

const MARKDOWN = [
    '# Diagram document',
    '',
    '```mermaid',
    'graph TD',
    '  A[Start] --> B[Middle]',
    '  B --> C[End]',
    '```',
    '',
    '```plantuml',
    '@startuml',
    'AlphaOne -> BetaTwo : ping',
    '@enduml',
    '```',
    '',
].join('\n');

type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
const apis = {
    files: {
        readFile: (path: string) => Promise.resolve({ content: MARKDOWN, path }),
        listDirectory: () => Promise.resolve({ entries: [] }),
    },
    editor: {},
    runtime: { isVSCode: false, isDesktop: false },
} as unknown as ProviderApis;

type ProviderSdk = React.ComponentProps<typeof SyncProvider>['sdk'];
const noopResult = () => Promise.resolve({ data: undefined, error: undefined });
const sdk = new Proxy(
    {},
    { get: () => new Proxy(noopResult, { get: () => noopResult }) },
) as unknown as ProviderSdk;

declare global {
    interface Window {
        __getImagePreviewOpen?: () => boolean;
        __filesViewReady?: boolean;
    }
}

// Establish the same runtime state the app sets when a markdown file is opened in preview mode:
// effective directory (fallback source), the open+selected tab, and the persisted md view mode.
try {
    localStorage.setItem('openchamber:files:md-viewer-mode', 'preview');
} catch {
    // ignore storage errors
}
useDirectoryStore.setState({ currentDirectory: ROOT_DIR });
useFilesViewTabsStore.getState().addOpenPath(ROOT_DIR, DOC_PATH);
useFilesViewTabsStore.getState().setSelectedPath(ROOT_DIR, DOC_PATH);

const Harness: React.FC = () => {
    React.useEffect(() => {
        window.__getImagePreviewOpen = () => useUIStore.getState().isImagePreviewOpen;
        window.__filesViewReady = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-filesview-status', 'ready');
        return () => {
            window.__filesViewReady = false;
            delete window.__getImagePreviewOpen;
        };
    }, []);

    return <FilesView mode="editor-only" />;
};

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
    <I18nProvider>
        <RuntimeAPIProvider apis={apis}>
            <ThemeSystemProvider>
                <SyncProvider sdk={sdk} directory="">
                    <Harness />
                </SyncProvider>
            </ThemeSystemProvider>
        </RuntimeAPIProvider>
    </I18nProvider>,
);
