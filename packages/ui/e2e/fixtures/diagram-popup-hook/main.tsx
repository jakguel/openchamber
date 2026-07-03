import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';
import { useDiagramPopup } from '@/components/chat/markdown/useDiagramPopup';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Real-Chromium fixture for the EXTRACTED useDiagramPopup() hook (task openchamber-f9d.22.6).
 *
 * This mounts a non-chat surface EXACTLY the way FilesView/MobileFilesSurface/PlanView/SkillsPage
 * wire it: one useDiagramPopup() instance whose onShowPopup is threaded into the REAL
 * SimpleMarkdownRenderer, and whose popupElement is rendered once. There is NO manual popup
 * state and NO manual hook invocation — the assertion drives the genuine
 * expand-button -> useMermaid/PlantumlInlineInteractions -> onShowPopup -> lazy ToolOutputDialog
 * path, so a regression in the hook (e.g. a no-op onShowPopup, or popupElement never mounting)
 * makes the e2e fail.
 *
 * NOTHING under src/ is mocked; only the app-boundary providers are injected, same as the
 * diagram-parity fixture.
 */

type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
const apis = {
    files: {},
    editor: {},
    runtime: { isVSCode: false },
} as unknown as ProviderApis;

type ProviderSdk = React.ComponentProps<typeof SyncProvider>['sdk'];
const noopResult = () => Promise.resolve({ data: undefined, error: undefined });
const sdk = new Proxy(
    {},
    { get: () => new Proxy(noopResult, { get: () => noopResult }) },
) as unknown as ProviderSdk;

declare global {
    interface Window {
        __setMarkdown?: (markdown: string) => void;
        __setSurfaceMounted?: (mounted: boolean) => void;
        __getImagePreviewOpen?: () => boolean;
        __hookReady?: boolean;
    }
}

/** A non-chat surface, wired identically to the 4 production surfaces. */
const DiagramSurface: React.FC<{ content: string }> = ({ content }) => {
    const { onShowPopup, popupElement } = useDiagramPopup();
    return (
        <>
            <SimpleMarkdownRenderer
                content={content}
                variant="assistant"
                onShowPopup={onShowPopup}
                enableFileReferences={false}
            />
            {popupElement}
        </>
    );
};

const Harness: React.FC = () => {
    const [content, setContent] = React.useState('');
    const [mounted, setMounted] = React.useState(true);

    React.useEffect(() => {
        window.__setMarkdown = (markdown: string) => setContent(markdown);
        window.__setSurfaceMounted = (next: boolean) => setMounted(next);
        window.__getImagePreviewOpen = () => useUIStore.getState().isImagePreviewOpen;
        window.__hookReady = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-hook-status', 'ready');
        return () => {
            window.__hookReady = false;
            delete window.__setMarkdown;
            delete window.__setSurfaceMounted;
            delete window.__getImagePreviewOpen;
        };
    }, []);

    if (!mounted) {
        return <div data-surface-unmounted="true" />;
    }
    return <DiagramSurface content={content} />;
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
