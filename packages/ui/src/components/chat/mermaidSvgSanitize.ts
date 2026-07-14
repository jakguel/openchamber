// Strips `@import url(...fonts.googleapis.com...)` from Mermaid SVG output.
// beautiful-mermaid unconditionally injects these remote font fetches; they are MIME-blocked
// on proxied deployments and break offline use. App fonts are vendored (fontLoader.ts), so
// the SVG font-family resolves locally — removing the remote @import has no visual effect.
// Non-googleapis @import statements and plain-text occurrences are intentionally left intact.
export function stripRemoteFontImports(svg: string): string {
  return svg.replace(/@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\)\s*;?/gi, '');
}
