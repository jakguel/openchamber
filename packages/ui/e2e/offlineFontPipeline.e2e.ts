/**
 * Playwright real-Chromium OFFLINE verification — Story openchamber-5ki.25 task .21 (Task D).
 *
 * Epic: openchamber-5ki   Story: openchamber-5ki.25   Task: openchamber-5ki.25.21
 *
 * Proves the WHOLE font pipeline built by tasks A/C1/C2/B is jsdelivr-free and offline-correct
 * against the REAL production build, with cdn.jsdelivr.net BLOCKED at the network layer and
 * same-origin allowed. NO internal src/ mocks anywhere — real built dist, real fonts, real
 * FontFace loads, real render geometry.
 *
 * Under proof:
 *   - Task A  : KaTeX math fonts bundled at build time (eager JS import in styles/fonts.ts);
 *               the built vendor CSS declares @font-face { KaTeX_* } src:url(/assets/KaTeX_*.woff2).
 *   - Task C1 : JetBrainsMono/FiraCode Nerd Font woff2 vendored + registered via the CSS Font
 *               Loading API in styles/fonts.ts; `.fonts-loaded` (re-)emitted on <html> after the
 *               PUA icon faces settle; jsdelivr removed from web/index.html.
 *   - Task C2 : 16-family @fontsource text catalog vendored; lib/fontLoader.ts resolves woff2 from
 *               a LOCAL import.meta.glob URL map and lazily FontFace.load()s the selected family.
 *   - Task B  : opt-in lazy Hack Nerd Font catalog mono (filePrefix `hack`, weights 400/700).
 *
 * WHY real Chromium (not jsdom): the ACs assert real FontFace load state (document.fonts.check
 * with a PUA sample glyph), real same-origin woff2 network requests, and measured glyph geometry.
 * jsdom has no font engine and no layout, so none of this is exercisable there.
 *
 * WHY the REAL built dist (not the dev server / a hand-rolled bundle): offline correctness is a
 * property of what SHIPS. Serving packages/web/dist means the real hashed woff2 assets, the real
 * eager Nerd-font registration chunk, and the real KaTeX @font-face all run exactly as in prod.
 *
 * Harness (single loopback origin, OS-assigned distinct port — never clashes with the config's
 * :3000 dev server):
 *   GET /                     -> the real built packages/web/dist/index.html (+ /assets/*).
 *                                Boots the real app; the eager styles/fonts chunk registers the
 *                                Nerd faces and the vendor CSS declares the KaTeX faces. (AC-D1)
 *   GET /e2e-fontloader.html  -> a minimal page that loads the REAL lib/fontLoader module (bundled
 *                                to an IIFE, its vendored woff2 emitted + served same-origin under
 *                                /e2e-fl/). Exercises the real lazy loadUiFont/loadMonoFont. (AC-D2)
 *   GET /e2e-fl/*             -> the fontLoader IIFE bundle.js + its emitted woff2 (same-origin).
 *   GET /api/*               -> benign {} stub so the booted app's startup pokes resolve.
 * cdn.jsdelivr.net is aborted at the network layer on every page; every request URL is recorded so
 * a single jsdelivr hit fails the offline assertions.
 *
 * The pure-node checks (AC-D3 scoped no-CDN grep, AC-D4 vscode base './' resolution, AC-D5 NOTICE)
 * live in the same spec so one playwright run is authoritative evidence for all five ACs.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright test \
 *     --config packages/ui/playwright.config.ts --project=chromium offlineFontPipeline --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..'); // packages/ui
const uiSrc = path.resolve(uiRoot, 'src');
const repoRoot = path.resolve(uiRoot, '../..');
const webDist = path.resolve(uiRoot, '../web/dist');
const vscodeWebviewDist = path.resolve(uiRoot, '../vscode/dist/webview');
const noticePath = path.resolve(uiSrc, 'assets/fonts/NOTICE.md');

const JETBRAINS_NERD_FAMILY = 'JetBrainsMono Nerd Font';
const PUA_SAMPLE = '\uE000'; // inside the declared Nerd unicode-range U+E000-F8FF
const CDN = 'cdn.jsdelivr.net';

// ---------------------------------------------------------------------------
// REAL lib/fontLoader IIFE bundle (AC-D2). Bundles the actual module so the test
// drives loadUiFont/loadMonoFont — NOT a reimplementation. The eager `?url` glob
// inside fontLoader emits the vendored woff2 as assets (base '/e2e-fl/'), which the
// harness serves same-origin; the per-family byte download still happens lazily in
// FontFace.load(), exactly as in production.
// ---------------------------------------------------------------------------
type BuiltAsset = { fileName: string; source: Buffer };
let fontLoaderBundleCode = '';
const fontLoaderAssets = new Map<string, Buffer>();

async function buildFontLoaderBundle(): Promise<void> {
    const virtualId = '\0fl-e2e-entry';
    const result = await build({
        root: uiRoot,
        base: '/e2e-fl/',
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            {
                name: 'fl-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'fl-e2e-entry' || id.endsWith('fl-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    // Expose the REAL loader functions on a window global for the harness page.
                    return "import { loadUiFont, loadMonoFont } from '@/lib/fontLoader';\n"
                        + 'window.__fontLoaderTest = { loadUiFont, loadMonoFont };';
                },
            },
        ],
        // NOT lib mode: Vite's library build force-inlines `?url`/glob assets as base64 data URIs,
        // which would make the woff2 load an in-document data: URL instead of a real same-origin
        // network fetch — defeating the offline proof. A plain IIFE build with assetsInlineLimit:0
        // emits the vendored woff2 as external same-origin assets (base '/e2e-fl/'), exactly as the
        // production app build does.
        build: {
            write: false,
            assetsInlineLimit: 0,
            cssCodeSplit: false,
            rollupOptions: {
                input: 'fl-e2e-entry',
                output: {
                    format: 'iife',
                    name: '__fontLoaderNamespace',
                    inlineDynamicImports: true,
                    entryFileNames: 'bundle.js',
                    assetFileNames: 'assets/[name]-[hash][extname]',
                },
            },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<
        { type: 'chunk'; code: string } | (BuiltAsset & { type: 'asset' })
    >;
    const chunk = outputs.find((o): o is { type: 'chunk'; code: string } => o.type === 'chunk' && typeof (o as { code?: string }).code === 'string');
    if (!chunk) throw new Error('fontLoader e2e bundle produced no JS chunk');
    fontLoaderBundleCode = chunk.code;
    for (const out of outputs) {
        if (out.type === 'asset') {
            const source = typeof out.source === 'string' ? Buffer.from(out.source) : Buffer.from(out.source);
            const base = out.fileName.split('/').pop() ?? out.fileName;
            fontLoaderAssets.set(base, source);
        }
    }
    if (fontLoaderAssets.size === 0) throw new Error('fontLoader e2e bundle emitted no woff2 assets');
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
};

const FONTLOADER_HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>fontLoader offline harness</title></head>
<body><div id="probe">catalog</div><script src="/e2e-fl/bundle.js"></script></body></html>`;

let server: http.Server | null = null;
let baseUrl = '';

function serveStatic(res: http.ServerResponse, filePath: string): boolean {
    // Prevent path traversal outside the dist root.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(webDist)) return false;
    if (!existsSync(resolved)) return false;
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(resolved));
    return true;
}

test.beforeAll(async () => {
    if (!existsSync(path.join(webDist, 'index.html'))) {
        throw new Error(`Built web dist not found at ${webDist}. Run \`bun run build\` first.`);
    }
    await buildFontLoaderBundle();

    server = http.createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0];

        if (url === '/e2e-fontloader.html') {
            res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'] });
            res.end(FONTLOADER_HARNESS_HTML);
            return;
        }
        if (url === '/e2e-fl/bundle.js') {
            res.writeHead(200, { 'content-type': CONTENT_TYPES['.js'] });
            res.end(fontLoaderBundleCode);
            return;
        }
        if (url.startsWith('/e2e-fl/')) {
            const base = url.split('/').pop() ?? '';
            const asset = fontLoaderAssets.get(base);
            if (asset) {
                res.writeHead(200, { 'content-type': 'font/woff2' });
                res.end(asset);
                return;
            }
            res.writeHead(404).end('not found');
            return;
        }
        if (url.startsWith('/api/')) {
            res.writeHead(200, { 'content-type': CONTENT_TYPES['.json'] });
            res.end('{}');
            return;
        }

        const filePath = url === '/' ? path.join(webDist, 'index.html') : path.join(webDist, url);
        if (serveStatic(res, filePath)) return;
        res.writeHead(404).end('not found');
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
    if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    }
});

/** Record every request URL and abort all cdn.jsdelivr.net + service-worker traffic. */
async function installNetworkGuards(page: Page): Promise<string[]> {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    // Block jsdelivr at the network layer (AC-D1/AC-D2 offline proof).
    await page.route(`**${CDN}**`, (route) => route.abort());
    // Block the PWA service worker so its cache can never mask a real network fetch.
    await page.route('**/sw.js', (route) => route.abort());
    return requests;
}

function jsdelivrHits(requests: string[]): string[] {
    return requests.filter((u) => u.includes(CDN));
}

// ===========================================================================
// AC-D1 — eager Nerd PUA icon glyph + KaTeX math render offline (jsdelivr blocked)
// ===========================================================================
test.describe('AC-D1 — eager fonts render offline against the real built dist', () => {
    test('Nerd PUA icon face + KaTeX math font both load same-origin with jsdelivr blocked', async ({ page }) => {
        const requests = await installNetworkGuards(page);

        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

        // The real registerNerdFonts() settles the PUA faces then re-emits the gate on <html>.
        await page.waitForFunction(() => document.documentElement.classList.contains('fonts-loaded'), null, {
            timeout: 20_000,
        });

        // Real FontFace state: the Nerd family resolves for a Private-Use-Area sample glyph.
        // (check() with a PUA glyph is the pipeline's own correctness signal — whitespace would
        // test U+0020, outside the range, and lie.)
        const nerdReady = await page.evaluate(
            ({ family, sample }) => document.fonts.check(`16px '${family}'`, sample),
            { family: JETBRAINS_NERD_FAMILY, sample: PUA_SAMPLE },
        );
        expect(nerdReady).toBe(true);

        // The exact FontFace the real pipeline registered — matched by the PUA unicode-range, so a
        // stray same-named system face cannot satisfy it. (A width probe is useless here: Nerd fonts
        // are monospaced, so a PUA glyph is one cell wide — identical to the monospace fallback's
        // .notdef cell — and would compare equal even when the icon face loaded.)
        const nerdFaceLoaded = await page.evaluate((family) => {
            let found = false;
            document.fonts.forEach((f) => {
                const fam = f.family.replace(/^["']|["']$/g, '');
                if (fam === family && typeof f.unicodeRange === 'string' && /E000/i.test(f.unicodeRange) && f.status === 'loaded') {
                    found = true;
                }
            });
            return found;
        }, JETBRAINS_NERD_FAMILY);
        expect(nerdFaceLoaded, 'the Nerd PUA FontFace must be registered by styles/fonts.ts AND loaded offline').toBe(true);

        // The vendored Nerd woff2 is genuinely present and fetchable same-origin while jsdelivr is
        // blocked — the offline asset exists regardless of whether an OS-installed local() copy won
        // the render on this machine.
        const nerdFile = readdirSync(path.join(webDist, 'assets')).find((f) => /^JetBrainsMonoNerdFont-Regular-[A-Za-z0-9_-]+\.woff2$/.test(f));
        expect(nerdFile, 'vendored JetBrainsMono Nerd woff2 must exist in the built dist').toBeTruthy();
        const nerdAsset = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return { ok: res.ok, ct: res.headers.get('content-type') };
        }, `${baseUrl}/assets/${nerdFile}`);
        expect(nerdAsset.ok).toBe(true);
        expect(nerdAsset.ct).toContain('woff2');

        // KaTeX (Task A): force-load a KaTeX face declared by the bundled vendor CSS. There is no
        // local() in the KaTeX @font-face, so this DEFINITELY triggers the same-origin woff2 fetch.
        // If Task A had not bundled the math fonts, this load would reject.
        const katexLoaded = await page.evaluate(async () => {
            const faces = await document.fonts.load("16px 'KaTeX_Main'");
            return { loadedCount: faces.length, check: document.fonts.check("16px 'KaTeX_Main'") };
        });
        expect(katexLoaded.loadedCount).toBeGreaterThan(0);
        expect(katexLoaded.check).toBe(true);

        // A real .katex box, styled by the bundled KaTeX CSS, occupies layout with the math font.
        const katexBox = await page.evaluate(() => {
            const host = document.createElement('div');
            host.innerHTML =
                '<span class="katex"><span class="katex-html"><span class="base">' +
                '<span class="mord mathnormal" style="font-family:\'KaTeX_Main\'">E=mc^2</span>' +
                '</span></span></span>';
            document.body.appendChild(host);
            const el = host.querySelector('.katex') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const result = { present: !!el, width: rect.width, height: rect.height };
            host.remove();
            return result;
        });
        expect(katexBox.present).toBe(true);
        expect(katexBox.width).toBeGreaterThan(0);
        expect(katexBox.height).toBeGreaterThan(0);

        // The KaTeX woff2 fetch went same-origin — and NOTHING touched jsdelivr.
        const katexReq = requests.find((u) => /\/assets\/KaTeX_Main-Regular-[A-Za-z0-9_-]+\.woff2/.test(u));
        expect(katexReq, 'KaTeX_Main woff2 must be fetched same-origin from the built dist').toBeTruthy();
        expect(katexReq!.startsWith(baseUrl)).toBe(true);
        expect(jsdelivrHits(requests)).toEqual([]);
    });
});

// ===========================================================================
// AC-D2 — lazy catalog text font (Inter) + Hack load same-origin via the REAL fontLoader
// ===========================================================================
test.describe('AC-D2 — lazy font selection loads same-origin offline', () => {
    test('loadUiFont(inter) + loadMonoFont(hack-nerd-font) fetch same-origin, zero jsdelivr', async ({ page }) => {
        const requests = await installNetworkGuards(page);

        await page.goto(`${baseUrl}/e2e-fontloader.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof (window as unknown as { __fontLoaderTest?: unknown }).__fontLoaderTest !== 'undefined', null, {
            timeout: 15_000,
        });

        // Drive the REAL loader (no reimplementation). Then assert a genuinely LOADED FontFace for
        // each family exists in the set. This is behavioral where document.fonts.check() is NOT:
        // fontLoader deletes the face on load failure, so check() would fall back to a system font
        // and lie 'true'; an actual status==='loaded' entry only survives a successful same-origin
        // fetch, so this assertion fails if the woff2 404s or is CDN-sourced (blocked).
        const loaded = await page.evaluate(async () => {
            const api = (window as unknown as {
                __fontLoaderTest: { loadUiFont: (f: string) => Promise<void>; loadMonoFont: (f: string) => Promise<void> };
            }).__fontLoaderTest;
            await api.loadUiFont('inter');
            await api.loadMonoFont('hack-nerd-font');
            const loadedFamily = (family: string): boolean => {
                let ok = false;
                document.fonts.forEach((f) => {
                    if (f.family.replace(/^["']|["']$/g, '') === family && f.status === 'loaded') ok = true;
                });
                return ok;
            };
            return {
                inter: loadedFamily('Inter'),
                hack: loadedFamily('Hack Nerd Font'),
                hackPua: document.fonts.check("16px 'Hack Nerd Font'", '\uE000'),
            };
        });

        expect(loaded.inter, 'catalog text font Inter must be a LOADED face after loadUiFont').toBe(true);
        expect(loaded.hack, 'Hack Nerd Font must be a LOADED face after loadMonoFont').toBe(true);
        // Hack is a Nerd-patched font: its PUA icon range must resolve too.
        expect(loaded.hackPua, 'Hack Nerd Font PUA icon glyph must resolve').toBe(true);

        // Both families fetched their woff2 same-origin from /e2e-fl/, never from jsdelivr.
        const interReq = requests.find((u) => /inter-latin-\d+-normal[^/]*\.woff2/.test(u));
        const hackReq = requests.find((u) => /hack-latin-\d+-normal[^/]*\.woff2/.test(u));
        expect(interReq, 'Inter woff2 must be fetched').toBeTruthy();
        expect(hackReq, 'Hack woff2 must be fetched').toBeTruthy();
        expect(interReq!.startsWith(`${baseUrl}/e2e-fl/`)).toBe(true);
        expect(hackReq!.startsWith(`${baseUrl}/e2e-fl/`)).toBe(true);
        expect(jsdelivrHits(requests)).toEqual([]);
    });
});

// ===========================================================================
// AC-D3 — SCOPED no-CDN proof (source + built dist font surface only)
// ===========================================================================
test.describe('AC-D3 — font pipeline is jsdelivr-free (scoped)', () => {
    test('(a) fontLoader.ts + web/index.html contain no runtime jsdelivr font URL', () => {
        // grep -n exits non-zero when there are no matches; that is the passing case here.
        for (const rel of ['packages/ui/src/lib/fontLoader.ts', 'packages/web/index.html']) {
            let matches = '';
            try {
                matches = execFileSync('grep', ['-n', CDN, path.join(repoRoot, rel)], { encoding: 'utf-8' });
            } catch (err) {
                const e = err as { status?: number; stdout?: string };
                if (e.status === 1) matches = ''; // no matches => clean
                else throw err;
            }
            expect(matches.trim(), `${rel} must have no jsdelivr reference`).toBe('');
        }
    });

    test('(b) no built font asset or font-loading chunk references jsdelivr (STT/transformers excluded)', () => {
        // Enumerate every web-dist file that mentions jsdelivr, then assert the set is confined to
        // the pre-existing NON-FONT third-party chunks the AC explicitly excludes. This is the
        // scoped test — NOT a blunt whole-dist grep that would false-positive on those chunks.
        const assetsDir = path.join(webDist, 'assets');
        let hitList = '';
        try {
            hitList = execFileSync('grep', ['-rl', CDN, assetsDir], { encoding: 'utf-8' });
        } catch (err) {
            const e = err as { status?: number };
            if (e.status !== 1) throw err; // status 1 = no matches at all (also acceptable)
        }
        const hitFiles = hitList.split('\n').map((l) => l.trim()).filter(Boolean).map((f) => path.basename(f));

        // Only these non-font chunks may reference jsdelivr (@xenova/transformers model-CDN fallback
        // + DOMPurify/sanitizer host allow-list). A font chunk here would be a real regression.
        const allowedExclusion = /^(vendor-\.bun-[A-Za-z0-9_-]+\.js|wasmSttWorker-[A-Za-z0-9_-]+\.js)$/;
        const disallowed = hitFiles.filter((f) => !allowedExclusion.test(f));
        expect(disallowed, `unexpected jsdelivr reference(s) in built dist: ${disallowed.join(', ')}`).toEqual([]);

        // And explicitly: no woff2 and no font-loading chunk (fonts-*.js / *.css) is in the hit set.
        const fontSurfaceHits = hitFiles.filter((f) => /\.woff2$/.test(f) || /^fonts-[A-Za-z0-9_-]+\.(js|css)$/.test(f) || /\.css$/.test(f));
        expect(fontSurfaceHits, `font asset/chunk referencing jsdelivr: ${fontSurfaceHits.join(', ')}`).toEqual([]);
    });
});

// ===========================================================================
// AC-D4 — vscode webview base './' font URLs are un-hashed and resolve
// ===========================================================================
test.describe('AC-D4 — vscode webview font URL parity', () => {
    test('vscode KaTeX @font-face uses base ./ and the referenced woff2 exists in the webview assets', () => {
        const assetsDir = path.join(vscodeWebviewDist, 'assets');
        expect(existsSync(assetsDir), `vscode webview assets not found at ${assetsDir}; run \`bun run vscode:build\``).toBe(true);

        // Find the built vscode CSS carrying the KaTeX @font-face.
        const cssFiles = execFileSync('grep', ['-rl', 'font-family:KaTeX_Main', assetsDir], { encoding: 'utf-8' })
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        expect(cssFiles.length, 'vscode CSS with KaTeX @font-face').toBeGreaterThan(0);

        const css = readFileSync(cssFiles[0], 'utf-8');
        // Un-hashed, base './'-relative url (the vscode webview loads assets relative to the doc).
        const match = css.match(/url\(\.\/(KaTeX_Main-Regular[A-Za-z0-9_.-]*\.woff2)\)/);
        expect(match, 'vscode KaTeX_Main @font-face must use a base ./ relative url').toBeTruthy();
        const referenced = match![1];
        // The './'-relative URL resolves to a real file sitting next to the CSS in assets/.
        expect(existsSync(path.join(assetsDir, referenced)), `${referenced} must exist in the webview assets dir`).toBe(true);

        // The Nerd + Hack woff2 are likewise vendored un-hashed in the webview.
        for (const f of ['JetBrainsMonoNerdFont-Regular.woff2', 'hack-latin-400-normal.woff2']) {
            expect(existsSync(path.join(assetsDir, f)), `${f} must exist in the webview assets dir`).toBe(true);
        }
    });
});

// ===========================================================================
// AC-D5 — one shared font NOTICE/provenance manifest present
// ===========================================================================
test.describe('AC-D5 — shared font provenance manifest', () => {
    test('NOTICE.md exists and documents the vendored Nerd, @fontsource catalog, and Hack fonts', () => {
        expect(existsSync(noticePath), `NOTICE.md must exist at ${noticePath}`).toBe(true);
        const notice = readFileSync(noticePath, 'utf-8');
        expect(notice).toContain('JetBrainsMono Nerd Font');
        expect(notice).toContain('FiraCode Nerd Font');
        expect(notice).toContain('@fontsource');
        expect(notice).toContain('Hack Nerd Font');
        expect(notice).toContain('SIL Open Font License');
    });
});
