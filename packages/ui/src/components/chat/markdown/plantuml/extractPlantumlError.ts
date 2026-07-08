// @plantuml/core@1.2026.6 has NO text/utxt diagnostic API — a SYNTAX error arrives at `onSuccess`
// as an error-diagram SVG whose <text>/<tspan> nodes carry a `[From textarea (line N)]` source
// citation, the echoed offending source block, and a trailing `Syntax Error?` marker (see the
// captured T1 fixtures + PROVENANCE.md). This module turns that SVG into a structured error.
//
// Injectable + engine-free (no `?raw`/`?url`, no @plantuml/core import) so it is unit-testable
// under bun:test, mirroring cacheKey.ts / applyTheme.ts. The ONLY DOM-dependent step — pulling the
// concatenated <text> textContent out of the raw SVG — is a thin `parseSvgText` boundary. The
// PRODUCTION default uses the real browser `DOMParser` (this runs in renderPlantuml.ts, in the
// app). All citation/line/token parsing below is plain string logic with NO DOM dependency, so a
// bun-native `parseSvgText` (HTMLRewriter / XML text walk) can drive the SAME parser in tests.

export type PlantumlErrorInfo = {
    line?: number;
    token?: string;
    detail: string;
    // The complete concatenated <text> node content (entity-decoded) the parser worked from — the
    // FULL engine diagnostic, for console logging. `detail` stays the concise line/token summary for
    // the UI; `fullText` carries everything the error diagram rendered. Purely additive.
    fullText?: string;
};

export type ExtractPlantumlErrorOptions = {
    // spliceTheme (applyTheme.ts) inserts the theme body after the `@start` opener, so the engine
    // cites a theme-offset line. When provided (> 0), subtract it to map the themed line back to the
    // user's original source line. The count is DERIVED read-only from the real theme body by
    // themeInsertedLineCount (themeLineOffset.ts); this module only consumes it.
    themeInsertedLines?: number;
    // Set by the caller when a theme is active but the themed → original line mapping is NOT
    // trustworthy (e.g. a non-@startuml opener, or an untrusted inserted-line count — see
    // resolveThemeLineMapping in themeLineOffset.ts). The line is OMITTED (token-only) rather than
    // surfacing a possibly-wrong line. Takes precedence over themeInsertedLines.
    themeLineUncertain?: boolean;
    // Boundary override for tests / non-DOM runtimes. Receives the raw SVG, returns the concatenated
    // <text> node textContent (entity-decoded, tspans reassembled). Defaults to a real DOMParser.
    parseSvgText?: (svg: string) => string;
};

// `[From textarea (line 3) ]` in the real 1.2026.6 output (label is `textarea`, NOT the illustrative
// `string`; note the space before `]`). Anchored on the `(line N)` group; the leading `[from` +
// `line` words are matched loosely so a differently-labelled source origin still parses.
const CITATION_RE = /\[from\b[^\]]*\(line\s+(\d+)\s*\)/i;

// Trailing marker line the engine always renders directly AFTER the offending source line.
const ERROR_MARKER_RE = /syntax error|assumed diagram/i;

// The DOMParser path already resolves entities; decode defensively so an injected boundary that
// does NOT decode (or a `<`/`>` token echoed as `&lt;`/`&gt;`) still yields clean text. `&amp;` is
// decoded last so `&amp;lt;` does not collapse into `<`.
function decodeXmlEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// Browser-only default. `DOMParser` is undefined under bun:test — this default is NEVER exercised
// there; the test injects a bun-native `parseSvgText` over the SAME parser below. `textContent`
// reassembles <tspan> children and decodes XML entities for each <text> node.
function defaultParseSvgText(svg: string): string {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const nodes = doc.querySelectorAll('text');
    const out: string[] = [];
    nodes.forEach((node) => out.push(node.textContent ?? ''));
    return out.join('\n');
}

// Pure logic: given the concatenated <text> textContent, locate the citation (→ line) and the
// offending token (the echoed source line immediately before the trailing error marker). Returns
// null when there is no citation (a valid render, or a non-PlantUML/citation-less SVG).
function parseErrorFromText(
    text: string,
    opts: { themeInsertedLines?: number; themeLineUncertain?: boolean } = {},
): PlantumlErrorInfo | null {
    const decoded = decodeXmlEntities(text);
    const lines = decoded.split('\n');

    // First citation wins (a multi-error diagram repeats the block; the first is the primary error).
    let citedLine: number | undefined;
    for (const raw of lines) {
        const match = CITATION_RE.exec(raw);
        if (match) {
            const parsed = Number.parseInt(match[1], 10);
            if (Number.isFinite(parsed)) citedLine = parsed;
            break;
        }
    }
    if (citedLine === undefined) return null;

    const nonEmpty = lines.map((line) => line.trim()).filter((line) => line.length > 0);
    // The engine ALWAYS renders the marker as the trailing line, so the offending token is the line
    // right before it. A non-English build localizes the marker text — fall back to treating the
    // last non-empty line as the marker so the token is still recovered.
    let markerIdx = nonEmpty.findIndex((line) => ERROR_MARKER_RE.test(line));
    if (markerIdx < 0) markerIdx = nonEmpty.length - 1;

    let token = markerIdx >= 1 ? nonEmpty[markerIdx - 1] : undefined;
    // Guard degenerate diagrams where the citation itself is the line before the marker.
    if (token !== undefined && (token.length === 0 || CITATION_RE.test(token))) token = undefined;

    const line = resolveOriginalLine(citedLine, opts);
    const detail = buildDetail(line, token);

    const info: PlantumlErrorInfo = { detail, fullText: decoded };
    if (line !== undefined) info.line = line;
    if (token !== undefined) info.token = token;
    return info;
}

// Map the engine-cited (possibly theme-offset) line back to the user's original source line, or
// OMIT it (return undefined) when the mapping can't be trusted — never surface a wrong line:
//   - themeLineUncertain: a theme is active but the mapping is untrustworthy (non-@startuml opener).
//   - underflow (cited line at/below the spliced theme block): the count doesn't map to real source.
// With no active theme the cited line passes through unchanged.
function resolveOriginalLine(
    citedLine: number,
    opts: { themeInsertedLines?: number; themeLineUncertain?: boolean },
): number | undefined {
    if (opts.themeLineUncertain) return undefined;
    const inserted = opts.themeInsertedLines;
    if (inserted === undefined || inserted <= 0) return citedLine;
    const mapped = citedLine - inserted;
    return mapped >= 1 ? mapped : undefined;
}

function buildDetail(line: number | undefined, token: string | undefined): string {
    if (line !== undefined) {
        return token ? `Syntax error on line ${line}: ${token}` : `Syntax error on line ${line}`;
    }
    return token ? `Syntax error near: ${token}` : 'Syntax error';
}

/**
 * Extract the real PlantUML engine error (line + offending token) from an error-diagram SVG.
 *
 * Returns `{ line?, token?, detail }` when a `[From ... (line N)]` citation is present, or `null`
 * when there is none (valid/non-error SVG, citation-less SVG) or when the SVG is malformed. Never
 * throws: a boundary or parse failure yields `null` so callers can fall back to the generic constant.
 */
export function extractPlantumlError(
    rawSvg: string,
    opts: ExtractPlantumlErrorOptions = {},
): PlantumlErrorInfo | null {
    const parseSvgText = opts.parseSvgText ?? defaultParseSvgText;

    let text: string;
    try {
        text = parseSvgText(rawSvg);
    } catch {
        return null;
    }
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    try {
        return parseErrorFromText(text, {
            themeInsertedLines: opts.themeInsertedLines,
            themeLineUncertain: opts.themeLineUncertain,
        });
    } catch {
        return null;
    }
}
