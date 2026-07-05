/**
 * Playwright real-Chromium proof — Markdown Table-of-Contents whole-story e2e (openchamber-5ki.37.17).
 *
 * Epic: openchamber-5ki   Story: openchamber-5ki.37   Task: openchamber-5ki.37.17 (final gate)
 *
 * Exercises the SHIPPED ToC feature end-to-end across every surface that owns it, through the REAL
 * render pipeline and REAL scroll geometry:
 *   - Desktop FilesView inline preview + fullscreen ScrollableOverlay overlay (fixtures/markdown-toc
 *     ?surface=desktop): AC1 (list/nesting), AC2 (click-scroll inline + fullscreen), AC3 (collapse),
 *     AC7 (docked-toolbar chrome), and the zero/JSON negative cases.
 *   - Mobile MobileFilesSurface / MobileFileDetail ScrollShadow (?surface=mobile): AC2 (mobile
 *     click-scroll) + AC8 (mobile header chrome).
 *   - Raw render paths (?surface=dup / ?surface=byteid): AC4 (duplicate-heading morphdom safety),
 *     AC9 (chat vs file-preview byte-identity of heading ids).
 *
 * WHY real Chromium (not jsdom): AC2 asserts that clicking a ToC entry brings its heading into the
 * scroller's viewport — pure layout + scrollTop geometry. jsdom reports 0 for getBoundingClientRect
 * and scrollHeight, so the scroll math can only be exercised in a real layout engine. AC4's morphdom
 * dup-id corruption risk is likewise only observable against a live DOM diff.
 *
 * Nothing under src/ is mocked — the fixture mounts the production FilesView, MobileFilesSurface,
 * MarkdownRenderer and SimpleMarkdownRenderer; only the files IO boundary is injected. The full
 * compiled Tailwind stylesheet from packages/web/dist/assets is injected so the real h-full /
 * overflow-auto / flex layout applies and the scrollers actually scroll (REQUIRES `bun run build`).
 *
 * RUN (workspace-local runner — NOT bunx):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium markdownToc --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'markdown-toc');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const webAssets = path.resolve(currentDir, '..', '..', 'web', 'dist', 'assets');

const READY_MS = 20_000;
const TOC_TOGGLE = 'Toggle table of contents';
const OVERLAY = '.z-50';
const goTo = (heading: string) => `button[aria-label="Go to ${heading}"]`;

let server: ViteDevServer | null = null;
let baseUrl = '';
let shippingCss = '';

test.beforeAll(async () => {
    expect(
        existsSync(webAssets),
        'packages/web/dist/assets missing — run `bun run build` first (the injected CSS carries the real Tailwind layout the scrollers depend on)',
    ).toBe(true);
    const cssFiles = readdirSync(webAssets).filter((f) => f.endsWith('.css'));
    expect(cssFiles.length, 'no compiled .css in packages/web/dist/assets').toBeGreaterThan(0);
    shippingCss = cssFiles.map((f) => readFileSync(path.join(webAssets, f), 'utf-8')).join('\n');

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

async function mount(page: Page, query: string): Promise<void> {
    await page.goto(`${baseUrl}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__tocReady === true, { timeout: READY_MS });
    await page.addStyleTag({ content: shippingCss });
}

type ScrollProbe = {
    found: boolean;
    headTop: number;
    scrollerTop: number;
    scrollerBottom: number;
    scrollTop: number;
} | null;

// Measures a rendered heading (matched by text within `rootSel`) relative to its nearest scrollable
// ancestor — the exact element scrollToHeading targets. Real geometry: only meaningful in Chromium.
function probeHeading(page: Page, rootSel: string, text: string): Promise<ScrollProbe> {
    return page.evaluate(
        ({ rootSel, text }) => {
            const root = document.querySelector(rootSel);
            if (!root) return null;
            const heads = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-content] h1, [data-markdown-content] h2, [data-markdown-content] h3'));
            const el = heads.find((h) => (h.textContent ?? '').trim() === text);
            if (!el) return null;
            let node: HTMLElement | null = el.parentElement;
            let scroller: HTMLElement | null = null;
            while (node) {
                const style = getComputedStyle(node);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
                    scroller = node;
                    break;
                }
                node = node.parentElement;
            }
            if (!scroller) return null;
            const hr = el.getBoundingClientRect();
            const sr = scroller.getBoundingClientRect();
            return { found: true, headTop: hr.top, scrollerTop: sr.top, scrollerBottom: sr.bottom, scrollTop: scroller.scrollTop };
        },
        { rootSel, text },
    );
}

async function waitHeadingAtTop(page: Page, rootSel: string, text: string): Promise<void> {
    await page.waitForFunction(
        ({ rootSel, text }) => {
            const root = document.querySelector(rootSel);
            if (!root) return false;
            const heads = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-content] h1, [data-markdown-content] h2, [data-markdown-content] h3'));
            const el = heads.find((h) => (h.textContent ?? '').trim() === text);
            if (!el) return false;
            let node: HTMLElement | null = el.parentElement;
            let scroller: HTMLElement | null = null;
            while (node) {
                const style = getComputedStyle(node);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
                    scroller = node;
                    break;
                }
                node = node.parentElement;
            }
            if (!scroller) return false;
            const headTop = el.getBoundingClientRect().top;
            const scrollerTop = scroller.getBoundingClientRect().top;
            return scroller.scrollTop > 4 && Math.abs(headTop - scrollerTop) < 48;
        },
        { rootSel, text },
        { timeout: 8_000 },
    );
}

// Reads the docked file-content bar chrome (post f75eb67f). `scope` is either the
// whole document (inline bar) or the fullscreen overlay. Resolves var(--background)
// and var(--surface-subtle) through probe elements appended in the bar's own cascade
// so the comparison is theme-accurate.
type BarChrome = { barBg: string; background: string; surfaceSubtle: string; barText: string } | null;
function barChrome(page: Page, scope: 'document' | typeof OVERLAY): Promise<BarChrome> {
    return page.evaluate((scopeSel) => {
        const root: ParentNode | null = scopeSel === 'document' ? document : document.querySelector(scopeSel);
        if (!root) return null;
        const toggle = root.querySelector('button[aria-label="Toggle table of contents"]');
        const bar = toggle?.closest('div') ?? null;
        if (!bar) return null;
        const probe = (value: string): string => {
            const el = document.createElement('div');
            el.style.backgroundColor = value;
            bar.appendChild(el);
            const resolved = getComputedStyle(el).backgroundColor;
            el.remove();
            return resolved;
        };
        return {
            barBg: getComputedStyle(bar).backgroundColor,
            background: probe('var(--background)'),
            surfaceSubtle: probe('var(--surface-subtle)'),
            barText: (bar.textContent ?? '').trim(),
        };
    }, scope);
}

type CmLineProbe = {
    scroller: boolean;
    found: boolean;
    scrollTop: number;
    scrollerTop: number;
    scrollerBottom: number;
    lineTop: number | null;
    lineBottom: number | null;
};

// Measures a CodeMirror source line (matched by exact text) against the .cm-scroller
// viewport — the surface scrollEditorToHeading targets in markdown edit mode.
function cmLineProbe(page: Page, text: string): Promise<CmLineProbe> {
    return page.evaluate((text) => {
        const scroller = document.querySelector('.cm-scroller');
        if (!scroller) {
            return { scroller: false, found: false, scrollTop: 0, scrollerTop: 0, scrollerBottom: 0, lineTop: null, lineBottom: null };
        }
        const sr = scroller.getBoundingClientRect();
        const line = Array.from(scroller.querySelectorAll<HTMLElement>('.cm-line')).find(
            (l) => (l.textContent ?? '').trim() === text,
        );
        if (!line) {
            return { scroller: true, found: false, scrollTop: scroller.scrollTop, scrollerTop: sr.top, scrollerBottom: sr.bottom, lineTop: null, lineBottom: null };
        }
        const lr = line.getBoundingClientRect();
        return { scroller: true, found: true, scrollTop: scroller.scrollTop, scrollerTop: sr.top, scrollerBottom: sr.bottom, lineTop: lr.top, lineBottom: lr.bottom };
    }, text);
}

async function waitCmLineInViewport(page: Page, text: string): Promise<void> {
    await page.waitForFunction(
        (text) => {
            const scroller = document.querySelector('.cm-scroller');
            if (!scroller) return false;
            const sr = scroller.getBoundingClientRect();
            const line = Array.from(scroller.querySelectorAll<HTMLElement>('.cm-line')).find(
                (l) => (l.textContent ?? '').trim() === text,
            );
            if (!line) return false;
            const lr = line.getBoundingClientRect();
            return scroller.scrollTop > 0 && lr.top >= sr.top - 2 && lr.bottom <= sr.bottom + 2;
        },
        text,
        { timeout: 8_000 },
    );
}

async function enterMarkdownEditMode(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Switch to edit mode' }).click();
    await page.waitForSelector('.cm-editor .cm-scroller', { timeout: READY_MS });
    await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 3, { timeout: READY_MS });
}

test.describe('Markdown ToC — desktop FilesView (real Chromium)', () => {
    test('AC1: ToC lists exactly the H1–H3 headings in order with correct nesting', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        const nav = page.locator('nav[aria-label="Table of contents"]').first();
        await expect(nav).toBeVisible();

        const order = await nav.locator('button[aria-label^="Go to "]').evaluateAll((btns) =>
            btns.map((b) => (b.textContent ?? '').trim()),
        );
        expect(order).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);

        // The H4 "Golf" heading is rendered but MUST NOT appear in the ToC (H1–H3 only).
        expect(order).not.toContain('Golf');

        // Nesting mirrors buildTocTree: a child entry's <li> is nested inside its parent's <li>.
        const nesting = await nav.evaluate((navEl) => {
            const li = (text: string): HTMLElement | null => {
                const btn = Array.from(navEl.querySelectorAll<HTMLElement>('button[aria-label^="Go to "]')).find(
                    (b) => (b.textContent ?? '').trim() === text,
                );
                return btn ? btn.closest('li') : null;
            };
            const contains = (parent: string, child: string): boolean => {
                const p = li(parent);
                const c = li(child);
                return !!p && !!c && p !== c && p.contains(c);
            };
            const topLevel = (text: string): boolean => {
                const el = li(text);
                if (!el) return false;
                return el.parentElement?.parentElement === navEl;
            };
            return {
                bravoInAlpha: contains('Alpha', 'Bravo'),
                charlieInBravo: contains('Bravo', 'Charlie'),
                deltaInAlpha: contains('Alpha', 'Delta'),
                foxtrotInEcho: contains('Echo', 'Foxtrot'),
                alphaTop: topLevel('Alpha'),
                echoTop: topLevel('Echo'),
            };
        });
        expect(nesting).toEqual({
            bravoInAlpha: true,
            charlieInBravo: true,
            deltaInAlpha: true,
            foxtrotInEcho: true,
            alphaTop: true,
            echoTop: true,
        });
    });

    test('AC1: frontmatter is stripped — ToC lists headings, not frontmatter keys', async ({ page }) => {
        await mount(page, 'surface=desktop&file=frontmatter');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        const nav = page.locator('nav[aria-label="Table of contents"]').first();
        const order = await nav.locator('button[aria-label^="Go to "]').evaluateAll((btns) =>
            btns.map((b) => (b.textContent ?? '').trim()),
        );
        expect(order).toEqual(['After Front', 'Sub Front']);
        expect(order).not.toContain('title');
        expect(order).not.toContain('tags');
    });

    test('AC2: clicking a ToC entry brings its heading into the INLINE preview viewport', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });
        await page.getByRole('button', { name: TOC_TOGGLE }).click();

        const before = await probeHeading(page, 'body', 'Foxtrot');
        expect(before?.found).toBe(true);
        // Pre-click: not scrolled, and Foxtrot sits below the scroller viewport.
        expect(before!.scrollTop).toBe(0);
        expect(before!.headTop).toBeGreaterThan(before!.scrollerBottom);

        await page.locator(goTo('Foxtrot')).click();
        await waitHeadingAtTop(page, 'body', 'Foxtrot');

        const after = await probeHeading(page, 'body', 'Foxtrot');
        expect(after!.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(after!.headTop - after!.scrollerTop)).toBeLessThan(48);
    });

    test('AC2: clicking a ToC entry brings its heading into the FULLSCREEN overlay viewport', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });
        // Open the ToC sidebar, then enter the fullscreen ScrollableOverlay surface.
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        const overlay = page.locator(OVERLAY);
        await expect(overlay).toBeVisible();
        await page.waitForSelector(`${OVERLAY} [data-markdown-content] h1`, { timeout: READY_MS });

        const before = await probeHeading(page, OVERLAY, 'Foxtrot');
        expect(before?.found).toBe(true);
        expect(before!.scrollTop).toBe(0);
        expect(before!.headTop).toBeGreaterThan(before!.scrollerBottom);

        await overlay.locator(goTo('Foxtrot')).click();
        await waitHeadingAtTop(page, OVERLAY, 'Foxtrot');

        const after = await probeHeading(page, OVERLAY, 'Foxtrot');
        expect(after!.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(after!.headTop - after!.scrollerTop)).toBeLessThan(48);
    });

    test('AC3: collapsing a parent ToC entry hides its descendant entries', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        const nav = page.locator('nav[aria-label="Table of contents"]').first();

        await expect(nav.locator(goTo('Bravo'))).toBeVisible();
        await expect(nav.locator(goTo('Charlie'))).toBeVisible();
        await expect(nav.locator(goTo('Delta'))).toBeVisible();

        await nav.getByRole('button', { name: 'Collapse Alpha' }).click();

        await expect(nav.locator(goTo('Bravo'))).toBeHidden();
        await expect(nav.locator(goTo('Charlie'))).toBeHidden();
        await expect(nav.locator(goTo('Delta'))).toBeHidden();
        // Sibling root stays visible — only Alpha's subtree collapsed.
        await expect(nav.locator(goTo('Echo'))).toBeVisible();
    });

    test('AC7/AC-T3a: docked bar is bg-background, ToC-toggle-only chrome — no filename, copy, or open-in-app', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });

        // Docked toolbar controls are visible WITHOUT hover (always-on docked layout).
        await expect(page.getByRole('button', { name: TOC_TOGGLE })).toBeVisible();
        // Non-vacuous sprite guard: the docked ToC-toggle icon uses the #oc-* sprite href.
        expect(await page.locator('svg use[href="#oc-list-unordered"]').count()).toBeGreaterThan(0);
        // No floating hover-menu overlay (the old floating controls wrapper is gone).
        expect(await page.locator('.pointer-events-auto.rounded-lg.shadow-sm').count()).toBe(0);
        // No Download button in the preview chrome.
        expect(await page.locator('svg use[href="#oc-download"]').count()).toBe(0);

        // The docked bar background resolves to var(--background) (not var(--surface-subtle))
        // and carries no filename/path text.
        const chrome = await barChrome(page, 'document');
        expect(chrome).not.toBeNull();
        expect(chrome!.barBg).toBe(chrome!.background);
        if (chrome!.background !== chrome!.surfaceSubtle) {
            expect(chrome!.barBg).not.toBe(chrome!.surfaceSubtle);
        }
        expect(chrome!.barText).not.toContain('nested');

        // The bar exposes no Open-in-App, Copy File Contents, or Copy File Path controls.
        expect(await page.getByRole('button', { name: /open in desktop app/i }).count()).toBe(0);
        expect(await page.getByRole('button', { name: /copy file contents/i }).count()).toBe(0);
        expect(await page.getByRole('button', { name: /copy file path/i }).count()).toBe(0);
        expect(await page.getByRole('button', { name: /copy/i }).count()).toBe(0);

        // Fullscreen: the docked toolbar is rebuilt always-on inside the overlay with
        // the same bg-background chrome and the same removals.
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        const overlay = page.locator(OVERLAY);
        await expect(overlay).toBeVisible();
        await expect(overlay.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
        await expect(overlay.getByRole('button', { name: TOC_TOGGLE })).toBeVisible();
        expect(await overlay.locator('.pointer-events-auto.rounded-lg.shadow-sm').count()).toBe(0);
        expect(await overlay.locator('svg use[href="#oc-download"]').count()).toBe(0);

        const overlayChrome = await barChrome(page, OVERLAY);
        expect(overlayChrome).not.toBeNull();
        expect(overlayChrome!.barBg).toBe(overlayChrome!.background);
        expect(overlayChrome!.barText).not.toContain('nested');
        expect(await overlay.getByRole('button', { name: /open in desktop app/i }).count()).toBe(0);
        expect(await overlay.getByRole('button', { name: /copy/i }).count()).toBe(0);
    });

    test('AC-T3b: markdown edit mode shows the ToC toggle and opens the aside with heading entries', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });

        await enterMarkdownEditMode(page);

        // ToC toggle stays present in code/edit mode (gated on markdown + headings, not view mode).
        await expect(page.getByRole('button', { name: TOC_TOGGLE })).toBeVisible();
        await page.getByRole('button', { name: TOC_TOGGLE }).click();

        const nav = page.locator('nav[aria-label="Table of contents"]').first();
        await expect(nav).toBeVisible();
        const order = await nav.locator('button[aria-label^="Go to "]').evaluateAll((btns) =>
            btns.map((b) => (b.textContent ?? '').trim()),
        );
        expect(order).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
    });

    test('AC-T3c: clicking a lower ToC entry in edit mode scrolls its source line into the CodeMirror viewport', async ({ page }) => {
        await mount(page, 'surface=desktop&file=nested');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });

        await enterMarkdownEditMode(page);
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        await expect(page.locator('nav[aria-label="Table of contents"]').first()).toBeVisible();

        // Pre-click: the editor is at the top and the lower "## Foxtrot" source line is
        // off-screen (either not virtualized into the DOM, or below the scroller).
        const before = await cmLineProbe(page, '## Foxtrot');
        expect(before.scroller).toBe(true);
        expect(before.scrollTop).toBe(0);
        if (before.found) {
            expect(before.lineTop!).toBeGreaterThan(before.scrollerBottom);
        }

        await page.locator(goTo('Foxtrot')).click();
        await waitCmLineInViewport(page, '## Foxtrot');

        const after = await cmLineProbe(page, '## Foxtrot');
        expect(after.found).toBe(true);
        expect(after.scrollTop).toBeGreaterThan(0);
        expect(after.lineTop!).toBeGreaterThanOrEqual(after.scrollerTop - 2);
        expect(after.lineBottom!).toBeLessThanOrEqual(after.scrollerBottom + 2);
    });

    test('AC-T3c: edit-mode ToC scroll respects the frontmatter line offset', async ({ page }) => {
        await mount(page, 'surface=desktop&file=frontmatter');
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });

        await enterMarkdownEditMode(page);
        await page.getByRole('button', { name: TOC_TOGGLE }).click();
        await expect(page.locator('nav[aria-label="Table of contents"]').first()).toBeVisible();

        // The heading's absolute source line (past 4 frontmatter lines) is what gets
        // scrolled to — the exact "## Sub Front" line lands in the viewport, proving the
        // toc.ts frontmatter offset flows through scrollEditorToHeading.
        await page.locator(goTo('Sub Front')).click();
        await waitCmLineInViewport(page, '## Sub Front');

        const after = await cmLineProbe(page, '## Sub Front');
        expect(after.found).toBe(true);
        expect(after.lineTop!).toBeGreaterThanOrEqual(after.scrollerTop - 2);
        expect(after.lineBottom!).toBeLessThanOrEqual(after.scrollerBottom + 2);
    });

    test('AC-T3d: a plain code file opens without a preview toggle', async ({ page }) => {
        await mount(page, 'surface=desktop&file=code');
        await page.waitForSelector('[data-toc-status="ready"]', { timeout: READY_MS });
        await page.waitForSelector('.cm-editor .cm-content', { timeout: READY_MS });

        // Code files open directly in CodeMirror — no markdown/HTML preview toggle, and
        // no ToC toggle (non-markdown).
        expect(await page.getByRole('button', { name: /switch to (edit|preview) mode/i }).count()).toBe(0);
        await expect(page.getByRole('button', { name: TOC_TOGGLE })).toHaveCount(0);
    });

    test('AC7: the ToC toggle is absent for a non-markdown (JSON) file', async ({ page }) => {
        await mount(page, 'surface=desktop&file=json');
        await page.waitForSelector('[data-toc-status="ready"]', { timeout: READY_MS });
        await expect(page.getByRole('button', { name: TOC_TOGGLE })).toHaveCount(0);
    });

    test('AC negative: a zero-heading markdown file shows no ToC chrome', async ({ page }) => {
        await mount(page, 'surface=desktop&file=zero');
        await page.waitForSelector('[data-markdown-content]', { timeout: READY_MS });
        await expect(page.getByRole('button', { name: TOC_TOGGLE })).toHaveCount(0);
        expect(await page.locator('nav[aria-label="Table of contents"]').count()).toBe(0);
    });
});

test.describe('Markdown ToC — mobile MobileFilesSurface (real Chromium)', () => {
    test.use({ viewport: { width: 390, height: 780 } });

    test('AC8: mobile header shows the ToC button and no copy-content / copy-path buttons', async ({ page }) => {
        await mount(page, 'surface=mobile');
        await page.getByRole('button', { name: 'nested.md' }).click();
        const header = page.locator('header').first();
        await expect(header.getByRole('button', { name: 'Open table of contents' })).toBeVisible();
        // Header carries exactly the back button + the ToC button — no copy affordances.
        expect(await header.getByRole('button').count()).toBe(2);
        expect(await page.getByRole('button', { name: /copy/i }).count()).toBe(0);
    });

    test('AC2: tapping a ToC entry brings its heading into the mobile ScrollShadow viewport', async ({ page }) => {
        await mount(page, 'surface=mobile');
        await page.getByRole('button', { name: 'nested.md' }).click();
        await page.waitForSelector('[data-markdown-content] h1', { timeout: READY_MS });

        const before = await probeHeading(page, 'body', 'Foxtrot');
        expect(before?.found).toBe(true);
        expect(before!.scrollTop).toBe(0);
        expect(before!.headTop).toBeGreaterThan(before!.scrollerBottom);

        await page.getByRole('button', { name: 'Open table of contents' }).click();
        await page.locator(goTo('Foxtrot')).click();
        await waitHeadingAtTop(page, 'body', 'Foxtrot');

        const after = await probeHeading(page, 'body', 'Foxtrot');
        expect(after!.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(after!.headTop - after!.scrollerTop)).toBeLessThan(48);
    });
});

test.describe('Markdown ToC — render-path invariants (real Chromium)', () => {
    test('AC4: duplicate headings get distinct anchors and none is lost after a content edit', async ({ page }) => {
        await mount(page, 'surface=dup');
        const preview = page.locator('[data-testid="preview-render"]');
        await page.waitForSelector('[data-testid="preview-render"] [data-markdown-content] h1', { timeout: READY_MS });

        const idsBefore = await preview.locator('[data-markdown-content] :is(h1,h2,h3)').evaluateAll((hs) =>
            hs.map((h) => ({ text: (h.textContent ?? '').trim(), id: h.id })),
        );
        expect(idsBefore).toEqual([
            { text: 'Repeat', id: 'md-h-repeat' },
            { text: 'Repeat', id: 'md-h-repeat-1' },
            { text: 'Tail', id: 'md-h-tail' },
        ]);

        // Content edit → morphdom diff. Duplicate ids (if not de-duped) would collapse a heading.
        const edited = ['# Repeat', 'para one edited', '# Repeat', 'para two edited', '# Tail', 'para three edited'].join('\n\n');
        await page.evaluate((md) => window.__mdSetPreview?.(md), edited);
        await page.waitForFunction(
            () => document.querySelector('[data-testid="preview-render"]')?.textContent?.includes('para two edited') ?? false,
            { timeout: READY_MS },
        );

        const idsAfter = await preview.locator('[data-markdown-content] :is(h1,h2,h3)').evaluateAll((hs) =>
            hs.map((h) => ({ text: (h.textContent ?? '').trim(), id: h.id })),
        );
        // No heading dropped; both duplicates survive with their distinct anchors intact.
        expect(idsAfter).toEqual([
            { text: 'Repeat', id: 'md-h-repeat' },
            { text: 'Repeat', id: 'md-h-repeat-1' },
            { text: 'Tail', id: 'md-h-tail' },
        ]);
    });

    test('AC9: chat headings carry NO md-h- id while file-preview headings DO', async ({ page }) => {
        await mount(page, 'surface=byteid');
        await page.waitForSelector('[data-testid="chat-render"] [data-markdown-content] h1', { timeout: READY_MS });
        await page.waitForSelector('[data-testid="preview-render"] [data-markdown-content] h1', { timeout: READY_MS });

        const chat = await page.locator('[data-testid="chat-render"] [data-markdown-content] :is(h1,h2,h3)').evaluateAll((hs) =>
            hs.map((h) => ({ text: (h.textContent ?? '').trim(), id: h.id })),
        );
        const preview = await page.locator('[data-testid="preview-render"] [data-markdown-content] :is(h1,h2,h3)').evaluateAll((hs) =>
            hs.map((h) => ({ text: (h.textContent ?? '').trim(), id: h.id })),
        );

        // Non-vacuous: both paths rendered the same heading set.
        expect(chat.length).toBeGreaterThan(0);
        expect(chat.map((h) => h.text)).toEqual(preview.map((h) => h.text));

        // Chat render path stays anchor-free — no injected md-h- id leaks in.
        for (const h of chat) {
            expect(h.id.startsWith('md-h-'), `chat heading "${h.text}" unexpectedly has id "${h.id}"`).toBe(false);
        }
        // File-preview path opts in — every heading receives a md-h- id.
        for (const h of preview) {
            expect(h.id.startsWith('md-h-'), `preview heading "${h.text}" missing md-h- id (got "${h.id}")`).toBe(true);
        }
    });
});
