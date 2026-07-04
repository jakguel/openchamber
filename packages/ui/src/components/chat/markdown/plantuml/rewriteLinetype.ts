// `skinparam linetype ortho` triggers a confirmed PlantUML+Graphviz limitation (plantuml/backlog#11):
// Graphviz refuses to place edge labels on orthogonally-routed edges, so crow's-foot ER relationship
// labels render detached at the diagram's left edge (label x/y are baked into the SVG by the engine —
// CSS cannot move them). Rewriting the directive to `polyline` on the RENDER COPY re-attaches the
// labels to their edges (edges become straight segments — the accepted tradeoff). This module is
// `?raw`-free so it runs under bun:test, mirroring applyTheme.ts vs themeBodies.ts.

// `\blinetype\s+` anchors to the directive so a bare `ortho` token elsewhere (entity/label text) is
// never touched; `\bortho\b` avoids matching `orthogonal`. Case-insensitive + global for `SkinParam
// LineType ORTHO` and multiple occurrences. Only `ortho` is rewritten (`polyline`/`curve`/absent stay).
const LINETYPE_ORTHO_RE = /(\blinetype\s+)ortho\b/gi;

export function rewriteLinetypeForLabels(source: string): string {
    return source.replace(LINETYPE_ORTHO_RE, '$1polyline');
}
