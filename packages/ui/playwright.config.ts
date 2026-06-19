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
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
