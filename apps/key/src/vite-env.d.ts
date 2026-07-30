/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EMBEDPDF_WASM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
