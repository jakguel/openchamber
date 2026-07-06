import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts the REAL exported ToolOutputDialog (which routes to
 * MermaidPreviewDialog for a `diagram` popup) — the actual public fullscreen-diagram dialog
 * path, including its top-right +/- zoom + close buttons and the real DiagramPanZoomViewport +
 * real SimpleMarkdownRenderer it wraps. Serves BOTH renderers: mermaid (beautiful-mermaid,
 * synchronous) and plantuml (@plantuml/core, ~8.6MB WASM kept a real dynamic import via
 * optimizeDeps.exclude, mirroring how the app ships it). jsdom is invalid for these diagrams
 * (getBBox/getBoundingClientRect are 0), so this runs under real Chromium. The `@` alias
 * resolves every `@/...` import to production source — NOTHING under src/ is mocked.
 *
 * Distinct ports (5299/5298) so it never collides with plantumlBoxLabelOverflow (5300) or
 * diagramFullscreenContainFit (5301/5302).
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5299, strictPort: true },
    preview: { port: 5298, strictPort: true },
});
