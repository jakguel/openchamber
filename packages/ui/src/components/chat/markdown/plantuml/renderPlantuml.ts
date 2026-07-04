import { loadPlantUmlEngine, type PlantUmlEngine } from './loadEngine';
import { ensurePlantumlStdlib } from './stdlib/injectStdlib';
import { sanitizeSvg } from './sanitizeSvg';
import { spliceTheme } from './applyTheme';
import { rewriteLinetypeForLabels } from './rewriteLinetype';

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

export async function renderPlantuml(source: string, dark: boolean, themeBody: string): Promise<PlantUmlRenderResult> {
    try {
        const engine = await loadPlantUmlEngine();
        await ensurePlantumlStdlib();
        // Splice the vendored theme body into a LOCAL copy only — never mutate the copyable
        // PLANTUML_SOURCE_ATTR / expand-popup source, which must keep the user's original.
        // Then rewrite `linetype ortho` -> `polyline` on that SAME render copy so crow's-foot ER
        // edge labels re-attach (Graphviz cannot place labels on ortho edges — see rewriteLinetype).
        const themed = rewriteLinetypeForLabels(spliceTheme(source, themeBody));
        // A vendored theme is a COMPLETE, self-consistent color scheme (its own BackgroundColor +
        // FontColor + per-element colors). The engine's `dark` adaptation only re-adapts the DEFAULT
        // palette — applied on top of a spliced theme it forces text to white while leaving the
        // theme's fixed light fills (e.g. sunlust #C2F0FF) intact, producing unreadable white-on-light.
        // Render an active theme in its own scheme (dark=false); `dark` still varies the cache key,
        // so a light/dark toggle repaints.
        const effectiveDark = themeBody.trim().length > 0 ? false : dark;
        const raw = await renderToStringOnce(engine, themed, effectiveDark, RENDER_TIMEOUT_MS);
        if (isPlantumlError(raw)) {
            return { error: 'Invalid PlantUML diagram source' };
        }
        return { svg: sanitizeSvg(raw) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
