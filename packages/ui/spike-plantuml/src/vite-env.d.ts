/// <reference types="vite/client" />

declare module '@plantuml/core/plantuml.js' {
    export function render(lines: string[], targetId: string, options?: { dark?: boolean }): void;
    export function renderToString(
        lines: string[],
        onSuccess: (svg: string) => void,
        onError: (message: string) => void,
        options?: { dark?: boolean },
    ): void;
}
