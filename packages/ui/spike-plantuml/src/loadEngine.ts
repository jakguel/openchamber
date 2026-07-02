import vizGlobalUrl from '@plantuml/core/viz-global.js?url';

export type PlantUmlOptions = { dark?: boolean };

export type PlantUmlEngine = {
    render: (lines: string[], targetId: string, options?: PlantUmlOptions) => void;
    renderToString: (
        lines: string[],
        onSuccess: (svg: string) => void,
        onError: (message: string) => void,
        options?: PlantUmlOptions,
    ) => void;
};

let enginePromise: Promise<PlantUmlEngine> | null = null;

// viz-global.js is a UMD bundle whose global branch runs only as a classic <script>:
// it assigns (globalThis||self).Viz. plantuml.js (ESM) later reads that bare `Viz` global.
// Loading it via a script tag (not import()) makes the side effect deterministic in dev AND
// prod, dodging esbuild/rollup UMD-interop ambiguity — the exact loader risk Oracle flagged.
function loadVizGlobalOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
        const w = globalThis as unknown as { Viz?: unknown };
        if (w.Viz) {
            resolve();
            return;
        }
        const prior = document.querySelector<HTMLScriptElement>('script[data-plantuml-viz]');
        if (prior) {
            prior.addEventListener('load', () => resolve(), { once: true });
            prior.addEventListener('error', () => reject(new Error('viz-global.js failed to load')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = vizGlobalUrl;
        script.async = false;
        script.dataset.plantumlViz = '1';
        script.addEventListener('load', () => resolve(), { once: true });
        script.addEventListener('error', () => reject(new Error('viz-global.js failed to load')), { once: true });
        document.head.appendChild(script);
    });
}

export function loadPlantUmlEngine(): Promise<PlantUmlEngine> {
    // Engine needs document/canvas/getBBox; it throws in Node and mis-sizes in jsdom.
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('PlantUML engine is browser-only (SSR-guarded)'));
    }
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
        await loadVizGlobalOnce();
        const engine = (await import('@plantuml/core/plantuml.js')) as unknown as PlantUmlEngine;
        if (!(globalThis as unknown as { Viz?: unknown }).Viz) {
            throw new Error('Viz global missing after viz-global.js load — load order violated');
        }
        if (typeof engine.render !== 'function' || typeof engine.renderToString !== 'function') {
            throw new Error('plantuml.js did not export render/renderToString');
        }
        return engine;
    })();
    return enginePromise;
}
