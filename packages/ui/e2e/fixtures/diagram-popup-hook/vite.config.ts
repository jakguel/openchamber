import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts a non-chat surface wired through the REAL extracted
 * useDiagramPopup() hook + the REAL SimpleMarkdownRenderer. It proves the fullscreen popup
 * opens for BOTH mermaid and plantuml on surfaces that are NOT chat (FilesView, PlanView,
 * SkillsPage, MobileFilesSurface all wire the hook identically).
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
    server: { port: 5210, strictPort: true },
    preview: { port: 5211, strictPort: true },
});
