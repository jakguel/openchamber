import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';
import ToolOutputDialog from '@/components/chat/message/ToolOutputDialog';
import type { ToolPopupContent } from '@/components/chat/message/types';

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

const CLOSED_POPUP: ToolPopupContent = { open: false, title: '', content: '' };

declare global {
    interface Window {
        __setMarkdown?: (markdown: string) => void;
        __parityReady?: boolean;
    }
}

const Harness: React.FC = () => {
    const [content, setContent] = React.useState('');
    const [popup, setPopup] = React.useState<ToolPopupContent>(CLOSED_POPUP);

    const onShowPopup = React.useCallback((next: ToolPopupContent) => {
        if (next.image || next.diagram) setPopup(next);
    }, []);
    const onOpenChange = React.useCallback(
        (open: boolean) => setPopup((prev) => ({ ...prev, open })),
        [],
    );

    React.useEffect(() => {
        window.__setMarkdown = (markdown: string) => setContent(markdown);
        window.__parityReady = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-parity-status', 'ready');
        return () => {
            window.__parityReady = false;
            delete window.__setMarkdown;
        };
    }, []);

    return (
        <>
            <SimpleMarkdownRenderer
                content={content}
                variant="assistant"
                onShowPopup={onShowPopup}
                enableFileReferences={false}
            />
            <ToolOutputDialog popup={popup} onOpenChange={onOpenChange} isMobile={false} />
        </>
    );
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
