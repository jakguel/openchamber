import { describe, expect, test } from 'bun:test';

import { rewriteLinetypeForLabels } from './rewriteLinetype';

describe('rewriteLinetypeForLabels', () => {
    test('rewrites `skinparam linetype ortho` -> `skinparam linetype polyline`', () => {
        const source = '@startuml\nskinparam linetype ortho\nA ||--o{ B : hat\n@enduml';
        const out = rewriteLinetypeForLabels(source);

        expect(out).toBe('@startuml\nskinparam linetype polyline\nA ||--o{ B : hat\n@enduml');
        expect(out).not.toContain('linetype ortho');
    });

    test('rewrites the bare `linetype ortho` directive (no skinparam prefix)', () => {
        const source = 'linetype ortho';
        expect(rewriteLinetypeForLabels(source)).toBe('linetype polyline');
    });

    test('is case-insensitive on both the directive and the value', () => {
        const source = 'SkinParam LineType ORTHO';
        expect(rewriteLinetypeForLabels(source)).toBe('SkinParam LineType polyline');
    });

    test('handles extra/tabbed whitespace between `linetype` and `ortho`', () => {
        const source = 'skinparam linetype\t  ortho';
        expect(rewriteLinetypeForLabels(source)).toBe('skinparam linetype\t  polyline');
    });

    test('leaves `linetype polyline` untouched', () => {
        const source = '@startuml\nskinparam linetype polyline\nA->B\n@enduml';
        expect(rewriteLinetypeForLabels(source)).toBe(source);
    });

    test('leaves `linetype curve` untouched', () => {
        const source = '@startuml\nskinparam linetype curve\nA->B\n@enduml';
        expect(rewriteLinetypeForLabels(source)).toBe(source);
    });

    test('leaves a diagram with no linetype directive untouched', () => {
        const source = '@startuml\nA ||--o{ B : hat\n@enduml';
        expect(rewriteLinetypeForLabels(source)).toBe(source);
    });

    test('rewrites multiple `linetype ortho` occurrences', () => {
        const source = 'skinparam linetype ortho\n@startuml\nlinetype ortho\n@enduml';
        expect(rewriteLinetypeForLabels(source)).toBe(
            'skinparam linetype polyline\n@startuml\nlinetype polyline\n@enduml',
        );
    });

    test('does NOT corrupt the word "ortho" appearing inside a relationship label', () => {
        // A label literally containing the word `ortho` must survive verbatim — the `\blinetype\s+`
        // prefix guard means a bare `ortho` token in entity/label text is never touched.
        const source = '@startuml\nskinparam linetype ortho\nA ||--o{ B : "ortho mode"\n@enduml';
        const out = rewriteLinetypeForLabels(source);

        expect(out).toContain('"ortho mode"');
        expect(out).toContain('skinparam linetype polyline');
    });

    test('does NOT match `orthogonal` (word-boundary guard on the value)', () => {
        const source = 'skinparam linetype orthogonal';
        expect(rewriteLinetypeForLabels(source)).toBe(source);
    });

    test('does NOT rewrite `ortho` when not preceded by the `linetype` directive', () => {
        const source = 'skinparam handwritten ortho';
        expect(rewriteLinetypeForLabels(source)).toBe(source);
    });

    test('preserves the rest of a large multi-relation ER source verbatim', () => {
        const source = [
            '@startuml',
            'hide circle',
            'skinparam linetype ortho',
            'Platform ||--o{ Node : hostet',
            'AuditLogPolicy }o--o| Service : regelt',
            '@enduml',
        ].join('\n');
        const out = rewriteLinetypeForLabels(source);

        expect(out).toContain('Platform ||--o{ Node : hostet');
        expect(out).toContain('AuditLogPolicy }o--o| Service : regelt');
        expect(out).toContain('skinparam linetype polyline');
        expect(out.split('\n').length).toBe(source.split('\n').length);
    });
});
