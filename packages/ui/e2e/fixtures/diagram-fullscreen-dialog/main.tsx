import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import ToolOutputDialog from '@/components/chat/message/ToolOutputDialog';
import type { ToolPopupContent } from '@/components/chat/message/types';

/**
 * Real fullscreen dialog harness. `__openDialog(kind, source)` drives the EXACT public dialog
 * path the app uses: the real exported ToolOutputDialog, which routes a `diagram` popup to
 * MermaidPreviewDialog — its top-right +/- zoom + close buttons, the real DiagramPanZoomViewport,
 * and a real ```mermaid / ```plantuml fence through the real decorate.ts -> mermaid/@plantuml/core
 * render, all inside the app-boundary providers the dialog depends on. Passing `source` inline
 * makes the dialog open straight to status='ready' (no fetch). NOTHING under src/ is mocked.
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

type DiagramKind = 'mermaid' | 'plantuml';

declare global {
    interface Window {
        __openDialog?: (kind: DiagramKind, source: string) => void;
        __ready?: boolean;
    }
}

const Harness: React.FC = () => {
    const [popup, setPopup] = React.useState<ToolPopupContent | null>(null);

    React.useEffect(() => {
        window.__openDialog = (kind, source) => {
            setPopup({
                open: true,
                title: 'diagram',
                content: source,
                diagram: {
                    kind,
                    url: `data:text/plain,${encodeURIComponent(source)}`,
                    source,
                },
            });
        };
        window.__ready = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-fs-status', 'ready');
        return () => {
            window.__ready = false;
            delete window.__openDialog;
        };
    }, []);

    if (!popup) return null;

    return (
        <ToolOutputDialog
            popup={popup}
            isMobile={false}
            onOpenChange={(open) => {
                if (!open) setPopup(null);
            }}
        />
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
