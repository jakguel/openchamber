// `!theme <name>` is a SILENT no-op in @plantuml/core offline, so themes are applied by splicing the
// raw theme body into the diagram source after the `@start*` opener (see spliceTheme). This module has
// no `?raw` imports so it runs under bun:test; vendored bodies + module-load guard live in themeBodies.ts.

export type PlantumlThemeName = 'plain' | 'mono' | 'sunlust' | 'toy' | 'reddress-lightblue';

// `!include` is the common prefix of `!includeurl`/`!includesub` (catches all three); `https?://`
// catches remote sprite/image refs. Any such ref would trigger a network fetch, breaking offline.
const OFFLINE_UNSAFE_RE = /!include|https?:\/\//i;

export function assertOfflineSafe(body: string, themeName?: string): void {
    const match = OFFLINE_UNSAFE_RE.exec(body);
    if (match) {
        const label = themeName ? ` in theme "${themeName}"` : '';
        throw new Error(
            `Offline-unsafe PlantUML theme body${label}: found "${match[0]}" (remote includes/URLs are not allowed).`,
        );
    }
}

// Leading YAML front-matter fence at the file head (---\n ... \n---\n). Anchored to string start (no
// `m` flag) so a `---` later in the body is untouched, and a file without front-matter is unchanged.
const FRONT_MATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

export function stripFrontMatter(text: string): string {
    return text.replace(FRONT_MATTER_RE, '');
}

// First `@start*` opener line. `m` flag anchors `^` at line starts; `\b` avoids matching `@startumlx`;
// `[^\r\n]*` captures the rest of the opener line (e.g. `@startuml Foo`).
const START_OPENER_RE = /^[ \t]*@start(?:uml|mindmap|gantt|json|salt)\b[^\r\n]*/im;

export function spliceTheme(source: string, themeBody: string): string {
    if (themeBody.trim().length === 0) return source;
    const match = START_OPENER_RE.exec(source);
    if (!match) return source;
    const insertAt = match.index + match[0].length;
    const body = themeBody.replace(/\s+$/, '');
    return `${source.slice(0, insertAt)}\n${body}${source.slice(insertAt)}`;
}
