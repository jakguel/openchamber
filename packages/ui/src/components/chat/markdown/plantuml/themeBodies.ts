// Vendored raw PlantUML theme bodies (Vite `?raw` imports; NOT bun:test-runnable).
// Source: plantuml/plantuml @ 597262b70fb50671094413e3b6c3a0ef49de9a97,
// src/main/resources/themes/puml-theme-<name>.puml. See THIRD_PARTY_NOTICES for per-theme licenses.
import { assertOfflineSafe, stripFrontMatter, type PlantumlThemeName } from './applyTheme';
import plainRaw from './themes/puml-theme-plain.puml?raw';
import monoRaw from './themes/puml-theme-mono.puml?raw';
import sunlustRaw from './themes/puml-theme-sunlust.puml?raw';
import toyRaw from './themes/puml-theme-toy.puml?raw';
import reddressLightblueRaw from './themes/puml-theme-reddress-lightblue.puml?raw';

function prepareThemeBody(raw: string, name: PlantumlThemeName): string {
    const body = stripFrontMatter(raw);
    assertOfflineSafe(body, name);
    return body;
}

export const THEME_BODIES: Record<PlantumlThemeName, string> = {
    plain: prepareThemeBody(plainRaw, 'plain'),
    mono: prepareThemeBody(monoRaw, 'mono'),
    sunlust: prepareThemeBody(sunlustRaw, 'sunlust'),
    toy: prepareThemeBody(toyRaw, 'toy'),
    'reddress-lightblue': prepareThemeBody(reddressLightblueRaw, 'reddress-lightblue'),
};
