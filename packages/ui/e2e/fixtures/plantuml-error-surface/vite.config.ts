import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// Harness importing the REAL production plantuml error-surfacing path (renderPlantuml ->
// extractPlantumlError wiring from T4, plus the real render queue + cache key). jsdom is invalid
// for @plantuml/core (getBBox returns 0) AND DOMParser is browser-only, so this MUST run in real
// Chromium. optimizeDeps.exclude keeps the ~8.6MB engine a real dynamic chunk (never prebundled),
// mirroring how the app ships it — NOTHING under src/ is mocked or replaced here.
export default defineConfig({
    root: currentDir,
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5190, strictPort: true },
    preview: { port: 5191, strictPort: true },
});
