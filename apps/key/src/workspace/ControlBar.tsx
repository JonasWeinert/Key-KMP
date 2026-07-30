/**
 * The window-level control bar host.
 *
 * It lives in the titlebar strip and owns two things only: the fixed window
 * icons (sidebar, split) that are present regardless of what is open, and the
 * layout budget. Everything else is whatever the command-active view projected
 * in its `ControlBarSnapshot`; the host never reaches into the view to ask what
 * a control means.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { MarkdownContent } from '../ui/MarkdownEditor';
import { IconButton } from '../ui/primitives';
import {
  solveControlBarLayout,
  controlLabel,
  type ControlBarDisplayMode,
  type ControlBarItem,
  type ControlBarSnapshot,
  type ControlIcon,
} from './control-bar';

/** Width the host keeps for its own fixed icons plus breathing room. */
const HOST_RESERVED_WIDTH = 96;
const ITEM_GAP = 3;
const ICONS: Record<ControlIcon, IconName> = {
  add: 'add',
  close: 'close',
  comments: 'comments',
  document: 'document',
  fitWidth: 'fit_width',
  minus: 'zoom_out',
  moon: 'more',
  next: 'next',
  previous: 'previous',
  search: 'search',
  settings: 'more',
  sidebar: 'sidebar',
  split: 'split',
  sun: 'check',
  book: 'book',
  highlight: 'highlight',
};

export interface ControlBarProps {
  snapshot: ControlBarSnapshot;
  /** Host-fixed icons, always present. */
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  splitActive: boolean;
  splitEnabled: boolean;
  onToggleSplit(): void;
  onOpenPdf(): void;
  showWorkspaceUtilities: boolean;
  leadingInset: number;
  /** View-owned interactions, routed back by control id. */
  onPress(control: string): void;
  onValueChanged(control: string, value: string): void;
  onSubmit(control: string, shift: boolean): void;
  onCancel(control: string): void;
  onActivateCard(cardId: string): void;
  onPreviousCard(): void;
  onNextCard(): void;
}

function useAvailableWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ControlBar({
  snapshot,
  sidebarOpen,
  onToggleSidebar,
  splitActive,
  splitEnabled,
  onToggleSplit,
  onOpenPdf,
  showWorkspaceUtilities,
  leadingInset,
  onPress,
  onValueChanged,
  onSubmit,
  onCancel,
  onActivateCard,
  onPreviousCard,
  onNextCard,
}: ControlBarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useAvailableWidth(rowRef);
  const available = Math.max(rowWidth - HOST_RESERVED_WIDTH, 120);
  const layout = solveControlBarLayout(snapshot.items, available, ITEM_GAP);

  const regions: Record<string, React.ReactNode[]> = {
    leading: [],
    center: [],
    trailing: [],
  };

  snapshot.items.forEach((item, index) => {
    const solved = layout[index];
    if (!item.state.visible || solved.width <= 0) return;
    regions[item.region].push(renderItem(item, solved.mode, solved.width));
  });

  function renderItem(
    item: ControlBarItem,
    mode: ControlBarDisplayMode,
    width: number,
  ): React.ReactNode {
    const label = controlLabel(item, mode);
    const icon = item.presentation.icon ? ICONS[item.presentation.icon] : undefined;
    const isFlexible = (item.presentation.width ?? 'intrinsic') === 'max';
    const style = isFlexible
      ? { flex: `1 1 ${width}px`, minWidth: 0 }
      : { flex: `0 0 ${width}px`, width: `${width}px` };

    let content: React.ReactNode;
    if (item.kind === 'textInput' && item.state.expanded) {
      content = (
        <div className="key-control-field expanded">
          <Icon name={icon ?? 'search'} />
          <input
            autoFocus
            value={item.state.value ?? ''}
            placeholder={item.presentation.label}
            aria-label={item.presentation.tooltip ?? item.presentation.label}
            onChange={event => onValueChanged(item.id, event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') onCancel(item.id);
              if (event.key === 'Enter') onSubmit(item.id, event.shiftKey);
            }}
          />
          {item.state.loading && <i className="key-control-spinner" aria-hidden="true" />}
          <button
            type="button"
            aria-label="Close search"
            onClick={() => onCancel(item.id)}
          >
            <Icon name="close" />
          </button>
        </div>
      );
    } else if (item.kind === 'display') {
      content = (
        <button
          type="button"
          className={`key-control-display ${isFlexible ? 'flexible' : ''}`}
          disabled={!item.state.enabled}
          title={item.presentation.tooltip}
          onClick={() => onPress(item.id)}
        >
          {isFlexible && icon && <Icon name={icon} />}
          <span>{label ?? item.presentation.label}</span>
        </button>
      );
    } else {
      content = (
        <button
          type="button"
          className={`key-icon-button key-control-button ${item.state.selected ? 'selected' : ''}`}
          disabled={!item.state.enabled}
          aria-pressed={item.state.selected}
          aria-label={item.presentation.tooltip ?? item.presentation.label}
          title={item.presentation.tooltip ?? item.presentation.label}
          onClick={() => onPress(item.id)}
        >
          {icon && <Icon name={icon} />}
          {label && <span>{label}</span>}
        </button>
      );
    }

    return (
      <div
        key={item.id}
        className={`key-control-item ${item.state.expanded ? 'expanded' : ''}`}
        style={style}
      >
        {content}
      </div>
    );
  }

  const auxiliary = snapshot.auxiliary;
  const [retainedAuxiliary, setRetainedAuxiliary] = useState(auxiliary);
  useEffect(() => {
    if (auxiliary) {
      setRetainedAuxiliary(auxiliary);
      return;
    }
    const timer = window.setTimeout(() => setRetainedAuxiliary(undefined), 320);
    return () => window.clearTimeout(timer);
  }, [auxiliary]);

  return (
    <div className="key-control-bar">
      <div
        className="key-control-row"
        ref={rowRef}
        data-tauri-drag-region
        style={{ paddingLeft: leadingInset }}
      >
        {showWorkspaceUtilities && (
          <div className="key-control-fixed">
            <IconButton
              icon="sidebar"
              label="Toggle open-documents sidebar"
              selected={sidebarOpen}
              onClick={onToggleSidebar}
            />
            <IconButton
              icon="split"
              label="Split view management"
              selected={splitActive}
              disabled={!splitEnabled}
              onClick={onToggleSplit}
            />
            <IconButton
              icon="add"
              label="Open another PDF"
              onClick={onOpenPdf}
            />
          </div>
        )}
        {regions.leading}
        {regions.center.length > 0 && (
          <div className="key-control-center">{regions.center}</div>
        )}
        <div className="key-control-trailing">
          {regions.trailing}
        </div>
      </div>

      {retainedAuxiliary && (
        <div
          className={`key-control-auxiliary-shell ${
            auxiliary ? 'expanded' : ''
          }`}
        >
        <div className="key-control-auxiliary" key={retainedAuxiliary.id}>
          <span className="key-control-auxiliary-label">{retainedAuxiliary.label}</span>
          <div className="key-control-cards">
            {retainedAuxiliary.cards.map(card => (
              <button
                type="button"
                key={card.id}
                className={`${card.selected ? 'selected' : ''} ${
                  card.detail ? 'has-detail' : ''
                } ${card.kind === 'comment' ? 'comment-card' : ''}`}
                style={
                  card.accentRgb
                    ? ({
                        '--annotation-color': card.accentRgb,
                      } as CSSProperties)
                    : undefined
                }
                onClick={() => onActivateCard(card.id)}
              >
                {card.kind === 'comment' ? (
                  <>
                    <span className="key-control-card-quote">{card.text}</span>
                    {card.detail && (
                      <MarkdownContent
                        className="key-control-card-detail"
                        markdown={card.detail}
                      />
                    )}
                    {card.footer && (
                      <small className="key-control-card-footer">{card.footer}</small>
                    )}
                  </>
                ) : (
                  <>
                    {card.eyebrow && <small>{card.eyebrow}</small>}
                    <span>{card.text}</span>
                    {card.detail && (
                      <small className="key-control-card-detail">{card.detail}</small>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
          <IconButton
            icon="previous"
            label="Previous item"
            disabled={retainedAuxiliary.cards.length === 0}
            onClick={onPreviousCard}
          />
          <IconButton
            icon="next"
            label="Next item"
            disabled={retainedAuxiliary.cards.length === 0}
            onClick={onNextCard}
          />
        </div>
        </div>
      )}
    </div>
  );
}
