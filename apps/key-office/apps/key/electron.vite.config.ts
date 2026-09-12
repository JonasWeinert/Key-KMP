import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  main: { build: { externalizeDeps: false } },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    plugins: [react()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        "@key-reader": resolve(__dirname, "../../../key/src"),
        "@tauri-apps/api/core": resolve(
          __dirname,
          "src/renderer/tauri-shim.ts",
        ),
        "@tauri-apps/api/event": resolve(
          __dirname,
          "src/renderer/events-shim.ts",
        ),
      },
    },
    server: { port: 5199 },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          pdf: resolve(__dirname, "src/renderer/pdf.html"),
        },
      },
    },
  },
});
