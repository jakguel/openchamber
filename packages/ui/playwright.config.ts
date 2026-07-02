/**
 * Playwright configuration for OpenChamber UI e2e tests.
 *
 * Run: npx playwright test --config packages/ui/playwright.config.ts
 *
 * Prerequisites:
 *   1. npx playwright install chromium
 *   2. bun run dev:web:full   (starts the web server on http://localhost:3000)
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.OPENCHAMBER_E2E_URL ?? 'http://localhost:3000';

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.e2e.ts',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    retries: 0,
    reporter: 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        headless: true,
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Keep requestAnimationFrame + timers running at full rate in headless.
                // Without this, a page with no continuous visual change gets its rAF and
                // setTimeout throttled to a few ticks/sec, which starves the per-frame
                // scroll sampler and the streaming paced-reveal timers in the mounted-fixture
                // e2e (streamingScrollPin.e2e.ts).
                launchOptions: {
                    args: [
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-features=CalculateNativeWinOcclusion',
                    ],
                },
            },
        },
    ],
});
