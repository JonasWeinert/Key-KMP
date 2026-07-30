import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@napi-rs/canvas': fileURLToPath(
        new URL('./src/hepr/napi-canvas-browser.ts', import.meta.url),
      ),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/upstream-affine/**'],
    },
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    // HEPR 0.1.14 uses top-level await to choose the browser PDF.js build.
    // Modern Tauri WebViews support it, but the previous Safari 13 target does not.
    target: 'esnext',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
