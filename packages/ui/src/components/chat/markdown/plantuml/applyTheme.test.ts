import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertOfflineSafe, spliceTheme, stripFrontMatter } from './applyTheme';

const TOY_BODY = ['skinparam participant {', '    BackgroundColor FF6F61', '}'].join('\n');

describe('spliceTheme', () => {
    test('splices the body on the line right after @startuml, preserving user content', () => {
        const source = '@startuml\nA->B\n@enduml';
        const out = spliceTheme(source, TOY_BODY);

        expect(out).toBe('@startuml\n' + TOY_BODY + '\nA->B\n@enduml');
        const lines = out.split('\n');
        expect(lines[0]).toBe('@startuml');
        expect(lines[1]).toBe('skinparam participant {');
        expect(out).toContain('A->B');
        expect(out).not.toBe(source);
    });

    test('splices after a @startmindmap opener', () => {
        const source = '@startmindmap\n* root\n@endmindmap';
        const out = spliceTheme(source, TOY_BODY);

        expect(out.split('\n')[1]).toBe('skinparam participant {');
        expect(out).toContain('* root');
    });

    test('empty theme body returns the source unchanged (none case)', () => {
        const source = '@startuml\nA->B\n@enduml';
        expect(spliceTheme(source, '')).toBe(source);
    });

    test('whitespace-only theme body returns the source unchanged', () => {
        const source = '@startuml\nA->B\n@enduml';
        expect(spliceTheme(source, '   \n\t ')).toBe(source);
    });

    test('source without a @start opener is returned unchanged', () => {
        expect(spliceTheme('A->B', TOY_BODY)).toBe('A->B');
    });

    test('with two @startuml blocks only the first is spliced', () => {
        const source = '@startuml\nA->B\n@enduml\n@startuml\nC->D\n@enduml';
        const out = spliceTheme(source, TOY_BODY);

        const occurrences = out.split('skinparam participant {').length - 1;
        expect(occurrences).toBe(1);
        expect(out.indexOf('skinparam participant {')).toBeLessThan(out.indexOf('C->D'));
        expect(out.startsWith('@startuml\n' + TOY_BODY + '\nA->B')).toBe(true);
    });
});

describe('assertOfflineSafe', () => {
    test('rejects a body containing !include', () => {
        expect(() => assertOfflineSafe('skinparam Foo\n!include <office/foo>', 'fixture')).toThrow(
            /Offline-unsafe/,
        );
    });

    test('rejects a body containing a remote https URL', () => {
        expect(() => assertOfflineSafe('sprite $x https://example.com/x.png')).toThrow(/Offline-unsafe/);
    });

    test('accepts a clean skinparam-only body', () => {
        let threw = false;
        try {
            assertOfflineSafe(TOY_BODY, 'toy');
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
    });
});

describe('stripFrontMatter', () => {
    test('removes the leading YAML front-matter fence from a real vendored theme file', () => {
        const themePath = fileURLToPath(new URL('./themes/puml-theme-toy.puml', import.meta.url));
        const raw = readFileSync(themePath, 'utf8');
        expect(raw.startsWith('---')).toBe(true);

        const stripped = stripFrontMatter(raw);
        expect(stripped).not.toContain('license:');
        expect(stripped.trimStart().startsWith('---')).toBe(false);
        expect(stripped).toContain('skinparam participant {');
    });

    test('is a no-op on a body that has no front-matter', () => {
        const body = 'skinparam BackgroundColor DDDDDD\nskinparam shadowing false\n';
        expect(stripFrontMatter(body)).toBe(body);
    });
});
