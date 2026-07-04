/**
 * Playwright real-Chromium proof — detached crow's-foot ER edge labels fix (openchamber-f9d.25.3).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.25   Task: openchamber-f9d.25.3
 *
 * ROOT CAUSE: `skinparam linetype ortho` routes edges orthogonally; @plantuml/core (TeaVM+Viz.js /
 * Graphviz) then places many relation labels far from their edges — instrumented on the repro ER:
 * 13 of 35 German edge labels sit >40px from their nearest edge (max 314px, "floating loose"). The
 * fix rewrites `linetype ortho` -> `linetype polyline` on the RENDER COPY ONLY (rewriteLinetype.ts,
 * wired in renderPlantuml.ts) so every label re-attaches to its line (instrumented after: 0 of 35
 * far, max 31px). The user's ORIGINAL `linetype ortho` source is preserved for copy/expand.
 *
 * WHY this is faithful (FAILS if the fix is reverted): it drives the REAL production pipeline
 * (SimpleMarkdownRenderer -> decorate.ts -> renderPlantuml -> spliceTheme -> rewriteLinetypeForLabels
 * -> @plantuml/core) via the shared plantuml-pipeline fixture; NOTHING under src/ is mocked. Revert
 * the rewrite and the pipeline feeds raw `ortho` to the engine -> ~13 labels detach past the
 * threshold -> the AC1 assertion fails. The label->edge distance is measured in SVG user units
 * (getBBox + getPointAtLength), so it is independent of CSS font/scale.
 *
 * WHY real Chromium (not jsdom): @plantuml/core needs a real layout engine (getBBox/getPointAtLength
 * return 0 in jsdom).
 *
 * RUN (workspace-local runner — NOT bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium plantumlOrthoLabels --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

const BLOCK = '[data-markdown="plantuml-block"]';
const PL_HOST = `${BLOCK} [data-markdown="plantuml"]`;
const PLANTUML_SOURCE_ATTR = 'data-plantuml-source';
const RENDER_BOUND_MS = 90_000;

// A label centre farther than this (SVG user units) from its nearest edge is "detached". Instrumented
// on ORTHO_ER below: WITH the fix every label is <=32px from its line (0 past 45px); WITHOUT it 14
// labels exceed 45px (tail to 76px). 45px therefore discriminates the fix with a comfortable margin
// on both sides.
const DETACH_PX = 45;

const EDGE_LABEL_TOKENS = [
    'hostet', 'enthält', 'erzeugt', 'regelt', 'betrifft', 'analysiert', 'aggregiert', 'schützt',
    'nutzt', 'verknüpft', 'referenziert', 'bricht', 'durchläuft', 'speist', 'erfordert',
];

// Self-contained crow's-foot ER (43 labeled relationships across ~28 entities) modelled on Jiyan's
// repro shape. `skinparam linetype ortho` routes edges orthogonally; on a graph this dense the engine
// detaches labels from their lines (instrumented on this exact diagram: 14 of 53 measured labels sit
// past DETACH_PX WITHOUT the rewrite, 0 WITH it). Every relation label is a single German token in
// EDGE_LABEL_TOKENS so it renders as one <text> node the distance metric can match. No machine-local
// file is read.
const ORTHO_ER = [
    '@startuml',
    'hide circle',
    'hide empty members',
    'skinparam linetype ortho',
    'Platform ||--o{ Node : hostet',
    'Platform ||--o{ Cluster : enthält',
    'Cluster ||--o{ Node : enthält',
    'NetworkSegment ||--o{ Node : enthält',
    'Environment ||--o{ Platform : regelt',
    'Environment ||--o{ Service : regelt',
    'AssetInventory ||--o{ Node : enthält',
    'AssetInventory ||--o{ Workload : enthält',
    'Service ||--o{ Workload : nutzt',
    'Service ||--o{ SLO : aggregiert',
    'Service ||--o{ Runbook : referenziert',
    'Service ||--o{ MonitoringDefinition : nutzt',
    'Service ||--o{ CapacityRecord : aggregiert',
    'Workload }o--|| Cluster : nutzt',
    'Dependency }o--|| Service : verknüpft',
    'Dependency }o--o| NetworkSegment : durchläuft',
    'SLA ||--o{ SLO : aggregiert',
    'SLA }o--|| Service : betrifft',
    'ServiceLevelRegister ||--o{ SLO : aggregiert',
    'ServiceLevelRegister ||--o{ SLA : aggregiert',
    'Incident }o--|| Service : betrifft',
    'Incident }o--o| SLO : bricht',
    'Incident }o--o| Runbook : nutzt',
    'Incident }o--o| KnownError : referenziert',
    'Problem ||--o{ Incident : verknüpft',
    'Problem ||--o| KnownError : erzeugt',
    'KnownError }o--o| Runbook : referenziert',
    'Postmortem }o--|| Incident : analysiert',
    'Postmortem ||--o{ Problem : erzeugt',
    'Change }o--o| ConfigurationItem : regelt',
    'Change }o--o| Service : betrifft',
    'Change }o--o| Workload : betrifft',
    'Release }o--|| Change : erfordert',
    'Release }o--|| Workload : nutzt',
    'BackupPolicy }o--|| Service : schützt',
    'BackupPolicy }o--|| Platform : schützt',
    'VulnerabilityRecord }o--o| Node : betrifft',
    'VulnerabilityRecord }o--o| Workload : betrifft',
    'VulnerabilityRecord }o--|| Change : erfordert',
    'AuditLogPolicy }o--o| Node : regelt',
    'AuditLogPolicy }o--o| Service : regelt',
    'DRProcedure }o--|| Service : schützt',
    'DRProcedure }o--|| BackupPolicy : nutzt',
    'AccessPolicy }o--o| Service : regelt',
    'AccessPolicy }o--o| Node : regelt',
    'PatchSchedule }o--o| Node : regelt',
    'PatchSchedule }o--|| Change : erfordert',
    'CMDB ||--o{ ConfigurationItem : enthält',
    'CMDB ||--|| DependencyMap : speist',
    'DependencyMap ||--o{ Dependency : aggregiert',
    'KnowledgeBase ||--o{ Runbook : enthält',
    'KnowledgeBase ||--o{ Postmortem : enthält',
    'KnowledgeBase ||--o{ KnownError : enthält',
    '@enduml',
].join('\n');

const NO_ORTHO_ER = [
    '@startuml',
    'hide circle',
    'hide empty members',
    'Platform ||--o{ Node : hostet',
    'Service ||--o{ SLO : aggregiert',
    'Incident }o--|| Service : betrifft',
    '@enduml',
].join('\n');

const fence = (lang: string, src: string): string => '```' + lang + '\n' + src + '\n```';

let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
    server = await createServer({
        root: fixtureRoot,
        configFile: fixtureConfig,
        logLevel: 'error',
        server: { port: 5298, strictPort: true },
    });
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

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__plSetMarkdown?.(md), markdown);
}

async function waitForRenderedPlantuml(page: Page): Promise<void> {
    await page.waitForSelector(`${PL_HOST} svg`, { timeout: RENDER_BOUND_MS });
    await page.waitForFunction(
        (sel) => {
            const svg = document.querySelector(sel);
            return !!svg && svg.querySelectorAll('text').length > 0;
        },
        `${PL_HOST} svg`,
        { timeout: RENDER_BOUND_MS },
    );
}

/** For every edge-label <text> whose content is a known relationship token, the min distance (in SVG
 * user units) from the label centre to any edge <path>. Detached ortho labels drift far; re-attached
 * polyline labels sit on their lines. */
function measureEdgeLabelDistances(page: Page, tokens: string[], detachPx: number): Promise<{ count: number; maxDist: number; farCount: number }> {
    return page.evaluate(
        ({ hostSel, toks, thresholdPx }) => {
            const svg = document.querySelector<SVGSVGElement>(`${hostSel} svg`);
            if (!svg) return { count: 0, maxDist: -1, farCount: -1 };
            const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[];
            const nearestEdge = (cx: number, cy: number): number => {
                let best = Infinity;
                for (const p of paths) {
                    const len = p.getTotalLength();
                    if (len === 0 || len > 6000) continue;
                    for (let s = 0; s <= len; s += Math.max(4, len / 40)) {
                        const pt = p.getPointAtLength(s);
                        const d = Math.hypot(pt.x - cx, pt.y - cy);
                        if (d < best) best = d;
                    }
                }
                return best;
            };
            let count = 0;
            let maxDist = 0;
            let farCount = 0;
            for (const t of Array.from(svg.querySelectorAll('text'))) {
                const txt = (t.textContent ?? '').trim();
                if (!toks.includes(txt)) continue;
                const bb = (t as SVGGraphicsElement).getBBox();
                const d = nearestEdge(bb.x + bb.width / 2, bb.y + bb.height / 2);
                if (!Number.isFinite(d)) continue;
                count += 1;
                if (d > maxDist) maxDist = d;
                if (d > thresholdPx) farCount += 1;
            }
            return { count, maxDist: Math.round(maxDist), farCount };
        },
        { hostSel: PL_HOST, toks: tokens, thresholdPx: detachPx },
    );
}

test.describe('PlantUML ortho edge labels — real Chromium (openchamber-f9d.25.3)', () => {
    test('AC1: crow\'s-foot ER edge labels render adjacent to their lines (not detached)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', ORTHO_ER));
        await waitForRenderedPlantuml(page);

        const measured = await measureEdgeLabelDistances(page, EDGE_LABEL_TOKENS, DETACH_PX);

        // Enough edge labels were actually measured for the assertion to be meaningful.
        expect(measured.count, 'expected several German relation labels among rendered <text>').toBeGreaterThanOrEqual(15);
        // With the ortho->polyline rewrite EVERY relation label sits on its line (instrumented max
        // 32px). Reverting the fix feeds raw `ortho` to the engine -> 14 labels drift past DETACH_PX
        // (tail to 76px) -> this fails.
        expect(measured.farCount, `edge labels detached >${DETACH_PX}px from their line: ${measured.farCount}`).toBe(0);
        expect(measured.maxDist, `furthest edge label ${measured.maxDist}px from its line`).toBeLessThan(DETACH_PX);
    });

    test('AC2: copy/expand source still shows the ORIGINAL `linetype ortho` (render-copy-only)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', ORTHO_ER));
        await waitForRenderedPlantuml(page);

        const originalSource = await page.getAttribute(BLOCK, PLANTUML_SOURCE_ATTR);
        expect(originalSource, 'block is missing its copyable source attribute').toBeTruthy();
        // The copyable / expand-popup source is read from this attribute; it must keep the user's
        // ORIGINAL directive verbatim and never carry the render-only polyline rewrite.
        expect(originalSource).toContain('skinparam linetype ortho');
        expect(originalSource).not.toContain('linetype polyline');
    });

    test('AC4: a diagram WITHOUT `linetype ortho` renders unchanged (labels attached, no injection)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', NO_ORTHO_ER));
        await waitForRenderedPlantuml(page);

        const measured = await measureEdgeLabelDistances(page, EDGE_LABEL_TOKENS, DETACH_PX);
        expect(measured.count, 'expected relation labels in the no-ortho diagram').toBeGreaterThanOrEqual(2);
        expect(measured.farCount, 'no-ortho labels should already sit on their lines').toBe(0);

        const originalSource = await page.getAttribute(BLOCK, PLANTUML_SOURCE_ATTR);
        expect(originalSource).not.toContain('linetype');
    });
});
