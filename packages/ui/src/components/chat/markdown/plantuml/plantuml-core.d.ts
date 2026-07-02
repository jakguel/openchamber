// Ambient types for the untyped @plantuml/core engine (TeaVM-compiled JS, MIT).
// The engine is loaded ONLY via dynamic import() from loadEngine.ts, never statically
// from anything reachable by the app baseline bundle. See the C0 decision record
// (packages/ui/spike-plantuml/DECISION-RECORD.md).

declare module '@plantuml/core/plantuml.js' {
    /** Renders `lines` into the DOM element with id `targetId`. No error callback. */
    export function render(lines: string[], targetId: string, options?: { dark?: boolean }): void;
    /**
     * Renders `lines` and delivers the SVG string to `onSuccess`. The 4th `options`
     * arg IS honored in 1.2026.6 (C0-proven). NOTE: a PlantUML SYNTAX error is NOT
     * delivered via `onError` — it arrives at `onSuccess` as an error-diagram SVG.
     */
    export function renderToString(
        lines: string[],
        onSuccess: (svg: string) => void,
        onError: (message: string) => void,
        options?: { dark?: boolean },
    ): void;
}
