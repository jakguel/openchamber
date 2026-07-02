import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { SyncProvider } from '@/sync/sync-context';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';

/**
 * Real production pipeline harness. Mounts the REAL SimpleMarkdownRenderer inside the two
 * context providers it requires (I18nProvider for the diagram status labels; RuntimeAPIProvider
 * for useRuntimeAPIs). No SyncProvider is needed: file references are disabled and no session is
 * active, so the async plantuml render path (decorate -> queue -> engine) is exercised without
 * any sdk/session dependency. NOTHING under src/ is mocked — every module is the production one.
 *
 * The window control surface (__plSetMarkdown) drives the `content` prop so the e2e can render a
 * markdown string, swap it for the two-adjacent-blocks case, and fire rapid streaming edits to
 * prove latest-only backpressure — all through the real morphdom + decorate re-render path.
 */

// Minimal RuntimeAPIs: only editor/runtime shape is touched on the (file-references-disabled)
// markdown render path. Derive the exact prop type from the provider so this stays type-clean
// without hand-copying the interface.
type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
const apis = {
    files: {},
    editor: {},
    runtime: { isVSCode: false },
} as unknown as ProviderApis;

// SimpleMarkdownRenderer reads the effective directory through the sync system, so it must sit
// under a SyncProvider. No session is ever created here, so the plantuml render path issues no
// real sdk call; a no-op async client satisfies the provider's shape while any background
// bootstrap resolves harmlessly against the dev server. This injects a context at the app
// boundary (as the app does at startup) — it does NOT mock any module under src/.
type ProviderSdk = React.ComponentProps<typeof SyncProvider>['sdk'];
const noopResult = () => Promise.resolve({ data: undefined, error: undefined });
const sdk = new Proxy(
    {},
    { get: () => new Proxy(noopResult, { get: () => noopResult }) },
) as unknown as ProviderSdk;

declare global {
    interface Window {
        __plSetMarkdown?: (markdown: string) => void;
        __plReady?: boolean;
    }
}

const Harness: React.FC = () => {
    const [content, setContent] = React.useState('');
    React.useEffect(() => {
        window.__plSetMarkdown = (markdown: string) => setContent(markdown);
        window.__plReady = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-pl-status', 'ready');
        return () => {
            window.__plReady = false;
            delete window.__plSetMarkdown;
        };
    }, []);

    return React.createElement(SimpleMarkdownRenderer, {
        content,
        variant: 'assistant',
        enableFileReferences: false,
    });
};

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
    React.createElement(
        I18nProvider,
        null,
        React.createElement(
            RuntimeAPIProvider,
            { apis },
            React.createElement(SyncProvider, { sdk, directory: '' }, React.createElement(Harness)),
        ),
    ),
);
