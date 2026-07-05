import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

/**
 * Dev-server fixture for the Markdown ToC end-to-end proof (openchamber-5ki.37.17). Mounts the
 * REAL surfaces that own the ToC feature — the desktop FilesView (inline + fullscreen markdown
 * preview), the mobile MobileFilesSurface, and the raw chat MarkdownRenderer / preview
 * SimpleMarkdownRenderer render paths — selected by the `?surface=` query param. Nothing under
 * src/ is mocked; only the files IO boundary is injected via RuntimeAPIProvider, exactly as the
 * app wires it at startup.
 *
 * The `@` alias resolves every `@/...` import to the production source. jsdom is invalid for this
 * proof (getBBox()/scroll geometry return 0), so the e2e runs it under real Chromium. A distinct
 * port (5320/5321) keeps a serial full-suite run from colliding with sibling fixtures on
 * strictPort.
 */
export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    server: { port: 5320, strictPort: true },
    preview: { port: 5321, strictPort: true },
});
