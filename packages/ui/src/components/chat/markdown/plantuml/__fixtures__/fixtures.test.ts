import { describe, expect, test } from 'bun:test';

import {
    errorDiagramNoTheme,
    errorDiagramThemeToy,
    PLANTUML_ERROR_FIXTURE_META,
} from './index';

const PLANTUML_ERROR_SIGNATURE = /\$version\$|\[from [^\]]*line \d|syntax error|assumed diagram/i;

describe('plantuml error-diagram fixtures — AC-T1c load without engine', () => {
    test('no-theme fixture loads and is a real error diagram citing the offending line + token', () => {
        expect(errorDiagramNoTheme.length).toBeGreaterThan(500);
        expect(PLANTUML_ERROR_SIGNATURE.test(errorDiagramNoTheme)).toBe(true);
        expect(errorDiagramNoTheme).toContain(
            `[From ${PLANTUML_ERROR_FIXTURE_META.citationLabel} (line ${PLANTUML_ERROR_FIXTURE_META.originalErrorLine})`,
        );
        expect(errorDiagramNoTheme).toContain(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });

    test('theme-active fixture loads and cites the theme-offset line for the same token', () => {
        expect(errorDiagramThemeToy.length).toBeGreaterThan(500);
        expect(PLANTUML_ERROR_SIGNATURE.test(errorDiagramThemeToy)).toBe(true);
        expect(errorDiagramThemeToy).toContain(
            `[From ${PLANTUML_ERROR_FIXTURE_META.citationLabel} (line ${PLANTUML_ERROR_FIXTURE_META.themedErrorLine})`,
        );
        expect(errorDiagramThemeToy).toContain(PLANTUML_ERROR_FIXTURE_META.offendingToken);
    });

    test('theme offset equals themed line minus original line (T3 mapping input)', () => {
        expect(PLANTUML_ERROR_FIXTURE_META.themedErrorLine - PLANTUML_ERROR_FIXTURE_META.originalErrorLine).toBe(
            PLANTUML_ERROR_FIXTURE_META.themeInsertedLines,
        );
    });
});
