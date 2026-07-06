import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';
import { DiagramPanZoomViewport } from '@/components/chat/message/DiagramPanZoomViewport';

/**
 * Real fullscreen render-path harness. Mounts the EXACT composition MermaidPreviewDialog uses
 * (ToolOutputDialog.tsx:803-814): a real DiagramPanZoomViewport wrapping a real
 * SimpleMarkdownRenderer with the markdown-{kind}-fullscreen class, inside the app-boundary
 * providers the renderer depends on. `__setDiagram(kind, source)` drives a real ```mermaid or
 * ```plantuml fence through the real decorate.ts -> mermaid/@plantuml/core render + the real
 * applyDiagramHostBodyScale. NOTHING under src/ is mocked.
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

const MERMAID_CONTROLS = { download: false, copy: false, fullscreen: false, panZoom: true } as const;

type DiagramKind = 'mermaid' | 'plantuml';

declare global {
    interface Window {
        __setDiagram?: (kind: DiagramKind, source: string) => void;
        __ready?: boolean;
    }
}

const Harness: React.FC = () => {
    const [state, setState] = React.useState<{ kind: DiagramKind; source: string } | null>(null);

    React.useEffect(() => {
        window.__setDiagram = (kind, source) => setState({ kind, source });
        window.__ready = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-fs-status', 'ready');
        return () => {
            window.__ready = false;
            delete window.__setDiagram;
        };
    }, []);

    if (!state) return null;

    const { kind, source } = state;
    const fence = kind === 'plantuml' ? 'plantuml' : 'mermaid';
    const markdown = '```' + fence + '\n' + source + '\n```';
    const className =
        kind === 'plantuml'
            ? "markdown-plantuml-fullscreen [&_[data-markdown='plantuml-block']_button]:hidden"
            : "markdown-mermaid-fullscreen [&_[data-markdown='mermaid-block']_button]:hidden";

    return (
        <div id="viewport-host">
            <DiagramPanZoomViewport resetKey={`${kind}:${source}`} data-testid="diagram-panzoom">
                <SimpleMarkdownRenderer
                    content={markdown}
                    variant="tool"
                    allowMermaidWheelZoom
                    className={className}
                    mermaidControls={kind === 'plantuml' ? undefined : MERMAID_CONTROLS}
                    enableFileReferences={false}
                />
            </DiagramPanZoomViewport>
        </div>
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
