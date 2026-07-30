import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { DesignSystemProvider } from './ui/DesignSystemProvider';
import {
  designSystemForProfile,
  visualProfileForRenderer,
} from './app-profile';

const requestedRenderer = new URLSearchParams(window.location.search).get('renderer');
const renderer =
  requestedRenderer ?? ('__TAURI_INTERNALS__' in window ? 'pdfjs' : null);
const visualProfile = visualProfileForRenderer(renderer);
const designSystem = designSystemForProfile(visualProfile);
const Root = React.lazy<React.ComponentType<any>>(async () => {
  if (renderer === 'hepr') return import('./hepr/HeprBenchmarkApp');
  if (renderer === 'pdfjs-multi-stress') {
    return import('./pdfjs/PdfJsMultiStressApp');
  }
  if (renderer === 'pdfjs-isolated-pane') {
    return import('./pdfjs/PdfJsIsolatedPaneApp');
  }
  if (renderer === 'pdfjs-isolated-stress') {
    return import('./pdfjs/PdfJsIsolatedStressApp');
  }
  if (renderer === 'pdfjs-workspace') {
    return import('./pdfjs/PdfJsWorkspaceApp');
  }
  if (renderer === 'pdfjs') {
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      const fixtures = await invoke<string[]>('benchmark_fixture_names');
      if (fixtures.length >= 10) {
        const workspaceMode = await invoke<boolean>('benchmark_workspace_mode');
        if (workspaceMode) {
          return import('./pdfjs/PdfJsWorkspaceApp');
        }
        return import('./pdfjs/PdfJsIsolatedStressApp');
      }
      const hasSingleFixture = await invoke<boolean>('benchmark_has_single_fixture');
      if (!hasSingleFixture) {
        return import('./pdfjs/PdfJsWorkspaceApp');
      }
    }
    return import('./pdfjs/PdfJsBenchmarkApp');
  }
  return import('./App');
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesignSystemProvider config={designSystem}>
      <Suspense fallback={<div className="boot-state">Loading renderer…</div>}>
        <Root />
      </Suspense>
    </DesignSystemProvider>
  </React.StrictMode>,
);
