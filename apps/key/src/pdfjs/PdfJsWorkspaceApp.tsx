import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/primitives';
import PdfJsBenchmarkApp, {
  type PdfJsPreview,
  type PdfJsViewState,
  type PdfReaderChromeState,
  type PdfReaderHandle,
  type PdfReaderPanel,
} from './PdfJsBenchmarkApp';
import {
  activateWorkspaceTab,
  activeWorkspaceTab,
  closeWorkspaceView,
  separateWorkspaceTab,
  setWorkspaceSplitRatio,
  singleWorkspaceTab,
  splitWithTab,
  swapWorkspaceSplit,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from './workspace-tabs';
import { ControlBar } from '../workspace/ControlBar';
import { useDesignSystem } from '../ui/DesignSystemProvider';
import { utilitiesInTabRow } from '../ui/design-system';
import { distributeTabWidths, readableTabWidth } from './tab-widths';
import {
  pdfControlBarSnapshot,
  type PdfControlMode,
  PDF_CONTROL_COMMENTS,
  PDF_CONTROL_FIT_WIDTH,
  PDF_CONTROL_OUTLINE,
  PDF_CONTROL_REFERENCES,
  PDF_CONTROL_SEARCH,
  PDF_CONTROL_ZOOM_IN,
  PDF_CONTROL_ZOOM_OUT,
  PDF_CONTROL_ZOOM_VALUE,
} from './pdf-control-bar';

interface OpenDocument {
  id: string;
  file: File;
}

const EMPTY_CHROME: PdfReaderChromeState = {
  ready: false,
  title: '',
  zoom: 1,
  pageCount: 0,
  status: 'Loading',
  searchQuery: '',
  searchCount: 0,
  activeSearchIndex: -1,
  searchResults: [],
  searching: false,
  activePanel: null,
  commentCount: 0,
  comments: [],
  activeCommentId: null,
  outlineCount: 0,
  referenceCount: 0,
};

function documentId(file: File) {
  return `${crypto.randomUUID()}:${file.name}:${file.size}:${file.lastModified}`;
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function useElementWidth(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) {
      setWidth(0);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [enabled, ref]);
  return width;
}

export default function PdfJsWorkspaceApp() {
  const designSystem = useDesignSystem();
  const chrome = designSystem.chrome;
  const workspaceUtilitiesInTabs = utilitiesInTabRow(chrome);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const readerRefs = useRef(new Map<string, PdfReaderHandle>());
  const viewStateRef = useRef(new Map<string, PdfJsViewState>());
  const previewRef = useRef(new Map<string, PdfJsPreview>());
  const chromeStateRef = useRef(new Map<string, PdfReaderChromeState>());
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceTabsState>({
    tabs: [],
    activeTabId: null,
  });
  const [recentViews, setRecentViews] = useState<string[]>([]);
  const [chromeRevision, setChromeRevision] = useState(0);
  const [appSidebarOpen, setAppSidebarOpen] = useState(false);
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const [controlMode, setControlMode] = useState<PdfControlMode>(null);

  const activeTab = useMemo(() => activeWorkspaceTab(workspace), [workspace]);
  const tabsVisible =
    chrome.show_single_tab || workspace.tabs.length > 1;
  const measuredTabStripWidth = useElementWidth(tabStripRef, tabsVisible);
  const activeViewId = activeTab?.activeViewId ?? null;
  const activeDocument = documents.find(document => document.id === activeViewId) ?? null;
  const chromeState = activeViewId
    ? chromeStateRef.current.get(activeViewId) ?? {
        ...EMPTY_CHROME,
        title: activeDocument?.file.name ?? '',
      }
    : EMPTY_CHROME;

  const touchRecent = useCallback((viewId: string) => {
    setRecentViews(current => [viewId, ...current.filter(id => id !== viewId)].slice(0, 8));
  }, []);

  const activateTab = useCallback(
    (tabId: string, viewId?: string) => {
      const target = workspace.tabs.find(tab => tab.id === tabId);
      const targetView = viewId ?? target?.activeViewId;
      setWorkspace(current => activateWorkspaceTab(current, tabId, viewId));
      if (targetView) touchRecent(targetView);
      setSplitMenuOpen(false);
    },
    [touchRecent, workspace.tabs],
  );

  const openFiles = useCallback((files: File[]) => {
    const pdfs = files.filter(
      file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    );
    if (!pdfs.length) return;
    const opened = pdfs.map(file => ({ id: documentId(file), file }));
    const openedTabs = opened.map(document => singleWorkspaceTab(document.id));
    setDocuments(current => [...current, ...opened]);
    setWorkspace(current => ({
      tabs: [...current.tabs, ...openedTabs],
      activeTabId: openedTabs[0]?.id ?? current.activeTabId,
    }));
    setRecentViews(current =>
      unique([opened[0]?.id, ...current]).slice(0, 8),
    );
  }, []);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    openFiles([...event.currentTarget.files ?? []]);
    event.currentTarget.value = '';
  };

  const closeView = (viewId: string) => {
    readerRefs.current.delete(viewId);
    chromeStateRef.current.delete(viewId);
    viewStateRef.current.delete(viewId);
    previewRef.current.delete(viewId);
    setDocuments(current => current.filter(document => document.id !== viewId));
    setWorkspace(current => closeWorkspaceView(current, viewId));
    setRecentViews(current => current.filter(id => id !== viewId));
  };

  const splitActiveWith = (targetTabId: string) => {
    if (!activeTab) return;
    setWorkspace(current => splitWithTab(current, activeTab.id, targetTabId));
    setSplitMenuOpen(false);
  };

  const separateActive = () => {
    if (!activeTab) return;
    setWorkspace(current => separateWorkspaceTab(current, activeTab.id));
    setSplitMenuOpen(false);
  };

  const swapActive = () => {
    if (!activeTab) return;
    setWorkspace(current => swapWorkspaceSplit(current, activeTab.id));
    setSplitMenuOpen(false);
  };

  const activeReader = activeViewId ? readerRefs.current.get(activeViewId) : undefined;
  const togglePanel = (panel: PdfReaderPanel) => {
    activeReader?.togglePanel(panel);
  };

  // Keep the active tab reachable once the strip overflows. Centring it is the
  // goal, but clamping to the scroll range means the first and last few tabs
  // simply sit at their end rather than leaving dead space — so the tab only
  // "approaches" the centre once the list is long enough for that to be true.
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip || !activeTab) return;
    const overflow = strip.scrollWidth - strip.clientWidth;
    if (overflow <= 0) return;
    const tab = strip.querySelector<HTMLElement>(`[data-tab-id="${activeTab.id}"]`);
    if (!tab) return;
    const centred = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
    strip.scrollTo({
      left: Math.max(0, Math.min(centred, overflow)),
      behavior: 'smooth',
    });
  }, [activeTab?.id, activeTab, workspace.tabs.length]);

  // The active view projects what it wants in the window chrome; the control
  // bar host decides how much of it fits. Nothing below routes by position.
  const controlBarSnapshot = pdfControlBarSnapshot(
    activeViewId ?? 'none',
    chromeState,
    controlMode,
    chromeRevision,
  );

  const onControlPress = (control: string) => {
    switch (control) {
      case PDF_CONTROL_ZOOM_OUT:
        return activeReader?.zoomOut();
      case PDF_CONTROL_ZOOM_IN:
        return activeReader?.zoomIn();
      case PDF_CONTROL_ZOOM_VALUE:
        return activeReader?.actualSize();
      case PDF_CONTROL_FIT_WIDTH:
        return activeReader?.fitWidth();
      case PDF_CONTROL_SEARCH:
        return setControlMode(current => current === 'search' ? null : 'search');
      case PDF_CONTROL_OUTLINE:
        return togglePanel('outline');
      case PDF_CONTROL_REFERENCES:
        return togglePanel('references');
      case PDF_CONTROL_COMMENTS:
        return setControlMode(current => current === 'comments' ? null : 'comments');
      default:
        return undefined;
    }
  };

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('app-menu-action', event => {
      switch (event.payload) {
        case 'workspace.open':
          inputRef.current?.click();
          break;
        case 'workspace.sidebar':
          setAppSidebarOpen(open => !open);
          break;
        case 'workspace.split':
          if (activeTab) setSplitMenuOpen(open => !open);
          break;
        case 'control.zoom-out':
          activeReader?.zoomOut();
          break;
        case 'control.actual-size':
          activeReader?.actualSize();
          break;
        case 'control.zoom-in':
          activeReader?.zoomIn();
          break;
        case 'control.fit-width':
          activeReader?.fitWidth();
          break;
        case 'control.search':
          setControlMode('search');
          break;
        case 'control.outline':
          activeReader?.togglePanel('outline');
          break;
        case 'control.references':
          activeReader?.togglePanel('references');
          break;
        case 'control.comments':
          setControlMode('comments');
          break;
      }
    }).then(dispose => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeReader, activeTab]);

  const visibleViewIds = activeTab?.viewIds ?? [];
  // Exactly two readers stay resident and keep their visible tiles: the two
  // panes of a split, or the active document plus the most recently used other
  // one. Everything beyond that unmounts and re-parses on demand.
  const RESIDENT_READERS = 2;
  const residentIds = unique([
    ...visibleViewIds,
    ...recentViews,
    ...workspace.tabs.flatMap(tab => tab.viewIds),
  ]).slice(0, RESIDENT_READERS);
  // Membership follows recency, but render order must not: re-ordering the
  // list would make React move live canvases around for no reason. Panes are
  // positioned by class, so a stable order costs nothing.
  const fullyWarmIds = [...residentIds].sort();
  const parsedWarmId = unique([
    ...recentViews,
    ...workspace.tabs.flatMap(tab => tab.viewIds),
  ]).find(id => !residentIds.includes(id));
  const tabLeadingInset = workspaceUtilitiesInTabs
    ? chrome.utility_controls_leading_inset
    : chrome.tab_leading_inset;
  const tabUtilityWidth = workspaceUtilitiesInTabs
    ? chrome.utility_cluster_width
    : 0;
  const availableTabWidth = Math.max(
    chrome.tab_width * chrome.tab_min_width_ratio,
    window.innerWidth -
      designSystem.components.popover.edge_margin * 2 -
      tabLeadingInset -
      chrome.tab_trailing_inset -
      tabUtilityWidth -
      (chrome.show_new_tab_button
        ? chrome.new_tab_button_size + designSystem.geometry.space_unit
        : 0),
  );
  const readableTabWidths = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d');
    const caption = designSystem.typography.caption;
    if (context) {
      context.font = `${caption.weight} ${caption.size_rem * 16}px system-ui`;
    }
    const measureText = (text: string) =>
      context?.measureText(text).width ?? text.length * caption.size_rem * 8;
    return new Map(
      workspace.tabs.map(tab => {
        const titles = tab.viewIds.map(
          viewId =>
            documents.find(document => document.id === viewId)?.file.name ??
            'Untitled PDF',
        );
        return [
          tab.id,
          readableTabWidth(
            titles,
            {
              minimumTitleCharacters: chrome.tab_min_title_characters,
              documentIconWidth: designSystem.components.common.icon_small,
              closeButtonWidth: chrome.tab_close_button_size,
              segmentGap: chrome.tab_segment_gap,
              horizontalPadding:
                tab.viewIds.length === 2
                  ? chrome.split_horizontal_padding
                  : chrome.tab_horizontal_padding,
              separatorWidth: designSystem.geometry.border_width,
            },
            measureText,
          ),
        ] as const;
      }),
    );
  }, [
    chrome,
    designSystem.components.common.icon_small,
    designSystem.geometry.border_width,
    designSystem.typography.caption,
    documents,
    workspace.tabs,
  ]);
  const tabsOverflow =
    [...readableTabWidths.values()].reduce((total, width) => total + width, 0) >
    (measuredTabStripWidth || availableTabWidth);
  const allocatedTabWidths = distributeTabWidths(
    workspace.tabs.map(tab => readableTabWidths.get(tab.id) ?? chrome.tab_width),
    measuredTabStripWidth || availableTabWidth,
  );
  const renderReader = (viewId: string, visible: boolean, paneIndex = 0) => {
    const document = documents.find(candidate => candidate.id === viewId);
    if (!document) return null;
    return (
      <PdfJsBenchmarkApp
        ref={handle => {
          if (handle) readerRefs.current.set(viewId, handle);
          else readerRefs.current.delete(viewId);
        }}
        initialFile={document.file}
        embedded
        paneTitle={paneIndex === 1 ? 'Right' : 'Left'}
        keyboardShortcuts={visible && activeViewId === viewId}
        rasterMode="active"
        visibilityMode={visible ? 'visible' : 'standby'}
        previewUrl={previewRef.current.get(viewId)?.dataUrl}
        initialViewState={viewStateRef.current.get(viewId)}
        initialControlState={{
          searchQuery: chromeStateRef.current.get(viewId)?.searchQuery ?? '',
        }}
        onRequestControlMode={setControlMode}
        onViewStateChange={state => viewStateRef.current.set(viewId, state)}
        onPreviewChange={preview => previewRef.current.set(viewId, preview)}
        onChromeStateChange={state => {
          const previous = chromeStateRef.current.get(viewId);
          chromeStateRef.current.set(viewId, state);
          if (
            viewId === activeViewId &&
            JSON.stringify(previous) !== JSON.stringify(state)
          ) {
            setChromeRevision(revision => revision + 1);
          }
        }}
      />
    );
  };

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeTab || activeTab.viewIds.length !== 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const tabId = activeTab.id;
    const onMove = (move: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      const ratio = (move.clientX - bounds.left) / bounds.width;
      setWorkspace(current => setWorkspaceSplitRatio(current, tabId, ratio));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    openFiles([...event.dataTransfer.files]);
  };

  void chromeRevision;

  return (
    <main
      className={`pdfjs-workspace ${appSidebarOpen ? 'app-sidebar-open' : ''}`}
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        className="pdfjs-workspace-file-input"
        type="file"
        accept="application/pdf"
        multiple
        onChange={onInput}
      />

      <header
        className="pdfjs-window-chrome"
        data-row-order={chrome.row_order}
        data-tauri-drag-region
      >
        {tabsVisible && (
          <div
            className="pdfjs-tab-row"
            data-placement={chrome.tab_bar_placement}
            data-overflow={tabsOverflow ? 'true' : 'false'}
            data-backdrop={designSystem.materials.control.backdrop}
            data-tauri-drag-region
            style={{
              height: chrome.tab_bar_height,
              paddingLeft: tabLeadingInset,
              paddingRight: chrome.tab_trailing_inset,
              marginInline: designSystem.components.popover.edge_margin,
              marginBlock: chrome.tab_popover_gap,
            }}
          >
            {workspaceUtilitiesInTabs && (
              <div
                className="pdfjs-tab-utilities"
                style={{ width: chrome.utility_cluster_width }}
              >
                <IconButton
                  icon="sidebar"
                  label="Toggle open-documents sidebar"
                  selected={appSidebarOpen}
                  onClick={() => setAppSidebarOpen(open => !open)}
                />
                <IconButton
                  icon="split"
                  label="Split view management"
                  selected={Boolean(activeTab && activeTab.viewIds.length === 2)}
                  disabled={!activeTab}
                  onClick={() => setSplitMenuOpen(open => !open)}
                />
              </div>
            )}
            <div
              className="pdfjs-workspace-tabs"
              ref={tabStripRef}
              role="tablist"
              aria-label="Open PDFs"
              style={{
                flex: '1 1 auto',
              }}
            >
              {workspace.tabs.map((tab, tabIndex) => {
                const isActive = tab.id === activeTab?.id;
                return (
                  <div
                    key={tab.id}
                    data-tab-id={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    className={`pdfjs-workspace-tab ${isActive ? 'active' : ''} ${
                      tab.viewIds.length === 2 ? 'split-group' : ''
                    }`}
                    style={{
                      minWidth: readableTabWidths.get(tab.id),
                      width: allocatedTabWidths[tabIndex],
                      flex: '0 0 auto',
                      paddingInline:
                        tab.viewIds.length === 2
                          ? chrome.split_horizontal_padding
                          : chrome.tab_horizontal_padding,
                    }}
                    onClick={() => activateTab(tab.id)}
                  >
                    {tab.viewIds.map((viewId, index) => {
                      const document = documents.find(candidate => candidate.id === viewId);
                      const focused = isActive && tab.activeViewId === viewId;
                      return (
                        <button
                          key={viewId}
                          type="button"
                          className={`pdfjs-tab-segment ${focused ? 'focused' : ''}`}
                          onClick={event => {
                            event.stopPropagation();
                            activateTab(tab.id, viewId);
                          }}
                          title={document?.file.name}
                        >
                          <span className="pdfjs-workspace-pdf"><Icon name="document" /></span>
                          <span>{document?.file.name ?? `PDF ${index + 1}`}</span>
                          <span
                            className="pdfjs-workspace-tab-close"
                            role="button"
                            aria-label={`Close ${document?.file.name ?? 'PDF'}`}
                            onClick={event => {
                              event.stopPropagation();
                              closeView(viewId);
                            }}
                          >
                            <Icon name="close" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {chrome.show_new_tab_button && (
              <IconButton
                className="pdfjs-workspace-add"
                icon="add"
                label="Open PDFs"
                style={{
                  width: chrome.new_tab_button_size,
                  minWidth: chrome.new_tab_button_size,
                  height: chrome.new_tab_button_size,
                }}
                onClick={() => inputRef.current?.click()}
              />
            )}
          </div>
        )}

        <ControlBar
          snapshot={controlBarSnapshot}
          sidebarOpen={appSidebarOpen}
          onToggleSidebar={() => setAppSidebarOpen(open => !open)}
          splitActive={Boolean(activeTab && activeTab.viewIds.length === 2)}
          splitEnabled={Boolean(activeTab)}
          onToggleSplit={() => setSplitMenuOpen(open => !open)}
          showWorkspaceUtilities={!workspaceUtilitiesInTabs}
          onOpenPdf={() => inputRef.current?.click()}
          leadingInset={
            workspaceUtilitiesInTabs
              ? chrome.control_leading_inset
              : chrome.utility_controls_leading_inset
          }
          onPress={onControlPress}
          onValueChanged={(_, value) => activeReader?.setSearchQuery(value)}
          onSubmit={(_, shift) =>
            shift ? activeReader?.previousSearchResult() : activeReader?.nextSearchResult()
          }
          onCancel={() => {
            activeReader?.closeSearch();
            setControlMode(null);
          }}
          onActivateCard={cardId => {
            if (controlMode === 'comments') {
              activeReader?.activateComment(cardId);
              return;
            }
            const index = chromeState.searchResults.findIndex(r => r.id === cardId);
            if (index >= 0) activeReader?.activateSearchResult(index);
          }}
          onPreviousCard={() => {
            if (controlMode !== 'comments') {
              activeReader?.previousSearchResult();
              return;
            }
            const current = chromeState.comments.findIndex(
              comment => comment.id === chromeState.activeCommentId,
            );
            const previous =
              chromeState.comments[
                (Math.max(0, current) - 1 + chromeState.comments.length) %
                  Math.max(1, chromeState.comments.length)
              ];
            if (previous) activeReader?.activateComment(previous.id);
          }}
          onNextCard={() => {
            if (controlMode !== 'comments') {
              activeReader?.nextSearchResult();
              return;
            }
            const current = chromeState.comments.findIndex(
              comment => comment.id === chromeState.activeCommentId,
            );
            const next =
              chromeState.comments[
                (current + 1) % Math.max(1, chromeState.comments.length)
              ];
            if (next) activeReader?.activateComment(next.id);
          }}
        />
      </header>

      {splitMenuOpen && activeTab && (
        <div className="pdfjs-split-menu">
          <strong>{activeTab.viewIds.length === 2 ? 'Split view' : 'Split with'}</strong>
          {activeTab.viewIds.length === 2 ? (
            <>
              <button type="button" onClick={swapActive}>Swap positions</button>
              <button type="button" onClick={separateActive}>Separate views</button>
              <button type="button" onClick={() => closeView(activeTab.viewIds[0]!)}>
                Close left view
              </button>
              <button type="button" onClick={() => closeView(activeTab.viewIds[1]!)}>
                Close right view
              </button>
            </>
          ) : (
            <>
              {workspace.tabs
                .filter(tab => tab.id !== activeTab.id && tab.viewIds.length === 1)
                .map(tab => {
                  const document = documents.find(candidate => candidate.id === tab.activeViewId);
                  return (
                    <button key={tab.id} type="button" onClick={() => splitActiveWith(tab.id)}>
                      <Icon name="document" />
                      <span>{document?.file.name ?? 'PDF'}</span>
                    </button>
                  );
                })}
              {!workspace.tabs.some(
                tab => tab.id !== activeTab.id && tab.viewIds.length === 1,
              ) && <small>Open another tab to create a split.</small>}
            </>
          )}
        </div>
      )}

      <div className="pdfjs-workspace-body">
        {appSidebarOpen && (
          <aside className="pdfjs-app-sidebar" aria-label="Open documents">
            <strong>Open documents</strong>
            {workspace.tabs.flatMap(tab =>
              tab.viewIds.map(viewId => {
                const document = documents.find(candidate => candidate.id === viewId);
                if (!document) return null;
                return (
                  <button
                    key={viewId}
                    type="button"
                    className={activeViewId === viewId ? 'active' : ''}
                    title={document.file.name}
                    onClick={() => activateTab(tab.id, viewId)}
                  >
                    <Icon name="document" />
                    <span>{document.file.name}</span>
                  </button>
                );
              }),
            )}
            {documents.length === 0 && <small>Nothing open yet.</small>}
          </aside>
        )}

        {activeTab ? (
          <div
            className={`pdfjs-workspace-panes ${
              activeTab.viewIds.length === 2 ? 'split' : ''
            }`}
          >
            {/* One keyed list for every resident reader, whether it is on
                screen or held warm. Splitting these across two JSX arrays made
                React unmount a reader the moment it was activated — destroying
                its controller and every cached tile — so no switch was ever
                warm. Placement is a class, not a change of parent. */}
            {fullyWarmIds.map(viewId => {
              const paneIndex = activeTab.viewIds.indexOf(viewId);
              const onScreen = paneIndex >= 0;
              const split = activeTab.viewIds.length === 2;
              return (
                <section
                  key={viewId}
                  data-document-id={viewId}
                  aria-hidden={onScreen ? undefined : 'true'}
                  className={`pdfjs-workspace-pane ${
                    !onScreen
                      ? 'standby'
                      : paneIndex === 0
                        ? 'primary'
                        : 'secondary'
                  } ${onScreen && activeTab.activeViewId === viewId ? 'focused' : ''}`}
                  style={
                    onScreen && split
                      ? paneIndex === 0
                        ? { width: `calc(${activeTab.splitRatio * 100}% - var(--key-split-gap) / 2)` }
                        : { left: `calc(${activeTab.splitRatio * 100}% + var(--key-split-gap) / 2)` }
                      : undefined
                  }
                  onPointerDown={
                    onScreen ? () => activateTab(activeTab.id, viewId) : undefined
                  }
                >
                  {renderReader(viewId, onScreen, Math.max(paneIndex, 0))}
                </section>
              );
            })}
            {activeTab.viewIds.length === 2 && (
              <div
                className="pdfjs-split-divider"
                style={{ left: `calc(${activeTab.splitRatio * 100}% - var(--key-split-gap) / 2)` }}
                onPointerDown={beginSplitResize}
              >
                <span />
              </div>
            )}
            {parsedWarmId && (
              <section
                data-document-id={parsedWarmId}
                data-tier="parsed"
                className="pdfjs-workspace-pane parsed"
                aria-hidden="true"
              />
            )}
          </div>
        ) : (
          <button
            type="button"
            className="pdfjs-workspace-empty"
            onClick={() => inputRef.current?.click()}
          >
            <span><Icon name="document" /></span>
            <strong>No document open</strong>
            <small>Choose a PDF, or drop one anywhere in this window.</small>
          </button>
        )}
      </div>
    </main>
  );
}
