import c4StdlibUrl from './c4.min.js?url';

type EngineScriptState = { state: string; ok: Array<() => void>; err: Array<(message: string) => void> };

let stdlibPromise: Promise<void> | null = null;

// When the engine resolves `!include <C4/...>` it does NOT read the pre-injected globals directly;
// it first calls its own script loader ED3('c4.min.js'), which is gated on window.__pl_script_state.
// Unless that state says the script is already 'loaded', the engine fetches /c4.min.js from origin
// root (a real network request, and a 404 → error diagram). We inject c4.min.js ourselves, so we
// mark the loader state 'loaded' for the engine's exact key ('<lib>.min.js', lowercased) — this
// short-circuits ED3 to our injected globals and yields offline C4 with ZERO fetches.
const ENGINE_LOADER_KEY = 'c4.min.js';

function markEngineScriptLoaded(key: string): void {
    const w = globalThis as unknown as { __pl_script_state?: Record<string, EngineScriptState> };
    w.__pl_script_state = w.__pl_script_state || {};
    const prior = w.__pl_script_state[key];
    w.__pl_script_state[key] = { state: 'loaded', ok: [], err: [] };
    if (prior?.ok) for (const cb of prior.ok) cb();
}

function injectStdlibScriptOnce(url: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const selector = `script[data-plantuml-stdlib="${key}"]`;
        const prior = document.querySelector<HTMLScriptElement>(selector);
        if (prior) {
            if (prior.dataset.loaded === '1') {
                resolve();
                return;
            }
            prior.addEventListener('load', () => resolve(), { once: true });
            prior.addEventListener('error', () => reject(new Error(`stdlib ${key} failed to load`)), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = false;
        script.dataset.plantumlStdlib = key;
        script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); }, { once: true });
        script.addEventListener('error', () => reject(new Error(`stdlib ${key} failed to load`)), { once: true });
        document.head.appendChild(script);
    });
}

// Vendored c4.min.js (C4-PlantUML v2.13.0, MIT) is a self-contained IIFE that populates
// window.PLANTUML_STDLIB / _STDLIB_INFO / _STDLIB_JSON. Injecting it once (globals) PLUS marking
// the engine loader state (markEngineScriptLoaded) makes `!include <C4/...>` resolve fully offline.
export function ensurePlantumlStdlib(): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('PlantUML stdlib injection is browser-only (SSR-guarded)'));
    }
    if (stdlibPromise) return stdlibPromise;
    stdlibPromise = injectStdlibScriptOnce(c4StdlibUrl, 'c4').then(() => markEngineScriptLoaded(ENGINE_LOADER_KEY));
    return stdlibPromise;
}
