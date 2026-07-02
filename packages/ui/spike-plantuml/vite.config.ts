import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Standalone Vite app for Task C0 (openchamber-f9d.16.1) — the BLOCKING PlantUML spike.
 *
 * This is a THROWAWAY proof harness, NOT production wiring. It exists only to prove the
 * three integration blockers in real Chromium under BOTH `vite dev` and `vite build`+preview:
 *   1. loader order: viz-global.js (UMD side-effect global `Viz`) MUST load before plantuml.js
 *   2. dark API: render({dark:true}) vs renderToString(..., {dark:true})
 *   3. the ~8.6MB engine lands in a SEPARATE dynamic chunk, never the baseline entry chunk
 *
 * It is intentionally isolated from the app's real Vite build (packages/web/vite.config.ts)
 * and touches none of the five shared Story-C production files.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: __dirname,
    // Keep the 7.15MB engine a REAL dynamic chunk: do not let esbuild prebundle/inline it.
    optimizeDeps: { exclude: ['@plantuml/core'] },
    build: {
        outDir: path.resolve(__dirname, 'dist'),
        emptyOutDir: true,
        // Emit a manifest so the e2e can PROVE the engine is a separate async chunk (AC4).
        manifest: true,
        chunkSizeWarningLimit: 20_000,
        rollupOptions: {
            input: { main: path.resolve(__dirname, 'index.html') },
        },
    },
    server: { port: 5178, strictPort: true },
    preview: { port: 5179, strictPort: true },
});
