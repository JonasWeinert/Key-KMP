import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const here = dirname(fileURLToPath(import.meta.url))

// Pin resolution to this repo's workspace sources (matches tsconfig paths;
// avoids bundling stale implementations when node_modules links point elsewhere)
const workspaceAlias = {
  // Subpath before the bare name: string aliases are prefix replacements
  '@key/pptx-engine/table-grid': resolve(
    here,
    '../../packages/pptx-engine/src/table-grid.ts',
  ),
  '@key/pptx-engine/identity': resolve(here, '../../packages/pptx-engine/src/identity.ts'),
  '@key/pptx-engine/custgeom': resolve(here, '../../packages/pptx-engine/src/custgeom.ts'),
  '@key/pptx-engine/background-promote': resolve(
    here,
    '../../packages/pptx-engine/src/background-promote.ts',
  ),
  '@key/pptx-engine': resolve(here, '../../packages/pptx-engine/src/index.ts'),
  '@key/pptx-render/preset-geometry': resolve(
    here,
    '../../packages/pptx-render/src/preset-geometry.ts',
  ),
  '@key/pptx-render': resolve(here, '../../packages/pptx-render/src/index.ts'),
  // Metafile (EMF/WMF) rasterizer shared with the docs engine (renderer-only: needs canvas)
  '@key/docx-engine/metafile': resolve(here, '../../packages/docx-engine/src/metafile.ts'),
}

export default defineConfig({
  // Main process/preload must bundle @key/* sources (they are pulled in as TS
  // source with extensionless relative imports; externalizing them under Node
  // yields ERR_MODULE_NOT_FOUND).
  main: {
    resolve: { alias: workspaceAlias },
    // Bundle opentype.js too (the packaged app ships only out/**, so external deps are unresolvable at runtime)
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@key/pptx-engine',
          '@key/pptx-render',
          '@key/ai-search',
          '@key/file-parse',
          '@key/electron-utils',
          'opentype.js',
        ],
      }),
    ],
  },
  preload: {
    // electron-utils ships raw TS source — must be bundled, not left external
    plugins: [externalizeDepsPlugin({ exclude: ['@key/electron-utils'] })],
  },
  renderer: {
    resolve: { alias: workspaceAlias },
    plugins: [react()],
    server: {
      port: Number(process.env.SLIDES_DEV_PORT) || 5175,
      strictPort: Boolean(process.env.SLIDES_DEV_PORT),
    },
  },
})
