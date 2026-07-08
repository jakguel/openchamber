import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

// Harness importing the REAL production plantuml error-surfacing path (renderPlantuml ->
// extractPlantumlError wiring from T4, plus the real render queue + cache key). jsdom is invalid
// for @plantuml/core (getBBox returns 0) AND DOMParser is browser-only, so this MUST run in real
// Chromium. optimizeDeps.exclude keeps the ~8.6MB engine a real dynamic chunk (never prebundled),
// mirroring how the app ships it — NOTHING under src/ is mocked or replaced here.
export default defineConfig({
    root: currentDir,
    // The `@` alias matches the app's tsconfig `paths` so every `@/...` import in the real modules
    // (e.g. renderPlantuml -> `@/lib/logDiagnostic`) resolves to the production source — NOTHING
    // under src/ is mocked or replaced.
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5190, strictPort: true },
    preview: { port: 5191, strictPort: true },
});
