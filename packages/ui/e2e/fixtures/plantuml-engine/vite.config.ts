import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// Harness importing the REAL production plantuml modules. jsdom is invalid for @plantuml/core
// (getBBox returns 0), so this runs in real Chromium. optimizeDeps.exclude keeps the ~8.6MB
// engine a real dynamic chunk instead of a prebundled dependency.
export default defineConfig({
    root: currentDir,
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5188, strictPort: true },
    preview: { port: 5189, strictPort: true },
});
