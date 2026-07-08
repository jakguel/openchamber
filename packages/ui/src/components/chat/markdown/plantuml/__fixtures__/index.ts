import { readFileSync } from 'node:fs';

function loadFixture(file: string): string {
    return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
}

export const errorDiagramNoTheme = loadFixture('error-diagram.no-theme.svg');
export const errorDiagramThemeToy = loadFixture('error-diagram.theme-toy.svg');

export type PlantumlErrorFixtureMeta = {
    snippet: string;
    offendingToken: string;
    citationLabel: string;
    originalErrorLine: number;
    themeName: string;
    themedErrorLine: number;
    themeInsertedLines: number;
};

export const PLANTUML_ERROR_FIXTURE_META: PlantumlErrorFixtureMeta = {
    snippet: '@startuml\nrectangle "Box" as R\ndiamond "some label" as X\nR --> X\n@enduml',
    offendingToken: 'diamond "some label" as X',
    citationLabel: 'textarea',
    originalErrorLine: 3,
    themeName: 'toy',
    themedErrorLine: 78,
    themeInsertedLines: 75,
};
