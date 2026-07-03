/**
 * Real-Chromium regression proof — task openchamber-5ki.35.1.
 *
 * Guards the FilesView unsaved-changes contract against a spurious `isDirty`:
 * opening/selecting a freshly-loaded, unedited text file must never pop the
 * confirm-discard dialog, while a genuine edit still does. This mounts the REAL
 * FilesView ('full' mode) + CodeMirror; only the IO boundary is mocked, so the
 * production load path, line-ending normalization, dirty comparison, and
 * handleSelectFile guard are all exercised.
 *
 * WHY real Chromium (not jsdom): the dirty state depends on the CodeMirror
 * document model, which needs a real layout/DOM engine; jsdom cannot run it.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium filesViewDirtyState --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'filesview-dirty');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

const LF_NO_NEWLINE = '/workspace/lf-no-newline.txt';
const CRLF_TRAILING_NEWLINE = '/workspace/crlf-trailing-newline.txt';
const SWITCH_TARGET = '/workspace/switch-target.txt';

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

async function mount(page: Page, file: string, second: string): Promise<void> {
    const query = `file=${encodeURIComponent(file)}&second=${encodeURIComponent(second)}`;
    await page.goto(`${baseUrl}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__filesViewReady === true, { timeout: 30_000 });
    // The active file tab renders once the file has loaded into the editor.
    await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20_000 });
    await page.waitForTimeout(500);
}

function dialogVisible(page: Page): Promise<number> {
    return page.locator('[role="dialog"]').count();
}

async function clickTab(page: Page, name: string): Promise<void> {
    await page.locator('button', { hasText: name }).first().click();
}

async function editEditor(page: Page): Promise<void> {
    await page.locator('.cm-content').first().click();
    await page.keyboard.type('X');
}

test.describe('Task 5ki.35.1 — FilesView spurious unsaved-changes dialog (real Chromium)', () => {
    test('AC1/AC4: switching away from a freshly-loaded LF (no trailing newline) file opens no dialog', async ({ page }) => {
        await mount(page, LF_NO_NEWLINE, SWITCH_TARGET);
        expect(await dialogVisible(page)).toBe(0);

        await clickTab(page, 'switch-target.txt');
        await page.waitForTimeout(800);

        expect(await dialogVisible(page)).toBe(0);
        await expect(page.locator('.cm-content').first()).toContainText('target one');
    });

    test('AC4: switching away from a freshly-loaded CRLF (trailing newline) file opens no dialog', async ({ page }) => {
        await mount(page, CRLF_TRAILING_NEWLINE, SWITCH_TARGET);
        expect(await dialogVisible(page)).toBe(0);

        await clickTab(page, 'switch-target.txt');
        await page.waitForTimeout(800);

        expect(await dialogVisible(page)).toBe(0);
    });

    test('AC3: an idle 2s external-change poll (no disk change) does not open the dialog', async ({ page }) => {
        await mount(page, LF_NO_NEWLINE, SWITCH_TARGET);

        // Let the 2s poll tick a couple of times with nothing changing on disk.
        await page.waitForTimeout(4500);
        expect(await dialogVisible(page)).toBe(0);

        // A subsequent switch of the still-unedited file must also stay silent.
        await clickTab(page, 'switch-target.txt');
        await page.waitForTimeout(800);
        expect(await dialogVisible(page)).toBe(0);
    });

    test('AC2: a genuine edit still marks the file dirty and guards the tab switch with the dialog', async ({ page }) => {
        await mount(page, LF_NO_NEWLINE, SWITCH_TARGET);
        expect(await dialogVisible(page)).toBe(0);

        await editEditor(page);
        await page.waitForTimeout(300);

        await clickTab(page, 'switch-target.txt');
        await page.waitForTimeout(500);

        expect(await dialogVisible(page)).toBeGreaterThan(0);
        await expect(page.locator('[role="dialog"]')).toContainText('Unsaved changes');
    });
});
