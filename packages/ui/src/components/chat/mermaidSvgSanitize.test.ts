import { describe, test, expect } from 'bun:test';
import { stripRemoteFontImports } from './mermaidSvgSanitize';

const IBM_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=IBM%20Plex%20Sans%2C%20sans-serif:wght@400;500;600;700&display=swap');`;
const JETBRAINS_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap');`;

describe('stripRemoteFontImports', () => {
  test('strips both googleapis @imports and preserves surrounding SVG markup', () => {
    const svg = `<svg><style>${IBM_IMPORT}\n${JETBRAINS_IMPORT}\nsvg { color: red; }</style><rect/></svg>`;
    const result = stripRemoteFontImports(svg);
    expect(result).not.toContain('fonts.googleapis.com/css2?family=IBM');
    expect(result).not.toContain('fonts.googleapis.com/css2?family=JetBrains');
    expect(result).toContain('svg { color: red; }');
    expect(result).toContain('<rect/>');
  });

  test('returns an SVG with no googleapis @import unchanged (identical string)', () => {
    const svg = `<svg><style>svg { font-family: 'IBM Plex Sans', sans-serif; }</style></svg>`;
    const result = stripRemoteFontImports(svg);
    expect(result).toBe(svg);
  });

  test('strips double-quoted @import url("https://fonts.googleapis.com/...")', () => {
    const svg = `<svg><style>@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400&display=swap");\nsvg { color: blue; }</style></svg>`;
    const result = stripRemoteFontImports(svg);
    expect(result).not.toContain('fonts.googleapis.com');
    expect(result).toContain('svg { color: blue; }');
  });

  test('does NOT remove a plain-text mention of fonts.googleapis.com in a text node or comment', () => {
    const svg = `<svg><!-- See https://fonts.googleapis.com for info --><text>fonts.googleapis.com</text></svg>`;
    const result = stripRemoteFontImports(svg);
    expect(result).toBe(svg);
  });

  test('leaves a non-googleapis @import url intact', () => {
    const svg = `<svg><style>@import url('https://example.com/x.css');\nsvg { color: green; }</style></svg>`;
    const result = stripRemoteFontImports(svg);
    expect(result).toContain("@import url('https://example.com/x.css');");
    expect(result).toContain('svg { color: green; }');
  });
});
