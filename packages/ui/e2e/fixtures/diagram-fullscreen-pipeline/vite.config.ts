import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts the REAL fullscreen diagram render path — the exact composition
 * MermaidPreviewDialog uses (ToolOutputDialog.tsx): a real DiagramPanZoomViewport wrapping a real
 * SimpleMarkdownRenderer with the markdown-{mermaid,plantuml}-fullscreen class. Serves BOTH
 * renderers: mermaid (beautiful-mermaid, synchronous) and plantuml (@plantuml/core, ~8.6MB WASM
 * kept a real dynamic import via optimizeDeps.exclude, mirroring how the app ships it). jsdom is
 * invalid for @plantuml/core (getBBox returns 0), so this runs under real Chromium. The `@` alias
 * resolves every `@/...` import to production source — NOTHING under src/ is mocked.
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5301, strictPort: true },
    preview: { port: 5302, strictPort: true },
});
