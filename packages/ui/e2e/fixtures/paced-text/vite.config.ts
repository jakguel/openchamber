import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(currentDir, '..', '..', '..', 'src');

// Dev-server fixture that mounts the REAL chat MarkdownRenderer (the component
// that calls usePacedText) under real Vite + Chromium, where the hook's effect
// actually runs its 64ms paced-reveal timers. jsdom/bun cannot exercise this:
// packages/ui ships no DOM test renderer and the effect bails when
// `typeof window === 'undefined'`. The `@` alias resolves every `@/...` import
// to production source — NOTHING under src/ is mocked. optimizeDeps.exclude
// keeps @plantuml/core a real dynamic import, matching how the app ships it.
export default defineConfig({
  root: currentDir,
  plugins: [react()],
  resolve: { alias: { '@': uiSrc } },
  optimizeDeps: { exclude: ['@plantuml/core'] },
  server: { port: 5230, strictPort: true },
  preview: { port: 5231, strictPort: true },
});
