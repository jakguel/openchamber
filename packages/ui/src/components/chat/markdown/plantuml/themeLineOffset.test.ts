import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { stripFrontMatter } from './applyTheme';
import { extractPlantumlError } from './extractPlantumlError';
import { resolveThemeLineMapping, themeInsertedLineCount } from './themeLineOffset';
import { errorDiagramNoTheme, errorDiagramThemeToy, PLANTUML_ERROR_FIXTURE_META } from './__fixtures__/index';

// Real normalized toy theme body via the SAME production path as themeBodies.ts (stripFrontMatter
// over the committed .puml) so the derived inserted-line count is the REAL value, not hardcoded 75.
const TOY_BODY = stripFrontMatter(readFileSync(new URL('./themes/puml-theme-toy.puml', import.meta.url), 'utf8'));

// DOMParser is undefined under bun:test — reuse the sanctioned engine-free XML text-node walk that
// pulls each <text> element's content out of the real fixture bytes and feeds the pure parser.
function extractSvgText(svg: string): string {
    const nodes: string[] = [];
    const textRe = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
    let match: RegExpExecArray | null;
    while ((match = textRe.exec(svg)) !== null) {
        nodes.push(match[1].replace(/<[^>]*>/g, ''));
    }
    return nodes.join('\n');
}

describe('themeInsertedLineCount — AC-T3d derived (not hardcoded) from the real spliceTheme body', () => {
    test('the real toy theme body inserts exactly 75 lines (matches the T1 fixture offset)', () => {
        expect(themeInsertedLineCount(TOY_BODY)).toBe(75);
        expect(themeInsertedLineCount(TOY_BODY)).toBe(PLANTUML_ERROR_FIXTURE_META.themeInsertedLines);
    });

    test('an empty / whitespace-only theme body inserts nothing (none case)', () => {
        expect(themeInsertedLineCount('')).toBe(0);
        expect(themeInsertedLineCount('   \n\t ')).toBe(0);
    });
});

describe('resolveThemeLineMapping — AC-T3c uncertainty predicate', () => {
    test('a plain @startuml diagram with a theme is trusted, carrying the derived offset', () => {
        const source = '@startuml\nrectangle "Box" as R\n@enduml';
        expect(resolveThemeLineMapping(source, TOY_BODY)).toEqual({
            active: true,
            trusted: true,
            insertedLines: 75,
        });
    });

    test('a non-@startuml opener (@startmindmap) with a theme is active but UNtrusted', () => {
        const source = '@startmindmap\n* root\n@endmindmap';
        expect(resolveThemeLineMapping(source, TOY_BODY)).toEqual({ active: true, trusted: false });
    });

    test('no theme body → not active (cited line passes through)', () => {
        expect(resolveThemeLineMapping('@startuml\nA->B\n@enduml', '')).toEqual({ active: false });
    });
});

describe('extractPlantumlError themed→original mapping — AC-T3a/b/c against the REAL T1 fixtures', () => {
    test('AC-T3a: toy theme-active fixture → surfaced line is the ORIGINAL source line 3 (78 − 75)', () => {
        const insertedLines = themeInsertedLineCount(TOY_BODY);
        const result = extractPlantumlError(errorDiagramThemeToy, {
            parseSvgText: (svg) => extractSvgText(svg),
            themeInsertedLines: insertedLines,
        });

        expect(result).not.toBeNull();
        expect(result?.line).toBe(3);
        expect(result?.line).toBe(PLANTUML_ERROR_FIXTURE_META.originalErrorLine);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
        expect(result?.detail).toContain('line 3');
        expect(result?.detail).not.toContain('78');
    });

    test('AC-T3b: no-theme fixture → cited line passes through unchanged (3 → 3)', () => {
        const result = extractPlantumlError(errorDiagramNoTheme, {
            parseSvgText: (svg) => extractSvgText(svg),
        });

        expect(result?.line).toBe(3);
        expect(result?.line).toBe(PLANTUML_ERROR_FIXTURE_META.originalErrorLine);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });

    test('AC-T3c: theme active but uncertain → line OMITTED, token still surfaced (never a wrong line)', () => {
        const result = extractPlantumlError(errorDiagramThemeToy, {
            parseSvgText: (svg) => extractSvgText(svg),
            themeLineUncertain: true,
        });

        expect(result).not.toBeNull();
        expect(result?.line).toBe(undefined);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
        // Exact detail — a leaked line would render `Syntax error on line N: ...` and fail this.
        expect(result?.detail).toBe(`Syntax error near: ${PLANTUML_ERROR_FIXTURE_META.offendingToken}`);
        expect(result?.detail).not.toContain('78');
        expect(result?.detail).not.toContain('line');
    });

    test('AC-T3c (runtime guard): an untrusted count that underflows the cited line omits the line', () => {
        const result = extractPlantumlError(errorDiagramThemeToy, {
            parseSvgText: (svg) => extractSvgText(svg),
            themeInsertedLines: 1000,
        });

        expect(result?.line).toBe(undefined);
        expect(result?.token).toBe(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });
});
