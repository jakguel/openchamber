import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts the REAL production markdown pipeline (SimpleMarkdownRenderer
 * -> useDecorateContext -> decorate.ts decoratePlantuml -> createPlantumlQueue -> renderPlantuml
 * -> loadEngine). This is the INTEGRATION counterpart of the C0 engine harness
 * (../plantuml-engine): C0 called the engine directly; this drives the whole component path.
 *
 * jsdom is invalid for @plantuml/core (getBBox() returns 0), so the e2e runs this under real
 * Chromium via Playwright. optimizeDeps.exclude keeps the ~8.6MB engine a real dynamic import
 * (never prebundled/inlined into the baseline), mirroring how the app ships it.
 *
 * The `@` alias matches the app's tsconfig `paths` so every `@/...` import in the real modules
 * resolves to the production source — NOTHING under src/ is mocked or replaced.
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5198, strictPort: true },
    preview: { port: 5199, strictPort: true },
});
