/**
 * Playwright real-Chromium proof — PlantUML dark-mode legibility (openchamber-f9d.25.2).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.25   Task: openchamber-f9d.25.2
 *
 * Root cause (instrument-confirmed): @plantuml/core honors a spliced vendored theme's own
 * `skinparam BackgroundColor` (a LIGHT canvas, e.g. toy #DDDDDD / sunlust #FDF6E3) even under the
 * engine's `{ dark: true }` flag, but that same flag ALSO force-inverts the FONT color to white
 * (#FFFFFF). The result is white text on the theme's light canvas — unreadable. The default 'none'
 * palette dark-adapts correctly (white text on a #1B1B1B canvas). Fix: render an active vendored
 * theme in its own self-consistent scheme (dark=false at the engine), so the theme's native dark
 * font color is kept; 'none' still gets the engine's dark adaptation. `dark` stays in the render
 * cache key, so a light<->dark toggle still repaints.
 *
 * This drives the REAL production pipeline (fixtures/plantuml-pipeline, `@` -> real src, NOTHING
 * under src/ mocked): __plSetDark flips the real theme system, __plSetTheme drives the real
 * useUIStore.setPlantumlTheme, __plSetMarkdown feeds the real SimpleMarkdownRenderer.
 *
 * RUN (workspace-local runner — bunx pulls a mismatched runner; jsdom getBBox=0 can't render):
 *   packages/ui/node_modules/.bin/playwright test --config packages/ui/playwright.config.ts \
 *     --project=chromium plantumlDarkMode --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

const BLOCK = '[data-markdown="plantuml-block"]';
const SVG = `${BLOCK} [data-markdown="plantuml"] svg`;
const RENDER_BOUND_MS = 60_000;

const fence = (src: string): string => '```plantuml\n' + src + '\n```';
const ER = '@startuml\nentity Kunde {\n  * id\n  name\n}\nentity Bestellung {\n  * id\n}\nKunde ||--o{ Bestellung : erzeugt\n@enduml';

type Legibility = {
  textFill: string;
  bg: string;
  contrast: number;
  textIsWhite: boolean;
};

let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
  server = await createServer({ root: fixtureRoot, configFile: fixtureConfig, logLevel: 'error' });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('vite dev server produced no local url');
  baseUrl = url;
});

test.afterAll(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

async function mount(page: Page): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__plReady === true, { timeout: 20_000 });
}

async function renderER(page: Page): Promise<void> {
  await page.evaluate((md) => window.__plSetMarkdown?.(md), fence(ER));
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.textContent ?? '').includes('Kunde'),
    SVG,
    { timeout: RENDER_BOUND_MS },
  );
}

// WCAG relative-luminance contrast between the dominant diagram text fill and the effective
// diagram background (svg inline background-color -> largest canvas rect fill -> --surface-elevated).
function measureLegibility(page: Page): Promise<Legibility> {
  return page.evaluate((sel) => {
    const svg = document.querySelector(sel) as SVGSVGElement | null;
    if (!svg) throw new Error('no svg');

    const parse = (raw: string): [number, number, number] | null => {
      const s = raw.trim();
      const rgb = /^rgba?\(([^)]+)\)$/i.exec(s);
      if (rgb) {
        const p = rgb[1].split(',').map((v) => parseFloat(v));
        return [p[0], p[1], p[2]];
      }
      let hex = s.replace('#', '');
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      if (hex.length === 8) hex = hex.slice(0, 6);
      if (hex.length !== 6) return null;
      const n = parseInt(hex, 16);
      if (Number.isNaN(n)) return null;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const lum = (rgb: [number, number, number]): number => {
      const a = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.4152 * a[2];
    };
    const contrast = (a: string, b: string): number => {
      const pa = parse(a);
      const pb = parse(b);
      if (!pa || !pb) return 0;
      const la = lum(pa);
      const lb = lum(pb);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    };

    const styleBg = (svg.getAttribute('style') || '').match(/background-color\s*:\s*([^;]+)/i)?.[1] ?? '';
    let bg = styleBg.trim();
    if (!bg) {
      let widest = 0;
      for (const r of Array.from(svg.querySelectorAll('rect'))) {
        const w = Number(r.getAttribute('width') || '0');
        const fill = r.getAttribute('fill') || '';
        if (w > widest && fill && !/^#0{6,8}$/i.test(fill.replace('#', '#'))) {
          widest = w;
          bg = fill;
        }
      }
    }
    if (!bg) bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-elevated').trim();

    const counts: Record<string, number> = {};
    for (const t of Array.from(svg.querySelectorAll('text'))) {
      const f = (t.getAttribute('fill') || '').trim();
      if (f) counts[f] = (counts[f] || 0) + 1;
    }
    const textFill = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    return {
      textFill,
      bg,
      contrast: contrast(textFill, bg),
      textIsWhite: /^#f{3}$|^#f{6}$/i.test(textFill.replace(/\s/g, '')),
    };
  }, SVG);
}

test.describe('PlantUML dark-mode legibility — real Chromium (openchamber-f9d.25.2)', () => {
  test('AC1: dark mode + plantumlTheme=none renders legibly (white text on a dark canvas)', async ({ page }) => {
    test.setTimeout(RENDER_BOUND_MS + 60_000);
    await mount(page);
    await page.evaluate(() => window.__plSetDark?.(true));
    await page.evaluate(() => window.__plSetTheme?.('none'));
    await renderER(page);

    const r = await measureLegibility(page);
    expect(r.contrast, `none/dark contrast text=${r.textFill} bg=${r.bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test('AC2: dark mode + vendored themes (toy, sunlust) are legible, NOT white-on-light', async ({ page }) => {
    test.setTimeout(RENDER_BOUND_MS * 2 + 60_000);
    await mount(page);
    await page.evaluate(() => window.__plSetDark?.(true));

    await page.evaluate(() => window.__plSetTheme?.('toy'));
    await renderER(page);
    const toy = await measureLegibility(page);
    // Pre-fix this is white (#FFFFFF) on the theme's light #DDDDDD canvas -> contrast ~1.35 -> fail.
    expect(toy.textIsWhite, `toy/dark text fill=${toy.textFill} must not be force-inverted to white`).toBe(false);
    expect(toy.contrast, `toy/dark contrast text=${toy.textFill} bg=${toy.bg}`).toBeGreaterThanOrEqual(4.5);

    await page.evaluate(() => window.__plSetTheme?.('sunlust'));
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.getAttribute('style') ?? '').includes('FDF6E3'),
      SVG,
      { timeout: RENDER_BOUND_MS },
    );
    const sun = await measureLegibility(page);
    expect(sun.textIsWhite, `sunlust/dark text fill=${sun.textFill} must not be white`).toBe(false);
    expect(sun.contrast, `sunlust/dark contrast text=${sun.textFill} bg=${sun.bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test('AC3: light mode unchanged + a dark<->light toggle invalidates the cache and repaints', async ({ page }) => {
    test.setTimeout(RENDER_BOUND_MS * 2 + 60_000);
    await mount(page);

    // Light mode 'none' regression baseline: legible dark-on-light, exactly one block.
    await page.evaluate(() => window.__plSetDark?.(false));
    await page.evaluate(() => window.__plSetTheme?.('none'));
    await renderER(page);
    const light = await measureLegibility(page);
    expect(light.textIsWhite, 'light/none text is not white').toBe(false);
    expect(light.contrast, `light/none contrast text=${light.textFill} bg=${light.bg}`).toBeGreaterThanOrEqual(4.5);
    expect(await page.locator(BLOCK).count()).toBe(1);

    // Toggle to dark: the SAME block must repaint to the dark palette (white text on a dark canvas).
    await page.evaluate(() => window.__plSetDark?.(true));
    await page.waitForFunction(
      (sel) => {
        const svg = document.querySelector(sel);
        return !!svg && (svg.getAttribute('style') ?? '').includes('1B1B1B');
      },
      SVG,
      { timeout: RENDER_BOUND_MS },
    );
    const dark = await measureLegibility(page);
    expect(dark.textIsWhite, 'dark/none repaint yields white text').toBe(true);
    expect(dark.contrast, `dark/none contrast text=${dark.textFill} bg=${dark.bg}`).toBeGreaterThanOrEqual(4.5);
    expect(await page.locator(BLOCK).count()).toBe(1);
  });
});
