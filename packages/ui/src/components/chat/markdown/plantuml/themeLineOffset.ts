// A PlantUML theme is applied by splicing the raw theme body into the diagram source right after the
// `@start*` opener (spliceTheme in applyTheme.ts) — `!theme` is a silent no-op offline. So the engine
// cites a THEME-OFFSET line in the spliced text, not the user's original source. This module derives,
// READ-ONLY, how many lines spliceTheme inserts so the extractor can map the cited line back, and
// decides when that mapping is trustworthy enough to surface.

import { spliceTheme } from './applyTheme';

// A minimal diagram with a plain `@start` opener so spliceTheme performs its insertion. spliceTheme's
// inserted-line count depends ONLY on the theme body (it inserts `\n${body}` after the opener), never
// on the source, so this fixed sentinel's own line count is a stable baseline to subtract from.
const SENTINEL_SOURCE = '@startuml\n@enduml';

/**
 * Number of lines `spliceTheme` (applyTheme.ts) inserts before the user's source for `themeBody`.
 *
 * Derived by running the REAL `spliceTheme` against a fixed sentinel and measuring the line-count
 * delta — this is strictly READ-ONLY with respect to spliceTheme (it calls it, never modifies it)
 * and therefore tracks any future change to spliceTheme's body normalization automatically instead
 * of duplicating it. Returns 0 for an empty / whitespace-only body (spliceTheme inserts nothing).
 */
export function themeInsertedLineCount(themeBody: string): number {
    const before = SENTINEL_SOURCE.split('\n').length;
    const after = spliceTheme(SENTINEL_SOURCE, themeBody).split('\n').length;
    return Math.max(0, after - before);
}

// spliceTheme also splices after `@startmindmap`/`@startgantt`/`@startjson`/`@startsalt`, but only a
// plain `@startuml` diagram shares the `[From ... (line N)]` citation semantics the extractor maps
// against. A themed non-@startuml diagram is still spliced, yet its cited line can't be trusted to
// map cleanly back to user source — so we omit the line there rather than surface a wrong one.
const TRUSTED_OPENER_RE = /^[ \t]*@startuml\b/im;

export type ThemeLineMapping =
    | { active: false }
    | { active: true; trusted: true; insertedLines: number }
    | { active: true; trusted: false };

/**
 * Resolve how an engine-cited line for a THEMED render maps back to the user's original source.
 *
 * - `{ active: false }` — no theme spliced (empty body / no insertion): pass the cited line through.
 * - `{ active: true, trusted: true, insertedLines }` — a plain `@startuml` diagram with N spliced
 *   lines: the caller subtracts N from the cited line.
 * - `{ active: true, trusted: false }` — a theme is spliced but into a non-`@startuml` opener: OMIT
 *   the line and surface the token only (never a wrong line).
 */
export function resolveThemeLineMapping(source: string, themeBody: string): ThemeLineMapping {
    const insertedLines = themeInsertedLineCount(themeBody);
    if (insertedLines <= 0) return { active: false };
    if (!TRUSTED_OPENER_RE.test(source)) return { active: true, trusted: false };
    return { active: true, trusted: true, insertedLines };
}
