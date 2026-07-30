/**
 * Port of the GPUI control-bar slot model.
 *
 * The window owns the bar; it does not own its contents. Whichever view is
 * command-active projects a `ControlBarSnapshot` describing the controls it
 * wants, and the host solves how many of them actually fit. Views never
 * position anything and never learn the window width — they declare intent
 * (region, priority, three measured widths) and the solver decides.
 *
 * Mirrors `crates/key-workspace-core/src/control_bar.rs` and
 * `crates/key-ui-gpui/src/control_bar_layout.rs`.
 */

export type ControlBarRegion = 'leading' | 'center' | 'trailing';
export type ControlBarItemKind = 'display' | 'button' | 'textInput';
export type ControlBarWidth = 'intrinsic' | 'max';
export type ControlBarDisplayMode = 'full' | 'compact' | 'icon';

/** Semantic icon names. Deliberately not a toolkit's icon type. */
export type ControlIcon =
  | 'add'
  | 'close'
  | 'comments'
  | 'document'
  | 'fitWidth'
  | 'minus'
  | 'moon'
  | 'next'
  | 'previous'
  | 'search'
  | 'settings'
  | 'sidebar'
  | 'split'
  | 'sun'
  | 'book'
  | 'highlight';

export interface ControlBarPresentation {
  label: string;
  shortLabel?: string;
  icon?: ControlIcon;
  tooltip?: string;
  /** Measured widths for full, compact, and icon-only presentation. */
  widths: [number, number, number];
  /** Lower-priority items collapse before higher-priority items. */
  priority: number;
  /** Lets one view-owned control act as the bar's flexible location. */
  width?: ControlBarWidth;
  /** Keeps a button icon-only at every responsive width. */
  iconOnly?: boolean;
}

export interface ControlBarItemState {
  visible: boolean;
  enabled: boolean;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  value?: string;
}

export interface ControlBarItem {
  id: string;
  region: ControlBarRegion;
  kind: ControlBarItemKind;
  presentation: ControlBarPresentation;
  state: ControlBarItemState;
}

export interface ControlBarCard {
  id: string;
  eyebrow?: string;
  text: string;
  /** Supporting context shown below the primary snippet. */
  detail?: string;
  /** Specialized presentation without coupling the host to a PDF view. */
  kind?: 'default' | 'comment';
  /** Base annotation RGB triplet used to derive surfaces dynamically. */
  accentRgb?: string;
  /** Quiet trailing metadata, such as a page number. */
  footer?: string;
  /** [start, end) character range to emphasise within `text`. */
  emphasized?: [number, number];
  selected: boolean;
}

export interface ControlBarAuxiliary {
  id: string;
  label: string;
  loading: boolean;
  cards: ControlBarCard[];
}

/** Immutable projection of the command-active view into window chrome. */
export interface ControlBarSnapshot {
  owner: string;
  revision: number;
  items: ControlBarItem[];
  auxiliary?: ControlBarAuxiliary;
}

export type ControlBarInteraction =
  | { kind: 'pressed' }
  | { kind: 'valueChanged'; value: string }
  | { kind: 'submitted' }
  | { kind: 'cancelled' }
  | { kind: 'activatedCard' };

export interface ControlBarEvent {
  owner: string;
  control: string;
  interaction: ControlBarInteraction;
}

export interface ControlBarLayoutItem {
  mode: ControlBarDisplayMode;
  width: number;
}

export function defaultItemState(
  overrides: Partial<ControlBarItemState> = {},
): ControlBarItemState {
  return {
    visible: true,
    enabled: true,
    selected: false,
    expanded: false,
    loading: false,
    ...overrides,
  };
}

export function controlBarItem(
  id: string,
  region: ControlBarRegion,
  kind: ControlBarItemKind,
  presentation: ControlBarPresentation,
  state: Partial<ControlBarItemState> = {},
): ControlBarItem {
  return { id, region, kind, presentation, state: defaultItemState(state) };
}

const MODE_INDEX: Record<ControlBarDisplayMode, number> = {
  full: 0,
  compact: 1,
  icon: 2,
};

function nextMode(mode: ControlBarDisplayMode): ControlBarDisplayMode {
  return mode === 'full' ? 'compact' : 'icon';
}

function itemWidth(item: ControlBarItem, mode: ControlBarDisplayMode): number {
  if ((item.presentation.width ?? 'intrinsic') === 'max') return 0;
  const value = item.presentation.widths[MODE_INDEX[mode]];
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function measuredWidth(items: ControlBarItem[], modes: ControlBarDisplayMode[]): number {
  return items.reduce(
    (total, item, index) => (item.state.visible ? total + itemWidth(item, modes[index]) : total),
    0,
  );
}

/**
 * Selects the richest presentation that fits. Expanded inputs retain their
 * richest width while other controls collapse first, then step down through
 * their own compact widths only when the bar would otherwise overflow.
 */
export function solveControlBarLayout(
  items: ControlBarItem[],
  availableWidth: number,
  interItemGap: number,
): ControlBarLayoutItem[] {
  const visible = items.filter(item => item.state.visible).length;
  const gaps = Math.max(visible - 1, 0) * Math.max(interItemGap, 0);
  const budget = Math.max(Math.max(availableWidth, 0) - gaps, 0);

  const modes: ControlBarDisplayMode[] = items.map(item =>
    item.state.visible ? 'full' : 'icon',
  );
  let total = measuredWidth(items, modes);

  // Lower priority first; ties fall back to declaration order, matching the
  // Rust solver's sort over (priority, index).
  const candidates = items
    .map((item, index) => ({ priority: item.presentation.priority, index, item }))
    .filter(candidate => candidate.item.state.visible)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const collapse = (onlyExpandedInputs: boolean) => {
    while (total > budget) {
      let changed = false;
      for (const { index, item } of candidates) {
        const isExpandedInput = item.kind === 'textInput' && item.state.expanded;
        if (onlyExpandedInputs ? !isExpandedInput : isExpandedInput) continue;
        const current = modes[index];
        const next = nextMode(current);
        if (next === current) continue;
        total -= itemWidth(item, current) - itemWidth(item, next);
        modes[index] = next;
        changed = true;
        if (total <= budget) break;
      }
      if (!changed) break;
    }
  };

  collapse(false);
  // An expanded field gets priority, not an unlimited width guarantee. At a
  // narrow window it must still contract once everything else is icon-only.
  collapse(true);

  const remaining = Math.max(budget - measuredWidth(items, modes), 0);
  const maxItems = items.filter(
    item => item.state.visible && (item.presentation.width ?? 'intrinsic') === 'max',
  ).length;
  const maxWidth = maxItems === 0 ? 0 : remaining / maxItems;

  return items.map((item, index) => ({
    mode: modes[index],
    width: !item.state.visible
      ? 0
      : (item.presentation.width ?? 'intrinsic') === 'max'
        ? maxWidth
        : itemWidth(item, modes[index]),
  }));
}

/** The label a given display mode should render, or null for icon-only. */
export function controlLabel(
  item: ControlBarItem,
  mode: ControlBarDisplayMode,
): string | null {
  if (item.presentation.iconOnly && item.presentation.icon) return null;
  switch (mode) {
    case 'full':
      return item.presentation.label;
    case 'compact':
      return item.presentation.shortLabel ?? item.presentation.label;
    case 'icon':
      return item.presentation.icon ? null : item.presentation.label;
  }
}

/**
 * Keeps the horizontal result strip bounded while guaranteeing the active card
 * stays inside the rendered window.
 */
export function controlBarCardRange(
  total: number,
  active: number | null,
  maxCards: number,
): [number, number] {
  if (total <= maxCards) return [0, total];
  const half = Math.floor(maxCards / 2);
  const start = Math.min(Math.max((active ?? 0) - half, 0), total - maxCards);
  return [start, start + maxCards];
}
