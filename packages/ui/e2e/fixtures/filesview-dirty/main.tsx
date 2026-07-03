import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { FilesView } from '@/components/views/FilesView';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';

/**
 * Real-Chromium fixture that mounts the ACTUAL FilesView ('full' mode) with real text files, so
 * the isDirty / confirm-discard behavior is exercised through the production load path,
 * CodeMirror editor, dirty comparison, and handleSelectFile guard. Only the IO boundary is mocked
 * (files.readFile/statFile/writeFile/listDirectory); every module under src/ is the real code.
 *
 * writeFile must be present so canEdit is true and CodeMirror mounts (a missing writeFile falls
 * back to the read-only Shiki view). statFile must return isFile:true or the open-paths poll
 * removes the tab.
 */

const ROOT_DIR = '/workspace';

const FILES: Record<string, string> = {
    '/workspace/lf-no-newline.txt': 'line one\nline two\nline three',
    '/workspace/crlf-trailing-newline.txt': 'alpha\r\nbeta\r\ngamma\r\n',
    '/workspace/switch-target.txt': 'target one\ntarget two\n',
};

const ENTRIES = Object.keys(FILES).map((path) => ({
    name: path.slice(ROOT_DIR.length + 1),
    path,
    isDirectory: false,
}));

const statFor = (path: string) => ({
    path,
    size: FILES[path]?.length ?? 0,
    mtimeMs: 1_000,
    isFile: true,
});

type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
const apis = {
    files: {
        readFile: (path: string) => Promise.resolve({ content: FILES[path] ?? '', path }),
        statFile: (path: string) => Promise.resolve(statFor(path)),
        writeFile: (path: string, content: string) => {
            FILES[path] = content;
            return Promise.resolve({ success: true });
        },
        listDirectory: (dir: string) =>
            Promise.resolve({ entries: dir === ROOT_DIR ? ENTRIES : [] }),
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
        __filesViewReady?: boolean;
    }
}

const params = new URLSearchParams(window.location.search);
const START_PATH = params.get('file') ?? '/workspace/lf-no-newline.txt';
const SECOND_PATH = params.get('second') ?? '/workspace/switch-target.txt';

useDirectoryStore.setState({ currentDirectory: ROOT_DIR });
useFilesViewTabsStore.getState().addOpenPath(ROOT_DIR, START_PATH);
useFilesViewTabsStore.getState().addOpenPath(ROOT_DIR, SECOND_PATH);
useFilesViewTabsStore.getState().setSelectedPath(ROOT_DIR, START_PATH);

const Harness: React.FC = () => {
    React.useEffect(() => {
        window.__filesViewReady = true;
        return () => {
            window.__filesViewReady = false;
        };
    }, []);

    return <FilesView mode="full" />;
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
