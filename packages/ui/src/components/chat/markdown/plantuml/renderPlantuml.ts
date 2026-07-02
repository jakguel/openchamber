import { loadPlantUmlEngine, type PlantUmlEngine } from './loadEngine';
import { ensurePlantumlStdlib } from './stdlib/injectStdlib';
import { sanitizeSvg } from './sanitizeSvg';

export type PlantUmlRenderResult = { svg?: string; error?: string };

const RENDER_TIMEOUT_MS = 15_000;

// A PlantUML SYNTAX error is NOT delivered via onError (C0-proven) — the engine returns an
// error-diagram SVG through onSuccess carrying an unresolved `$version$` footer and a
// `[From ...(line N)` source citation. The only reliable error signal is scanning that SVG.
const PLANTUML_ERROR_SIGNATURE = /\$version\$|\[from [^\]]*line \d|syntax error|assumed diagram/i;

export function isPlantumlError(svg: string): boolean {
    return PLANTUML_ERROR_SIGNATURE.test(svg);
}

function toLines(source: string): string[] {
    return source.split(/\r\n|\r|\n/);
}

function renderToStringOnce(engine: PlantUmlEngine, source: string, dark: boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        // Bounded timeout so a stuck render rejects (→ error affordance) instead of spinning forever.
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('PlantUML render timed out'));
        }, timeoutMs);
        try {
            engine.renderToString(
                toLines(source),
                (svg) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(svg);
                },
                (message) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(message || 'PlantUML render error'));
                },
                { dark },
            );
        } catch (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export async function renderPlantuml(source: string, dark: boolean): Promise<PlantUmlRenderResult> {
    try {
        const engine = await loadPlantUmlEngine();
        await ensurePlantumlStdlib();
        const raw = await renderToStringOnce(engine, source, dark, RENDER_TIMEOUT_MS);
        if (isPlantumlError(raw)) {
            return { error: 'Invalid PlantUML diagram source' };
        }
        return { svg: sanitizeSvg(raw) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
