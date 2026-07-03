/**
 * Pure render cache/dedup key for a PlantUML block.
 *
 * Extracted as a dependency-free module (no engine / no `?url` / no `?raw` imports) so it is
 * unit-testable without the ~8.6MB @plantuml/core WASM engine.
 *
 * The key MUST include `plantumlTheme`: `themeId` is the app COLOR theme, which does NOT change
 * when the user switches the PlantUML theme, so omitting `plantumlTheme` would return the stale
 * cached SVG on a theme switch. `source` is appended verbatim.
 */
export type PlantumlCacheKeyInput = {
  themeId: string;
  plantumlTheme: string;
  dark: boolean;
};

export const buildPlantumlCacheKey = (slot: PlantumlCacheKeyInput, source: string): string =>
  `${slot.themeId}:${slot.plantumlTheme}:${slot.dark ? 'dark' : 'light'}:${source}`;
