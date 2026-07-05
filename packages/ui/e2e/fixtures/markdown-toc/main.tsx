import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { FilesView } from '@/components/views/FilesView';
import { MobileFilesSurface } from '@/apps/MobileFilesSurface';
import { MarkdownRenderer, SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';

const ROOT_DIR = '/workspace';

const filler = (label: string): string =>
    Array.from({ length: 10 }, (_, i) => `${label} filler line ${i + 1} — vertical space so headings spread across several viewport heights in the scroller.`).join('\n\n');

const NESTED = [
    '# Alpha',
    filler('Alpha'),
    '## Bravo',
    filler('Bravo'),
    '### Charlie',
    filler('Charlie'),
    '## Delta',
    filler('Delta'),
    '# Echo',
    filler('Echo'),
    '## Foxtrot',
    filler('Foxtrot'),
    '#### Golf',
    filler('Golf'),
].join('\n\n');

const FRONTMATTER = [
    '---',
    'title: Frontmatter Doc',
    'tags: alpha bravo',
    '---',
    '# After Front',
    filler('After'),
    '## Sub Front',
    filler('Sub'),
].join('\n');

const DUP = ['# Repeat', 'para one', '# Repeat', 'para two', '# Tail', 'para three'].join('\n\n');

const ZERO = ['Just a paragraph with no headings.', 'Another paragraph here.'].join('\n\n');

const JSON_DOC = '{\n  "name": "example",\n  "nested": { "value": 1 }\n}\n';

const DESKTOP_CONTENT: Record<string, { content: string; ext: string }> = {
    nested: { content: NESTED, ext: 'md' },
    frontmatter: { content: FRONTMATTER, ext: 'md' },
    zero: { content: ZERO, ext: 'md' },
    json: { content: JSON_DOC, ext: 'json' },
};

type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
type ProviderSdk = React.ComponentProps<typeof SyncProvider>['sdk'];

const noopResult = () => Promise.resolve({ data: undefined, error: undefined });
const sdk = new Proxy({}, { get: () => new Proxy(noopResult, { get: () => noopResult }) }) as unknown as ProviderSdk;

declare global {
    interface Window {
        __tocReady?: boolean;
        __mdSetPreview?: (markdown: string) => void;
    }
}

const params = new URLSearchParams(window.location.search);
const surface = params.get('surface') ?? 'desktop';

const markReady = (): void => {
    window.__tocReady = true;
    const root = document.getElementById('root');
    if (root) root.setAttribute('data-toc-status', 'ready');
};

const ReadySignal: React.FC = () => {
    React.useEffect(() => {
        markReady();
        return () => {
            window.__tocReady = false;
        };
    }, []);
    return null;
};

const buildDesktopApis = (docPath: string, content: string): ProviderApis =>
    ({
        files: {
            readFile: (path: string) => Promise.resolve({ content, path }),
            statFile: (path: string) => Promise.resolve({ path, size: content.length, mtimeMs: 1_000, isFile: true }),
            writeFile: () => Promise.resolve({ success: true }),
            listDirectory: (dir: string) =>
                Promise.resolve({ entries: dir === ROOT_DIR ? [{ name: docPath.slice(ROOT_DIR.length + 1), path: docPath, isDirectory: false }] : [] }),
        },
        editor: {},
        runtime: { isVSCode: false, isDesktop: false },
    }) as unknown as ProviderApis;

const buildMobileApis = (docPath: string, content: string): ProviderApis =>
    ({
        files: {
            readFile: (path: string) => Promise.resolve({ content, path }),
            listDirectory: (dir: string) =>
                Promise.resolve({ entries: dir === ROOT_DIR ? [{ name: docPath.slice(ROOT_DIR.length + 1), path: docPath, isDirectory: false }] : [] }),
            search: () => Promise.resolve([]),
        },
        editor: {},
        runtime: { isVSCode: false, isDesktop: false },
    }) as unknown as ProviderApis;

const emptyApis = { files: {}, editor: {}, runtime: { isVSCode: false } } as unknown as ProviderApis;

const withProviders = (apis: ProviderApis, node: React.ReactNode): React.ReactElement => (
    <I18nProvider>
        <RuntimeAPIProvider apis={apis}>
            <ThemeSystemProvider>
                <SyncProvider sdk={sdk} directory="">
                    {node}
                </SyncProvider>
            </ThemeSystemProvider>
        </RuntimeAPIProvider>
    </I18nProvider>
);

const DupHarness: React.FC = () => {
    const [content, setContent] = React.useState(DUP);
    React.useEffect(() => {
        window.__mdSetPreview = setContent;
        markReady();
        return () => {
            window.__tocReady = false;
            delete window.__mdSetPreview;
        };
    }, []);
    return (
        <div data-testid="preview-render" style={{ width: 760, padding: 24 }}>
            <SimpleMarkdownRenderer content={content} enableFileReferences={false} injectHeadingIds />
        </div>
    );
};

const renderTree = (): React.ReactElement => {
    if (surface === 'mobile') {
        const docPath = `${ROOT_DIR}/nested.md`;
        useDirectoryStore.setState({ currentDirectory: ROOT_DIR });
        return withProviders(
            buildMobileApis(docPath, NESTED),
            <>
                <div style={{ width: 390, height: '100vh' }}>
                    <MobileFilesSurface />
                </div>
                <ReadySignal />
            </>,
        );
    }

    if (surface === 'byteid') {
        return withProviders(
            emptyApis,
            <>
                <div data-testid="chat-render" style={{ width: 760, padding: 24 }}>
                    <MarkdownRenderer content={NESTED} messageId="chat-1" variant="assistant" isStreaming={false} skipFadeIn enableFileReferences={false} />
                </div>
                <div data-testid="preview-render" style={{ width: 760, padding: 24 }}>
                    <SimpleMarkdownRenderer content={NESTED} enableFileReferences={false} injectHeadingIds />
                </div>
                <ReadySignal />
            </>,
        );
    }

    if (surface === 'dup') {
        return withProviders(emptyApis, <DupHarness />);
    }

    const fileParam = params.get('file') ?? 'nested';
    const spec = DESKTOP_CONTENT[fileParam] ?? DESKTOP_CONTENT.nested!;
    const docPath = `${ROOT_DIR}/${fileParam}.${spec.ext}`;
    try {
        localStorage.setItem('openchamber:files:md-viewer-mode', 'preview');
    } catch {
        // ignore storage errors
    }
    useDirectoryStore.setState({ currentDirectory: ROOT_DIR });
    useFilesViewTabsStore.getState().addOpenPath(ROOT_DIR, docPath);
    useFilesViewTabsStore.getState().setSelectedPath(ROOT_DIR, docPath);
    return withProviders(
        buildDesktopApis(docPath, spec.content),
        <>
            <FilesView mode="full" />
            <ReadySignal />
        </>,
    );
};

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(renderTree());
