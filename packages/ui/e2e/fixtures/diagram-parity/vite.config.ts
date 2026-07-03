import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts the REAL production markdown tree used by BOTH inline diagram
 * rendering AND the fullscreen popup: SimpleMarkdownRenderer (MarkdownRendererImpl) + the real
 * ToolOutputDialog, wired with the genuine ChatMessage onShowPopup state-setter pattern. It is
 * the parity counterpart of the plantuml-pipeline fixture (SimpleMarkdownRenderer only) — this
 * one ALSO renders ToolOutputDialog so the magnify -> popup -> pan/zoom path can be driven for
 * real, for both mermaid and plantuml.
 *
 * jsdom is invalid here (@plantuml/core + mermaid need a real layout engine; getBBox() returns
 * 0 in jsdom), so the e2e runs this under real Chromium via Playwright. optimizeDeps.exclude
 * keeps the ~8.6MB plantuml engine a real dynamic import (never prebundled/inlined), mirroring
 * how the app ships it.
 *
 * The `@` alias matches the app's tsconfig `paths` so every `@/...` import in the real modules
 * resolves to the production source — NOTHING under src/ is mocked or replaced.
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5200, strictPort: true },
    preview: { port: 5201, strictPort: true },
});
