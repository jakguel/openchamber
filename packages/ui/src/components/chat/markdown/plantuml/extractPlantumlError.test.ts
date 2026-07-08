import { describe, expect, test } from 'bun:test';

import { extractPlantumlError } from './extractPlantumlError';
import {
    errorDiagramNoTheme,
    errorDiagramThemeToy,
    PLANTUML_ERROR_FIXTURE_META,
} from './__fixtures__/index';

// `DOMParser` is undefined under bun:test, so the production default boundary cannot run here. This
// is the sanctioned engine-free fallback: a minimal, dependency-free XML text-node walk that pulls
// each <text> element's textContent (reassembling <tspan> children) out of the REAL committed
// fixture bytes, then feeds it into the SAME pure parser the browser DOMParser path uses. Only the
// platform/XML boundary is injected; the citation/line/token logic under test runs for real.
function extractSvgText(svg: string): string {
    const nodes: string[] = [];
    const textRe = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
    let match: RegExpExecArray | null;
    while ((match = textRe.exec(svg)) !== null) {
        // Strip any nested element tags (e.g. <tspan>) to reassemble the node's text content.
        nodes.push(match[1].replace(/<[^>]*>/g, ''));
    }
    return nodes.join('\n');
}

function callWithoutThrowing(run: () => unknown): { threw: boolean; result: unknown } {
    try {
        return { threw: false, result: run() };
    } catch {
        return { threw: true, result: undefined };
    }
}

describe('extractPlantumlError — AC-T2a real T1 fixtures (exact line + token)', () => {
    test('no-theme fixture: exact line 3 and the offending token, via the real text-node path', () => {
        const svgText = extractSvgText(errorDiagramNoTheme);
        const result = extractPlantumlError(errorDiagramNoTheme, { parseSvgText: () => svgText });

        expect(result).not.toBeNull();
        // EXACT values (a regression to the generic constant or a wrong token MUST fail these).
        expect(result?.line).toBe(3);
        expect(result?.line).toBe(PLANTUML_ERROR_FIXTURE_META.originalErrorLine);
        expect(result?.token).toContain('diamond "some label" as X');
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
        expect(result?.detail).toContain('3');
        expect(result?.detail).toContain('diamond "some label" as X');
    });

    test('theme-active fixture: raw cited line 78 (themeInsertedLines omitted) + same offending token', () => {
        const svgText = extractSvgText(errorDiagramThemeToy);
        const result = extractPlantumlError(errorDiagramThemeToy, { parseSvgText: () => svgText });

        expect(result?.line).toBe(78);
        expect(result?.line).toBe(PLANTUML_ERROR_FIXTURE_META.themedErrorLine);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });

    test('themeInsertedLines subtracts to map the themed line back to the original source line', () => {
        const svgText = extractSvgText(errorDiagramThemeToy);
        const result = extractPlantumlError(errorDiagramThemeToy, {
            parseSvgText: () => svgText,
            themeInsertedLines: PLANTUML_ERROR_FIXTURE_META.themeInsertedLines,
        });

        // 78 - 75 = 3 (the user's original source line). Full derivation of the 75 is T3.
        expect(result?.line).toBe(PLANTUML_ERROR_FIXTURE_META.originalErrorLine);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });
});

describe('extractPlantumlError — AC-T2b returns null (no throw) on non-error / malformed input', () => {
    test('a valid (non-error) SVG with no citation returns null', () => {
        const valid = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="10" height="10"/></g></svg>';
        expect(extractPlantumlError(valid, { parseSvgText: (svg) => extractSvgText(svg) })).toBeNull();
    });

    test('a citation-less text (no [From ... (line N)]) returns null', () => {
        expect(
            extractPlantumlError('<svg/>', { parseSvgText: () => 'some rendered label\nSyntax Error?' }),
        ).toBeNull();
    });

    test('a malformed / truncated SVG does not throw and returns null', () => {
        const malformed = '<svg xmlns="http://www.w3.org/2000/svg"><text>[From textarea (line';
        const call = callWithoutThrowing(() =>
            extractPlantumlError(malformed, { parseSvgText: (svg) => extractSvgText(svg) }),
        );
        expect(call.threw).toBe(false);
        expect(call.result).toBeNull();
    });

    test('an empty boundary result returns null', () => {
        expect(extractPlantumlError('<svg/>', { parseSvgText: () => '' })).toBeNull();
    });

    test('a boundary that throws is swallowed to null (never propagates)', () => {
        const call = callWithoutThrowing(() =>
            extractPlantumlError('<svg/>', {
                parseSvgText: () => {
                    throw new Error('boundary blew up');
                },
            }),
        );
        expect(call.threw).toBe(false);
        expect(call.result).toBeNull();
    });
});

describe('extractPlantumlError — AC-T2c multi-error + non-English + entity decode', () => {
    test('multi-error text yields a coherent detail anchored on the first citation', () => {
        const text = [
            '[From textarea (line 3) ]',
            'diamond "some label" as X',
            ' Syntax Error? (Assumed diagram type: component)',
            '[From textarea (line 9) ]',
            'other bad token',
            ' Syntax Error? (Assumed diagram type: component)',
        ].join('\n');
        const result = extractPlantumlError('<svg/>', { parseSvgText: () => text });

        expect(result?.line).toBe(3);
        expect(result?.token).toBe('diamond "some label" as X');
        expect(result?.detail).toContain('3');
        expect(result?.detail).toContain('diamond "some label" as X');
    });

    test('non-English-locale marker (no English "Syntax Error") still returns a detail with line + token', () => {
        // Marker text localized; the last non-empty line is treated as the marker so the token
        // (the line before it) is still recovered, and a citation is still present.
        const text = ['[From textarea (line 12) ]', 'agent Bob', 'Erreur de syntaxe ?'].join('\n');
        const result = extractPlantumlError('<svg/>', { parseSvgText: () => text });

        expect(result).not.toBeNull();
        expect(result?.line).toBe(12);
        expect(result?.token).toBe('agent Bob');
        expect(result?.detail).toContain('12');
        expect(result?.detail).toContain('agent Bob');
    });

    test('XML entities in the offending token are decoded in the pure parser', () => {
        const text = [
            '[From textarea (line 4) ]',
            'note &quot;a &lt;b&gt; c&quot; as N',
            ' Syntax Error? (Assumed diagram type: component)',
        ].join('\n');
        const result = extractPlantumlError('<svg/>', { parseSvgText: () => text });

        expect(result?.line).toBe(4);
        expect(result?.token).toBe('note "a <b> c" as N');
    });
});
