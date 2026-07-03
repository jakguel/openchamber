import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

export default defineConfig({
    root: currentDir,
    plugins: [react()],
    resolve: { alias: { '@': uiSrc } },
    optimizeDeps: { exclude: ['@plantuml/core'] },
    server: { port: 5214, strictPort: true },
    preview: { port: 5215, strictPort: true },
});
