import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture that mounts the REAL FilesView view (markdown preview) to prove the
 * fullscreen diagram popup opens through FilesView's own onShowPopup wiring for BOTH mermaid and
 * plantuml. jsdom is invalid here (@plantuml/core + mermaid need a real layout engine), so the
 * e2e runs this under real Chromium. optimizeDeps.exclude keeps the ~8.6MB plantuml engine a real
 * dynamic import. The `@` alias resolves every `@/...` import to the production source — nothing
 * under src/ is mocked or replaced.
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5212, strictPort: true },
    preview: { port: 5213, strictPort: true },
});
