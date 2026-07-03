import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { SyncProvider } from '@/sync/sync-context';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';
import { useUIStore, type PlantumlTheme } from '@/stores/useUIStore';

/**
 * Real production pipeline harness. Mounts the REAL SimpleMarkdownRenderer inside the context
 * providers it depends on: I18nProvider (diagram status labels), RuntimeAPIProvider
 * (useRuntimeAPIs), ThemeSystemProvider (currentTheme -> the themeId/dark render key), and
 * SyncProvider (effective directory). NOTHING under src/ is mocked — every module is the
 * production one; only the app-boundary contexts are injected exactly as the app does at startup.
 *
 * Window control surface:
 *  - __plSetMarkdown(md): drives the `content` prop (render, swap sources, fire streaming edits).
 *  - __plSetDark(dark):   flips the real theme system light/dark, so a repaint of an EXISTING
 *                         block through a genuine theme change can be asserted (AC8).
 *  - __plSetTheme(name):  sets the persisted plantumlTheme in the REAL useUIStore (the exact
 *                         setter the Settings -> Appearance Select calls), so a live theme-switch
 *                         repaint of an EXISTING block can be asserted (theme picker e2e).
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
        __plSetMarkdown?: (markdown: string) => void;
        __plSetDark?: (dark: boolean) => void;
        __plSetTheme?: (theme: PlantumlTheme) => void;
        __plReady?: boolean;
    }
}

const Harness: React.FC = () => {
    const [content, setContent] = React.useState('');
    const { setThemeMode, setSystemPreference } = useThemeSystem();

    React.useEffect(() => {
        window.__plSetMarkdown = (markdown: string) => setContent(markdown);
        window.__plSetDark = (dark: boolean) => {
            // Pin an explicit mode (not OS preference) so the flip is deterministic, then switch
            // variant — this drives currentTheme through the real theme system, exactly as the
            // app's theme controls do, changing the dark component of the plantuml render key.
            setSystemPreference(false);
            setThemeMode(dark ? 'dark' : 'light');
        };
        window.__plSetTheme = (theme: PlantumlTheme) => {
            // Drive the persisted plantumlTheme through the REAL store setter — identical to what
            // the Settings -> Appearance Select does. The reactive useUIStore(s => s.plantumlTheme)
            // selector in MarkdownRendererImpl then repaints the live block via the cache key.
            useUIStore.getState().setPlantumlTheme(theme);
        };
        window.__plReady = true;
        const root = document.getElementById('root');
        if (root) root.setAttribute('data-pl-status', 'ready');
        return () => {
            window.__plReady = false;
            delete window.__plSetMarkdown;
            delete window.__plSetDark;
        };
    }, [setThemeMode, setSystemPreference]);

    return (
        <SimpleMarkdownRenderer content={content} variant="assistant" enableFileReferences={false} />
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
