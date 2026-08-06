import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

// Real-Chromium fixture for usePacedText. It mounts the REAL chat
// MarkdownRenderer (which internally calls usePacedText, gated by
// live = isStreaming && !disableStreamAnimation) and exposes controls so the
// e2e can drive genuine mounts/rerenders/timer ticks. NOTHING under src/ is
// mocked; only app-boundary providers are injected, exactly like the
// diagram-popup-hook / markdown-toc fixtures. `key={mountKey}` lets the test
// force a fresh mount with content ALREADY present (the session-switch replay
// case), which is what the seed fix targets.

type ProviderApis = React.ComponentProps<typeof RuntimeAPIProvider>['apis'];
const apis = { files: {}, editor: {}, runtime: { isVSCode: false } } as unknown as ProviderApis;

type ProviderSdk = React.ComponentProps<typeof SyncProvider>['sdk'];
const noopResult = () => Promise.resolve({ data: undefined, error: undefined });
const sdk = new Proxy(
    {},
    { get: () => new Proxy(noopResult, { get: () => noopResult }) },
) as unknown as ProviderSdk;

declare global {
    interface Window {
        __ready?: boolean;
        __setContent?: (s: string) => void;
        __setStreaming?: (b: boolean) => void;
        __setDisableAnim?: (b: boolean) => void;
        __setMounted?: (b: boolean) => void;
        __remountWith?: (content: string, streaming: boolean) => void;
    }
}

const Harness: React.FC = () => {
    const [content, setContent] = React.useState('');
    const [streaming, setStreaming] = React.useState(true);
    const [disableAnim, setDisableAnim] = React.useState(false);
    const [mounted, setMounted] = React.useState(true);
    const [mountKey, setMountKey] = React.useState(0);

    React.useEffect(() => {
        window.__setContent = (s) => setContent(s);
        window.__setStreaming = (b) => setStreaming(b);
        window.__setDisableAnim = (b) => setDisableAnim(b);
        window.__setMounted = (b) => setMounted(b);
        window.__remountWith = (c, s) => {
            setContent(c);
            setStreaming(s);
            setDisableAnim(false);
            setMounted(true);
            setMountKey((k) => k + 1);
        };
        window.__ready = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-harness-status', 'ready');
        return () => {
            window.__ready = false;
            delete window.__setContent;
            delete window.__setStreaming;
            delete window.__setDisableAnim;
            delete window.__setMounted;
            delete window.__remountWith;
        };
    }, []);

    if (!mounted) {
        return <div data-harness-unmounted="true" />;
    }

    return (
        <MarkdownRenderer
            key={mountKey}
            content={content}
            messageId="paced-msg"
            variant="assistant"
            isStreaming={streaming}
            disableStreamAnimation={disableAnim}
            isAnimated={false}
            enableFileReferences={false}
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
